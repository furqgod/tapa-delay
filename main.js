// ===== Tapa Delay — Electron Main Process =====
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { StreamDelayServer } = require('./server');
const { OverlayServer } = require('./overlay-server');
const { signUp, signIn, signOut, checkAccess, redeemCode } = require('./auth');

// ─── Cofre de segredos (safeStorage) ─────────────────────────────────────────
// Stream keys davam pra transmitir na conta do usuário e ficavam em texto puro no
// localStorage (lido por qualquer malware/pessoa com acesso ao PC). Aqui elas são
// cifradas com a keychain do SO (safeStorage) e gravadas num arquivo separado. O
// renderer nunca persiste o segredo em claro — só um flag "KeyPresent" pro UI.
function securePath() { return path.join(app.getPath('userData'), 'secure-keys.json'); }
function readSecureStore() {
    try { return JSON.parse(fs.readFileSync(securePath(), 'utf8')); } catch { return {}; }
}
function writeSecureStore(obj) {
    try { fs.writeFileSync(securePath(), JSON.stringify(obj), 'utf8'); } catch {}
}
ipcMain.handle('secure:set', (_, key, value) => {
    if (typeof key !== 'string') return { success: false };
    const store = readSecureStore();
    const val = String(value ?? '');
    if (!val) { delete store[key]; writeSecureStore(store); return { success: true }; }
    // 'enc:' = cifrado pela keychain; 'plain:' = fallback (SO sem keychain disponível,
    // raro em Windows/macOS) — ainda melhor que localStorage, mas marcado como tal.
    store[key] = safeStorage.isEncryptionAvailable()
        ? 'enc:' + safeStorage.encryptString(val).toString('base64')
        : 'plain:' + val;
    writeSecureStore(store);
    return { success: true };
});
ipcMain.handle('secure:get', (_, key) => {
    if (typeof key !== 'string') return null;
    const v = readSecureStore()[key];
    if (typeof v !== 'string') return null;
    if (v.startsWith('plain:')) return v.slice(6);
    if (v.startsWith('enc:')) {
        try { return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); } catch { return null; }
    }
    return null;
});

// ─── Auto-Update ─────────────────────────────────────────────────────────────
autoUpdater.allowPrerelease      = true;
autoUpdater.autoDownload         = false; // usuário decide quando baixar
autoUpdater.autoInstallOnAppQuit = false; // só instala quando clicar no botão

let mainWindow    = null;
let loginWindow   = null;
let tray          = null;
let server        = null;
let overlayServer = null;

// Sem isso, qualquer erro não tratado no processo principal (durante uma live de
// horas) fecha o app inteiro em silêncio e derruba as 3 plataformas juntas. Loga
// e deixa o processo vivo — o pior cenário vira "algo travou, veja o log" em vez
// de "a live morreu sem aviso".
process.on('uncaughtException', (e) => server?._writeLog(`💥 Erro não tratado: ${e.stack}`));
process.on('unhandledRejection', (e) => server?._writeLog(`💥 Promise rejeitada: ${e}`));

app.setName('Tapa Delay');

// ─── Single Instance Lock ────────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit(); // segunda instância: fecha sem iniciar nada
} else {
    app.on('second-instance', () => {
        // Usuário tentou abrir de novo — mostra a janela existente
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        } else if (loginWindow) {
            loginWindow.show();
            loginWindow.focus();
        }
    });

    // ─── App Ready (só roda na instância principal) ──────────────────────────
    app.whenReady().then(async () => {
        // Servidor RTMP inicia UMA VEZ e nunca para (evita EADDRINUSE ao trocar de conta)
        server = new StreamDelayServer();
        server.start();
        server.setLogPath(path.join(app.getPath('userData'), 'tapa-delay.log'));
        server.setStreamingBlocked(true); // bloqueado até auth ser confirmado

        overlayServer = new OverlayServer();
        overlayServer.start(3000);

        const access = await checkAccess();
        const isLoggedIn = access.reason !== 'not_logged_in' && access.reason !== 'error';
        if (isLoggedIn) {
            startApp(access);
        } else {
            createLoginWindow();
        }
        app.on('activate', () => mainWindow?.show());
    });
}

