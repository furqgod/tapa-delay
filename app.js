// ===== StreamDelay BR - App Logic (Renderer) =====
const isElectron = window.api !== undefined;

const state = {
    connected: false,
    delay: 0,
    mode: 'normal',
    stats: { inKbps: 0, outKbps: 0, uptime: 0 }
};

// Elements
const els = {
    pages: document.querySelectorAll('.page'),
    navBtns: document.querySelectorAll('.nav-item'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    uptimeText: document.getElementById('uptimeText'),
    currentDelayDisplay: document.getElementById('currentDelayDisplay'),
    delayUnit: document.getElementById('delayUnit'),
    delayProgress: document.getElementById('delayProgress'),
    btnLive: document.getElementById('btnLive'),
    btnResetDelay: document.getElementById('btnResetDelay'),
    btnPlayDelay: document.getElementById('btnPlayDelay'),
    delayBtns: document.querySelectorAll('.btn-delay:not(#btnLive)'),
    inBitrate: document.getElementById('inBitrate'),
    outBitrate: document.getElementById('outBitrate'),
    
    // Setup
    twitchKey: document.getElementById('twitchKey'),
    youtubeKey: document.getElementById('youtubeKey'),
    kickKey: document.getElementById('kickKey'),
    enableTwitch: document.getElementById('enableTwitch'),
    enableYoutube: document.getElementById('enableYoutube'),
    enableKick: document.getElementById('enableKick'),
    twitchStableMode: document.getElementById('twitchStableMode'),
    btnSaveSetup: document.getElementById('btnSaveSetup'),
    
    // Overlay
    overlayLink: document.getElementById('overlayLink'),
    btnCopyLink: document.getElementById('btnCopyLink'),

    // Live controls
    twitchLiveBar: document.getElementById('twitchLiveBar'),
    youtubeLiveBar: document.getElementById('youtubeLiveBar'),
    kickLiveBar: document.getElementById('kickLiveBar'),
    btnTwitchCtrl: document.getElementById('btnTwitchCtrl'),
    btnYoutubeCtrl: document.getElementById('btnYoutubeCtrl'),
    btnKickCtrl: document.getElementById('btnKickCtrl'),
    twitchWriterDot: document.getElementById('twitchWriterDot'),
    youtubeWriterDot: document.getElementById('youtubeWriterDot'),
    kickWriterDot: document.getElementById('kickWriterDot'),
    twitchWriterLabel: document.getElementById('twitchWriterLabel'),
    youtubeWriterLabel: document.getElementById('youtubeWriterLabel'),
    kickWriterLabel: document.getElementById('kickWriterLabel'),
};

// Utils
function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Navigation
els.navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        els.navBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        const targetPage = btn.getAttribute('data-page');
        els.pages.forEach(p => {
            if (p.id === `${targetPage}Page`) {
                p.classList.add('active');
            } else {
                p.classList.remove('active');
            }
        });
    });
});

// Window controls
document.getElementById('btnMin')?.addEventListener('click', () => isElectron && window.api.minimize());
document.getElementById('btnMax')?.addEventListener('click', () => isElectron && window.api.maximize());
document.getElementById('btnClose')?.addEventListener('click', () => isElectron && window.api.close());

// Delay Controls
els.btnLive.addEventListener('click', () => setDelay(0));
els.btnResetDelay?.addEventListener('click', () => setDelay(0));
els.btnPlayDelay?.addEventListener('click', () => setDelay(state.delay));

els.delayBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const delay = parseInt(btn.getAttribute('data-delay'));
        setDelay(delay);
    });
});

async function setDelay(seconds) {
    if (!isElectron) return;
    
    const res = await window.api.setDelay(seconds);
    if (res.success) {
        state.delay = res.delay;
        updateUI();
    }
}

