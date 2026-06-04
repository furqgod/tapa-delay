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

    // Save to local storage
    localStorage.setItem('twitchKey', twitchKey);
    localStorage.setItem('youtubeKey', youtubeKey);
    localStorage.setItem('kickKey', kickKey);
    localStorage.setItem('twitchEnabled', twitchEnabled);
    localStorage.setItem('youtubeEnabled', youtubeEnabled);
    localStorage.setItem('kickEnabled', kickEnabled);
    localStorage.setItem('twitchServer', twitchServer);
    localStorage.setItem('twitchStableMode', twitchStableMode);

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
    // Carrega do localStorage (ou migra se existia 'streamKey' antiga)
    const oldKey = localStorage.getItem('streamKey');
    if (oldKey && !localStorage.getItem('twitchKey')) {
        localStorage.setItem('twitchKey', oldKey);
        localStorage.removeItem('streamKey');
    }

    const twitchKey = localStorage.getItem('twitchKey') || '';
    const youtubeKey = localStorage.getItem('youtubeKey') || '';
    const kickKey = localStorage.getItem('kickKey') || '';
    const twitchEnabled = localStorage.getItem('twitchEnabled') !== 'false';
    const youtubeEnabled = localStorage.getItem('youtubeEnabled') === 'true';
    const kickEnabled = localStorage.getItem('kickEnabled') === 'true';
    const twitchServer = localStorage.getItem('twitchServer') || 'sa_east';
    const twitchStableMode = localStorage.getItem('twitchStableMode') !== 'false';

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
        const platformEnabled = localStorage.getItem(`${p.name}Enabled`) === 'true' ||
            (p.name === 'twitch' && localStorage.getItem('twitchEnabled') !== 'false');
        const hasKey = !!(localStorage.getItem(`${p.name}Key`));

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
            label.textContent = info?.manuallyStopped ? 'Parado manualmente' : 'Reconectando...';
            btn.textContent = 'Reconectar';
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
    const saved = localStorage.getItem('profilePhoto');
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
        localStorage.setItem('profilePhoto', dataUrl);
        showAvatarPhoto(dataUrl);
    };
    reader.readAsDataURL(file);
});

const PAYMENT_LINK = 'https://buy.stripe.com/test_4gM6oHeUJfHd1FIe5983C00';
let _authUserId = null;
let _authEmail  = null;

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

    if (info.userId) _authUserId = info.userId;
    if (info.email)  _authEmail  = info.email;

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
    window.api.onUpdateAvailable?.((info) => {
        const banner = document.getElementById('updateBanner');
        const text   = document.getElementById('updateText');
        if (banner && text) {
            text.textContent = `Nova versão ${info.version} disponível — baixando...`;
            banner.style.display = 'flex';
        }
    });
    window.api.onUpdateDownloaded?.((info) => {
        const banner = document.getElementById('updateBanner');
        const text   = document.getElementById('updateText');
        const btn    = document.getElementById('btnInstallUpdate');
        if (banner && text && btn) {
            text.textContent = `Versão ${info.version} pronta para instalar`;
            btn.style.display = 'block';
            btn.onclick = () => window.api.installUpdate();
        }
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