// ─── Janela de Login ────────────────────────────────────────────────────────

function createLoginWindow() {
    if (loginWindow) return;
    loginWindow = new BrowserWindow({
        width: 600,
        height: 400,
        resizable: false,
        frame: false,
        backgroundColor: '#0a0a0c',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'login-preload.js')
        },
        icon: path.join(__dirname, 'assets', 'icon.png')
    });
    loginWindow.loadFile('login.html');

    loginWindow.on('closed', () => {
        loginWindow = null;
        // Se fechar sem logar (sem transição), encerra o app
        if (!mainWindow && !app.isLoginTransition) app.quit();
    });
}

// ─── App Principal ──────────────────────────────────────────────────────────

function attachServerEvents() {
    server.on('status', (data) => {
        if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.webContents.send('status-update', data);
    });
    server.on('stats', (data) => {
        if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.webContents.send('stats-update', data);
    });
    server.on('delayActivated', () => overlayServer?.broadcastDelayActivated());
}

function startApp(accessInfo) {
    createMainWindow(accessInfo);
    createTray();
    // Servidor já está rodando — só configura acesso e reconecta eventos
    server.setStreamingBlocked(!accessInfo.hasAccess);
    attachServerEvents();
}

function createMainWindow(accessInfo) {
    mainWindow = new BrowserWindow({
        width: 960,
        height: 640,
        minWidth: 480,
        minHeight: 288,
        frame: false,
        backgroundColor: '#0a0a0c',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'assets', 'icon.png')
    });

    mainWindow.loadFile('index.html');

    // Envia info de acesso (trial/assinatura) para o renderer
    mainWindow.webContents.once('did-finish-load', () => {
        if (accessInfo) mainWindow.webContents.send('auth-info', accessInfo);
    });

    mainWindow.on('close', (e) => {
        if (!app.isQuiting) { e.preventDefault(); mainWindow.hide(); }
    });
    mainWindow.on('closed', () => { mainWindow = null; });

    // Verifica updates após a janela carregar
    mainWindow.webContents.once('did-finish-load', () => {
        autoUpdater.checkForUpdates().catch(() => {});
    });

    autoUpdater.on('update-available', (info) => {
        mainWindow?.webContents.send('update-available', info);
    });
    autoUpdater.on('update-downloaded', (info) => {
        mainWindow?.webContents.send('update-downloaded', info);
    });
}

// ─── Tray ────────────────────────────────────────────────────────────────────

function createTrayIcon() {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    try {
        const img = nativeImage.createFromPath(iconPath);
        if (!img.isEmpty()) return img;
    } catch {}
    // Fallback: quadrado azul 16x16
    const size = 16;
    const rgba = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
        rgba[i*4]=99; rgba[i*4+1]=102; rgba[i*4+2]=241; rgba[i*4+3]=255;
    }
    return nativeImage.createFromBuffer(rgba, { width: size, height: size });
}

function createTray() {
    try { tray = new Tray(createTrayIcon()); } catch (e) { return; }

    const contextMenu = Menu.buildFromTemplate([
        { label: 'Abrir Tapa Delay', click: () => mainWindow?.show() },
        { type: 'separator' },
        { label: 'Sair', click: () => { app.isQuiting = true; app.quit(); } },
    ]);
    tray.setToolTip('Tapa Delay');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
        if (mainWindow?.isVisible()) mainWindow.hide();
        else { mainWindow?.show(); mainWindow?.focus(); }
    });
}

// ─── App Ready ───────────────────────────────────────────────────────────────

// ─── IPC — Auth ──────────────────────────────────────────────────────────────