// Delay editável — clica no número grande para digitar
els.currentDelayDisplay.addEventListener('click', () => {
    if (els.currentDelayDisplay.contentEditable === 'true') return;

    els.currentDelayDisplay.contentEditable = 'true';
    els.currentDelayDisplay.classList.add('editing');

    // Posiciona cursor no final sem selecionar o texto
    const range = document.createRange();
    range.selectNodeContents(els.currentDelayDisplay);
    range.collapse(false); // false = colapsa para o FIM (cursor piscando)
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const confirm = () => {
        const val = parseInt(els.currentDelayDisplay.textContent);
        els.currentDelayDisplay.contentEditable = 'false';
        els.currentDelayDisplay.classList.remove('editing');
        if (!isNaN(val) && val >= 0 && val <= 300) {
            setDelay(val);
        } else {
            // Valor inválido — restaura o delay atual
            els.currentDelayDisplay.textContent = String(state.delay);
        }
    };

    const cancel = () => {
        els.currentDelayDisplay.contentEditable = 'false';
        els.currentDelayDisplay.classList.remove('editing');
        els.currentDelayDisplay.textContent = String(state.delay);
    };

    const keyHandler = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); confirm(); cleanup(); }
        if (e.key === 'Escape') { cancel(); cleanup(); }
        // Permite apenas números e teclas de controle
        if (!/[0-9]|Backspace|Delete|ArrowLeft|ArrowRight|Home|End/.test(e.key)) {
            e.preventDefault();
        }
    };

    const blurHandler = () => { confirm(); cleanup(); };

    const cleanup = () => {
        els.currentDelayDisplay.removeEventListener('keydown', keyHandler);
        els.currentDelayDisplay.removeEventListener('blur', blurHandler);
    };

    els.currentDelayDisplay.addEventListener('keydown', keyHandler);
    els.currentDelayDisplay.addEventListener('blur', blurHandler);
});

// Eye toggle for stream key fields
document.querySelectorAll('.btn-eye').forEach(btn => {
    btn.addEventListener('click', () => {
        const input = document.getElementById(btn.getAttribute('data-target'));
        const isHidden = input.type === 'password';
        input.type = isHidden ? 'text' : 'password';
        btn.querySelector('.eye-icon').style.display = isHidden ? 'none' : '';
        btn.querySelector('.eye-off-icon').style.display = isHidden ? '' : 'none';
    });
});

// Setup
async function saveSetup() {
    if (!isElectron) return;

    const twitchKey = els.twitchKey.value.trim();
    const youtubeKey = els.youtubeKey.value.trim();
    const kickKey = els.kickKey ? els.kickKey.value.trim() : '';
    const twitchEnabled = els.enableTwitch.checked;
    const youtubeEnabled = els.enableYoutube.checked;
    const kickEnabled = els.enableKick ? els.enableKick.checked : false;
    const twitchServer = document.getElementById('twitchServer')?.value || 'sa_east';
    const twitchStableMode = els.twitchStableMode ? els.twitchStableMode.checked : true;

    // Save to local storage (por usuário)
    localStorage.setItem(uKey('twitchKey'),      twitchKey);
    localStorage.setItem(uKey('youtubeKey'),     youtubeKey);
    localStorage.setItem(uKey('kickKey'),        kickKey);
    localStorage.setItem(uKey('twitchEnabled'),  twitchEnabled);
    localStorage.setItem(uKey('youtubeEnabled'), youtubeEnabled);
    localStorage.setItem(uKey('kickEnabled'),    kickEnabled);
    localStorage.setItem(uKey('twitchServer'),   twitchServer);
    localStorage.setItem(uKey('twitchStableMode'), twitchStableMode);

    // Update backend
    await window.api.setPlatformKey('twitch', twitchKey);
    await window.api.setPlatformEnabled('twitch', twitchEnabled);
    await window.api.setPlatformServer('twitch', twitchServer);
    await window.api.setPlatformStableMode('twitch', twitchStableMode);

    await window.api.setPlatformKey('youtube', youtubeKey);
    await window.api.setPlatformEnabled('youtube', youtubeEnabled);

    await window.api.setPlatformKey('kick', kickKey);
    await window.api.setPlatformEnabled('kick', kickEnabled);
    
    // Visual feedback
    const btn = els.btnSaveSetup;
    const originalText = btn.textContent;
    btn.textContent = 'Salvo!';
    btn.style.background = 'var(--success)';
    
    setTimeout(() => {
        btn.textContent = originalText;
        btn.style.background = '';
    }, 2000);
}

els.btnSaveSetup?.addEventListener('click', saveSetup);

function loadSetup() {
    // lsGet: lê key prefixada por userId; se não existir, cai para key sem prefixo
    // (compatibilidade com chaves salvas antes do sistema de userId)
    function lsGet(name) {
        return localStorage.getItem(uKey(name)) ?? localStorage.getItem(name);
    }

    const twitchKey      = lsGet('twitchKey')      || '';
    const youtubeKey     = lsGet('youtubeKey')     || '';
    const kickKey        = lsGet('kickKey')        || '';
    const twitchEnabled  = lsGet('twitchEnabled')  !== 'false';
    const youtubeEnabled = lsGet('youtubeEnabled') === 'true';
    const kickEnabled    = lsGet('kickEnabled')    === 'true';
    const twitchServer   = lsGet('twitchServer')   || 'sa_east';
    const twitchStableMode = lsGet('twitchStableMode') !== 'false';

    if (els.twitchKey) els.twitchKey.value = twitchKey;
    if (els.youtubeKey) els.youtubeKey.value = youtubeKey;
    if (els.kickKey) els.kickKey.value = kickKey;
    if (els.enableTwitch) els.enableTwitch.checked = twitchEnabled;
    if (els.enableYoutube) els.enableYoutube.checked = youtubeEnabled;
    if (els.enableKick) els.enableKick.checked = kickEnabled;
    if (els.twitchStableMode) els.twitchStableMode.checked = twitchStableMode;
    const serverSelect = document.getElementById('twitchServer');
    if (serverSelect) serverSelect.value = twitchServer;

    // Sync backend immediately if values exist
    if (isElectron) {
        window.api.setPlatformKey('twitch', twitchKey);
        window.api.setPlatformEnabled('twitch', twitchEnabled);
        window.api.setPlatformServer('twitch', twitchServer);
        window.api.setPlatformStableMode('twitch', twitchStableMode);
        window.api.setPlatformKey('youtube', youtubeKey);
        window.api.setPlatformEnabled('youtube', youtubeEnabled);
        window.api.setPlatformKey('kick', kickKey);
        window.api.setPlatformEnabled('kick', kickEnabled);
    }
}

// Controles individuais de plataforma ao vivo
const platformCtrlMap = [
    { name: 'twitch', bar: 'twitchLiveBar', dot: 'twitchWriterDot', label: 'twitchWriterLabel', btn: 'btnTwitchCtrl' },
    { name: 'youtube', bar: 'youtubeLiveBar', dot: 'youtubeWriterDot', label: 'youtubeWriterLabel', btn: 'btnYoutubeCtrl' },
    { name: 'kick', bar: 'kickLiveBar', dot: 'kickWriterDot', label: 'kickWriterLabel', btn: 'btnKickCtrl' },
];