// SEGURANÇA: shell.openExternal abre QUALQUER esquema de URL (file://, smb://,
// protocolos customizados perigosos). Se o renderer for comprometido (XSS), isso
// vira um vetor. Só deixamos passar http/https.
function safeOpenExternal(url) {
    try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
            shell.openExternal(url);
            return { success: true };
        }
    } catch {}
    return { success: false };
}

ipcMain.handle('auth:login',        async (_, { email, password }) => signIn(email, password));
ipcMain.handle('auth:signup',       async (_, { email, password, name }) => signUp(email, password, name));
ipcMain.handle('auth:logout',       async () => { await signOut(); return { success: true }; });
ipcMain.handle('auth:check-access',  async () => checkAccess());
ipcMain.handle('auth:redeem-code',   async (_, { userId, code }) => redeemCode(userId, code));
ipcMain.handle('auth:open-external',async (_, url) => safeOpenExternal(url));

// Login bem-sucedido: fecha login, abre app principal
ipcMain.on('auth:login-success', (_, accessInfo) => {
    app.isLoginTransition = true;
    loginWindow?.close();
    loginWindow = null;
    app.isLoginTransition = false;
    startApp(accessInfo);
});

// Fechar janela de login = sair do app
ipcMain.on('auth:close-login', () => app.quit());

// Logout de dentro do app principal
ipcMain.handle('app:logout', async () => {
    await signOut();
    app.isQuiting = true;
    // Não para o servidor RTMP — só bloqueia streaming e desanexa eventos
    server?.removeAllListeners();
    server?.setStreamingBlocked(true);
    mainWindow?.destroy();
    mainWindow = null;
    tray?.destroy();
    tray = null;
    app.isQuiting = false;
    createLoginWindow();
    return { success: true };
});

// Info de acesso (trial) para o renderer do app principal
ipcMain.handle('app:get-access-info',  async () => checkAccess());
ipcMain.handle('app:open-external',   async (_, url) => safeOpenExternal(url));
ipcMain.handle('app:open-log',        async () => { await shell.openPath(path.join(app.getPath('userData'), 'tapa-delay.log')); return { success: true }; });
ipcMain.handle('app:version',         () => app.getVersion());

// ─── IPC — Janela Principal ──────────────────────────────────────────────────

ipcMain.on('update-download', () => autoUpdater.downloadUpdate().catch(() => {}));
ipcMain.on('update-install',  () => { app.isQuiting = true; autoUpdater.quitAndInstall(); });

ipcMain.on('window-min',   () => mainWindow?.minimize());
ipcMain.on('window-max',   () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.hide());

// ─── IPC — Stream ────────────────────────────────────────────────────────────

ipcMain.handle('set-delay',  (_, seconds) => server?.setDelay(seconds));
ipcMain.handle('set-mode',   (_, mode)    => server?.setMode(mode));
ipcMain.handle('get-status', ()           => server?.getStatus());

ipcMain.handle('stop-platform',  (_, platform) => server?.stopPlatform(platform));
ipcMain.handle('start-platform', (_, platform) => server?.startPlatform(platform));

ipcMain.handle('set-platform-key',         (_, { platform, key })       => server?.setPlatformKey(platform, key));
ipcMain.handle('set-platform-enabled',     (_, { platform, enabled })   => server?.setPlatformEnabled(platform, enabled));
ipcMain.handle('set-platform-server',      (_, { platform, serverKey }) => server?.setPlatformServer(platform, serverKey));
ipcMain.handle('set-platform-stable-mode', (_, { platform, enabled })   => server?.setPlatformStableMode(platform, enabled));

ipcMain.handle('is-setup-complete', () => {
    return server?.platforms.twitch.key !== '' || server?.platforms.youtube.key !== '';
});

app.on('window-all-closed', () => { /* não fechar automaticamente — o app controla quando sair */ });
app.on('before-quit', () => { app.isQuiting = true; });