function updateWriterControls(writers, connected) {
    for (const p of platformCtrlMap) {
        const bar = els[p.bar];
        const dot = els[p.dot];
        const label = els[p.label];
        const btn = els[p.btn];
        if (!bar) continue;

        const info = writers && writers[p.name];
        // lê com prefixo de userId; fallback para chave sem prefixo (chaves legadas)
        const lsGetCtrl = (name) => localStorage.getItem(uKey(name)) ?? localStorage.getItem(name);
        const platformEnabled = lsGetCtrl(`${p.name}Enabled`) === 'true' ||
            (p.name === 'twitch' && lsGetCtrl('twitchEnabled') !== 'false');
        const hasKey = !!(lsGetCtrl(`${p.name}Key`));

        // Só mostra a barra se a plataforma está habilitada, tem key e stream está ativa
        if (!connected || !platformEnabled || !hasKey) {
            bar.style.display = 'none';
            continue;
        }

        bar.style.display = 'flex';

        if (info && info.active) {
            dot.classList.remove('stopped');
            label.textContent = 'Transmitindo';
            btn.textContent = 'Parar';
            btn.classList.remove('restart');
        } else {
            dot.classList.add('stopped');
            label.textContent = info?.manuallyStopped ? 'Parado' : 'Reconectando...';
            btn.textContent = 'Iniciar';
            btn.classList.add('restart');
        }
    }
}

platformCtrlMap.forEach(p => {
    els[p.btn]?.addEventListener('click', async () => {
        if (!isElectron) return;
        const info = window._lastWriters && window._lastWriters[p.name];
        if (info && info.active) {
            await window.api.stopPlatform(p.name);
        } else {
            await window.api.startPlatform(p.name);
        }
    });
});

// Overlay Link
els.btnCopyLink?.addEventListener('click', () => {
    const link = 'http://localhost:3000/overlay';
    navigator.clipboard.writeText(link);
    
    const btn = els.btnCopyLink;
    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<span>Copiado!</span>';
    
    setTimeout(() => {
        btn.innerHTML = originalHTML;
    }, 2000);
});

// Update UI based on state
function updateUI() {
    // Status connection
    if (state.connected) {
        els.statusDot.classList.add('active');
        els.statusText.textContent = 'Online';
        els.statusText.style.color = 'var(--success)';
    } else {
        els.statusDot.classList.remove('active');
        els.statusText.textContent = 'Offline';
        els.statusText.style.color = '';
        state.stats.uptime = 0;
        els.uptimeText.textContent = '00:00:00';
    }

    // Delay Display
    els.currentDelayDisplay.textContent = String(state.delay);
    // número sempre branco — sem alteração de cor
    if (els.delayUnit) els.delayUnit.textContent = 'sec';

    const percentage = Math.min((state.delay / 300) * 100, 100);
    els.delayProgress.style.width = `${percentage}%`;

    // Buttons highlight
    els.btnLive.classList.toggle('active', state.delay === 0);
    els.delayBtns.forEach(btn => {
        const d = parseInt(btn.getAttribute('data-delay'));
        btn.classList.toggle('active', state.delay === d);
    });
}

// Avatar — inicial do nome (ou do email se não houver nome)
function setAvatarInitial(nameOrEmail) {
    const el = document.getElementById('avatarInitial');
    if (!el || !nameOrEmail) return;
    el.textContent = nameOrEmail.trim()[0].toUpperCase();
}

function showAvatarPhoto(dataUrl) {
    const photo  = document.getElementById('avatarPhoto');
    const initial = document.getElementById('avatarInitial');
    if (!photo) return;
    photo.src = dataUrl;
    photo.style.display = 'block';
    if (initial) initial.style.display = 'none';
}

function loadAvatar() {
    const saved = localStorage.getItem(uKey('profilePhoto'));
    if (saved) showAvatarPhoto(saved);
}

document.getElementById('avatarBtn')?.addEventListener('click', () => {
    document.getElementById('avatarInput')?.click();
});

document.getElementById('avatarInput')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        localStorage.setItem(uKey('profilePhoto'), dataUrl);
        showAvatarPhoto(dataUrl);
    };
    reader.readAsDataURL(file);
});

const PAYMENT_LINK = 'https://buy.stripe.com/test_4gM6oHeUJfHd1FIe5983C00';
let _authUserId = null;
let _authEmail  = null;

// Keys salvas por usuário — cada conta tem seu próprio espaço no localStorage
function uKey(name) {
    return _authUserId ? `${_authUserId}_${name}` : name;
}

function openSubscribePage() {
    if (!isElectron) return;
    let url = PAYMENT_LINK;
    if (_authUserId) url += `?client_reference_id=${_authUserId}`;
    if (_authEmail)  url += `${_authUserId ? '&' : '?'}prefilled_email=${encodeURIComponent(_authEmail)}`;
    window.api.openExternal(url);
}

['twitchProOverlay', 'youtubeProOverlay', 'kickProOverlay'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', openSubscribePage);
});

// Auth info — mostra trial banner e dados do usuário
function applyAuthInfo(info) {
    if (!info) return;
    const emailEl  = document.getElementById('userEmail');
    const statusEl = document.getElementById('userStatus');
    const banner   = document.getElementById('trialBanner');
    const daysEl   = document.getElementById('trialDaysLeft');

    const userChanged = info.userId && info.userId !== _authUserId;
    if (info.userId) _authUserId = info.userId;
    if (info.email)  _authEmail  = info.email;
    if (userChanged) loadSetup(); // recarrega keys da conta correta

    // Mostra nome se existir, senão o email
    if (emailEl)  emailEl.textContent  = info.name || info.email || '—';
    setAvatarInitial(info.name || info.email);
    loadAvatar();
    if (statusEl) statusEl.textContent = info.reason === 'trial'
        ? `Trial — ${info.daysLeft} dias restantes`
        : info.reason === 'active_subscription' ? 'Assinatura ativa ✓' : '';

    if (banner && info.reason === 'trial') {
        banner.style.display = 'block';
        if (daysEl) daysEl.textContent = info.daysLeft;
    }

    // Bloqueia plataformas se assinatura expirada/cancelada
    const locked = !info.hasAccess &&
        (info.reason === 'trial_expired' || info.reason === 'subscription_cancelled');
    ['twitchProOverlay', 'youtubeProOverlay', 'kickProOverlay'].forEach(id => {
        document.getElementById(id)?.classList.toggle('visible', locked);
    });
}

// Logout
document.getElementById('btnOpenLog')?.addEventListener('click', () => {
    if (!isElectron) return;
    window.api.openLog();
});

document.getElementById('btnLogout')?.addEventListener('click', async () => {
    if (!isElectron) return;
    await window.api.logout();
});

// Initialization & IPC Events
if (isElectron) {
    loadSetup();

    window.api.onStatusUpdate((data) => {
        state.connected = data.connected;
        state.delay = data.delay;
        state.mode = data.mode;
        window._lastWriters = data.writers || {};

        if (data.error) {
            els.statusText.textContent = data.error.substring(0, 40).toUpperCase();
            els.statusText.style.color = 'var(--danger)';
        } else if (data.writerError) {
            els.statusText.textContent = `ERR: ${data.writerError.substring(0, 30).toUpperCase()}`;
            els.statusText.style.color = 'var(--warning)';
            setTimeout(() => updateUI(), 5000);
        } else {
            els.statusText.style.color = '';
            updateUI();
        }
        updateWriterControls(data.writers, data.connected);
    });

    window.api.onStatsUpdate((data) => {
        state.stats = data;
        els.inBitrate.textContent = `${data.inKbps} kbps`;
        els.outBitrate.textContent = `${data.outKbps} kbps`;
        els.uptimeText.textContent = formatTime(data.uptime);
    });

    // Auto-update
    document.getElementById('btnDismissUpdate')?.addEventListener('click', () => {
        document.getElementById('updateBanner').style.display = 'none';
        // Mostra o card de update na aba Settings e navega para lá
        document.getElementById('updateSettingsCard').style.display = 'flex';
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        document.querySelector('[data-page="settings"]')?.classList.add('active');
        document.querySelectorAll('.page').forEach(p => {
            p.classList.toggle('active', p.id === 'settingsPage');
        });
    });

    window.api.onUpdateAvailable?.((info) => {
        // Banner: mostra botão Baixar
        const banner  = document.getElementById('updateBanner');
        const text    = document.getElementById('updateText');
        const btnDown = document.getElementById('btnDownloadUpdate');
        if (banner && text) {
            text.textContent = `Nova versão ${info.version} disponível`;
            banner.style.display = 'flex';
        }
        if (btnDown) btnDown.onclick = () => {
            btnDown.textContent = 'Baixando...';
            btnDown.disabled = true;
            window.api.downloadUpdate();
        };
        // Card Settings
        const cardTitle = document.getElementById('updateSettingsTitle');
        const cardDesc  = document.getElementById('updateSettingsDesc');
        const cardBtnDown = document.getElementById('btnDownloadUpdate2');
        if (cardTitle) cardTitle.textContent = `Versão ${info.version} disponível`;
        if (cardDesc)  cardDesc.textContent  = 'Clique em Baixar para iniciar o download';
        if (cardBtnDown) cardBtnDown.onclick = () => {
            cardBtnDown.textContent = 'Baixando...';
            cardBtnDown.disabled = true;
            document.getElementById('btnDownloadUpdate').disabled = true;
            document.getElementById('btnDownloadUpdate').textContent = 'Baixando...';
            window.api.downloadUpdate();
        };
    });

    window.api.onUpdateDownloaded?.((info) => {
        // Banner: esconde Baixar, mostra Instalar
        const text    = document.getElementById('updateText');
        const btnDown = document.getElementById('btnDownloadUpdate');
        const btnInst = document.getElementById('btnInstallUpdate');
        if (text)    text.textContent    = `Versão ${info.version} pronta para instalar`;
        if (btnDown) btnDown.style.display = 'none';
        if (btnInst) { btnInst.style.display = 'block'; btnInst.onclick = () => window.api.installUpdate(); }
        // Card Settings
        const cardTitle   = document.getElementById('updateSettingsTitle');
        const cardDesc    = document.getElementById('updateSettingsDesc');
        const cardBtn     = document.getElementById('btnInstallUpdate2');
        const cardBtnDown = document.getElementById('btnDownloadUpdate2');
        if (cardTitle)   cardTitle.textContent    = `Versão ${info.version} pronta para instalar`;
        if (cardDesc)    cardDesc.textContent     = 'Download concluído — clique para instalar';
        if (cardBtnDown) cardBtnDown.style.display = 'none';
        if (cardBtn)     { cardBtn.style.display  = 'block'; cardBtn.onclick = () => window.api.installUpdate(); }
    });

    // Check if needs setup
    window.api.isSetupComplete().then(isComplete => {
        if (!isComplete) {
            // Force goto streaming setup
            document.querySelector('[data-page="streaming"]').click();
        }
    });

    // Recebe info de auth ao abrir
    window.api.onAuthInfo((info) => applyAuthInfo(info));
    window.api.getAccessInfo().then(applyAuthInfo).catch(() => {});

    // Versão do app
    window.api.getVersion().then(v => {
        const el = document.getElementById('appVersion');
        if (el) el.textContent = `v${v}`;
        const about = document.getElementById('aboutVersion');
        if (about) about.textContent = `Version ${v} - Melhorando sua interação com o chat`;
    }).catch(() => {});

    // Initial status
    window.api.getStatus().then(data => {
        state.connected = data.connected;
        state.delay = data.delay;
        state.mode = data.mode;
        window._lastWriters = data.writers || {};
        updateUI();
        updateWriterControls(data.writers, data.connected);
    });
} else {
    // Browser mock mode for styling
    loadSetup();
    updateUI();
}

console.log('🎮 StreamDelay BR v1.0.0 iniciado!' + (isElectron ? ' (Electron)' : ' (Browser)'));
