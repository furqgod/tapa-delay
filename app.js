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
    btnResetDelay: document.getElementById('btnResetDelay'),
    btnPlayDelay: document.getElementById('btnPlayDelay'),
    allPresetBtns: document.querySelectorAll('.btn-delay'),
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
els.btnResetDelay?.addEventListener('click', () => setDelay(0));
els.btnPlayDelay?.addEventListener('click', () => setDelay(state.delay));

els.allPresetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.classList.contains('editing')) return;
        const delay = parseInt(btn.getAttribute('data-delay'), 10);
        if (!isNaN(delay)) setDelay(delay);
    });
});

// Presets editáveis — botão "Editar" no cabeçalho coloca todos os presets em edição de uma vez
function selectElementText(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}

function presetKey(idx, field) {
    return `preset${idx}_${field}`;
}

function savePreset(idx, time, label) {
    localStorage.setItem(uKey(presetKey(idx, 'time')), String(time));
    localStorage.setItem(uKey(presetKey(idx, 'label')), label);
}

function loadPresets() {
    els.allPresetBtns.forEach((btn, idx) => {
        const timeEl = btn.querySelector('.btn-time');
        const labelEl = btn.querySelector('small');
        const lsGet = (field) => localStorage.getItem(uKey(presetKey(idx, field))) ?? localStorage.getItem(presetKey(idx, field));

        const savedTime = lsGet('time');
        const savedLabel = lsGet('label');
        if (savedTime !== null && !isNaN(parseInt(savedTime, 10))) {
            btn.setAttribute('data-delay', savedTime);
            timeEl.textContent = savedTime;
        }
        if (savedLabel) {
            labelEl.textContent = savedLabel;
        }
    });
    updateUI();
}

const presetsEditToggle = document.getElementById('presetsEditToggle');
let presetsEditing = false;
let presetOriginals = [];

function enterPresetsEdit() {
    presetsEditing = true;
    presetOriginals = [];
    els.allPresetBtns.forEach((btn, idx) => {
        const timeEl = btn.querySelector('.btn-time');
        const labelEl = btn.querySelector('small');
        presetOriginals[idx] = {
            time: timeEl.textContent,
            label: labelEl.textContent,
            delay: btn.getAttribute('data-delay'),
        };
        btn.classList.add('editing');
        timeEl.contentEditable = 'true';
        labelEl.contentEditable = 'true';
    });
    if (presetsEditToggle) presetsEditToggle.textContent = 'Salvar';
    const firstTime = els.allPresetBtns[0]?.querySelector('.btn-time');
    if (firstTime) {
        firstTime.focus();
        selectElementText(firstTime);
    }
}

function exitPresetsEdit(save) {
    presetsEditing = false;
    els.allPresetBtns.forEach((btn, idx) => {
        const timeEl = btn.querySelector('.btn-time');
        const labelEl = btn.querySelector('small');
        btn.classList.remove('editing');
        timeEl.contentEditable = 'false';
        labelEl.contentEditable = 'false';

        if (!save) {
            timeEl.textContent = presetOriginals[idx].time;
            labelEl.textContent = presetOriginals[idx].label;
            btn.setAttribute('data-delay', presetOriginals[idx].delay);
            return;
        }

        const val = parseInt(timeEl.textContent, 10);
        const label = labelEl.textContent.trim();
        if (!isNaN(val) && val >= 0 && val <= 300) {
            btn.setAttribute('data-delay', String(val));
            timeEl.textContent = String(val);
        } else {
            timeEl.textContent = presetOriginals[idx].time;
        }
        labelEl.textContent = label || PRESET_DEFAULT_LABELS[idx];
        savePreset(idx, btn.getAttribute('data-delay'), labelEl.textContent);
    });
    if (presetsEditToggle) presetsEditToggle.textContent = 'Editar';
    updateUI();
}

presetsEditToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (presetsEditing) {
        exitPresetsEdit(true);
    } else {
        enterPresetsEdit();
    }
});

els.allPresetBtns.forEach((btn) => {
    const timeEl = btn.querySelector('.btn-time');
    const labelEl = btn.querySelector('small');

    [timeEl, labelEl].forEach((el) => {
        el.addEventListener('click', (e) => { if (presetsEditing) e.stopPropagation(); });
        el.addEventListener('keydown', (e) => {
            if (!presetsEditing) return;
            if (e.key === 'Enter') { e.preventDefault(); exitPresetsEdit(true); }
            if (e.key === 'Escape') { e.preventDefault(); exitPresetsEdit(false); }
        });
    });

    timeEl.addEventListener('keypress', (e) => {
        if (!/[0-9]/.test(e.key)) e.preventDefault();
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
    els.currentDelayDisplay.textContent = ''; // some com o número atual, aguarda o novo

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

    // Stream keys → cofre cifrado (safeStorage) no processo main. NÃO ficam em texto
    // puro no localStorage. Guardamos só um flag booleano de presença pro UI checar
    // existência de forma síncrona (sem expor o segredo). Ver preload/main secure:*.
    await saveSecureKey('twitch', twitchKey);
    await saveSecureKey('youtube', youtubeKey);
    await saveSecureKey('kick', kickKey);

    // Flags não-secretas continuam no localStorage
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

// Grava uma stream key no cofre cifrado + flag de presença; remove qualquer
// resquício em texto puro que exista de versões antigas (com e sem prefixo userId).
async function saveSecureKey(platform, key) {
    if (!isElectron) return;
    await window.api.secureSet(uKey(`${platform}Key`), key);
    localStorage.setItem(uKey(`${platform}KeyPresent`), key ? 'true' : 'false');
    localStorage.removeItem(uKey(`${platform}Key`)); // limpa plaintext legado (prefixado)
    localStorage.removeItem(`${platform}Key`);       // e o sem prefixo
}

// Lê a key do cofre. Se não houver, migra automaticamente uma key legada em texto
// puro do localStorage (versões < 3.1.1) pro cofre e apaga o plaintext.
async function loadSecureKey(platform) {
    if (!isElectron) return '';
    let key = await window.api.secureGet(uKey(`${platform}Key`));
    if (!key) {
        const legacy = localStorage.getItem(uKey(`${platform}Key`)) ?? localStorage.getItem(`${platform}Key`);
        if (legacy) { await saveSecureKey(platform, legacy); key = legacy; }
    }
    return key || '';
}

async function loadSetup() {
    // lsGet: lê key prefixada por userId; se não existir, cai para key sem prefixo
    // (compatibilidade com chaves salvas antes do sistema de userId)
    function lsGet(name) {
        return localStorage.getItem(uKey(name)) ?? localStorage.getItem(name);
    }

    const twitchKey      = await loadSecureKey('twitch');
    const youtubeKey     = await loadSecureKey('youtube');
    const kickKey        = await loadSecureKey('kick');
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

// Cooldown após clicar Parar — algumas plataformas (ex: YouTube) levam ~10s pra
// realmente encerrar a conexão anterior do lado delas; reiniciar antes disso pode
// colidir com a conexão antiga ainda fechando.
const STOP_COOLDOWN_MS = 10000;
const stopCooldowns = {}; // { [platform]: timestamp em que o botão libera de novo }

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
        // Presença da key é síncrona via flag (o segredo em si vive no cofre cifrado).
        // Fallback pro plaintext legado ainda não migrado (some após o 1º loadSetup).
        const hasKey = lsGetCtrl(`${p.name}KeyPresent`) === 'true' || !!lsGetCtrl(`${p.name}Key`);

        // Só mostra a barra se a plataforma está habilitada, tem key e stream está ativa
        if (!connected || !platformEnabled || !hasKey) {
            bar.style.display = 'none';
            continue;
        }

        bar.style.display = 'flex';

        // Cooldown ativo: não deixa o status do backend sobrescrever o countdown
        if (stopCooldowns[p.name] && Date.now() < stopCooldowns[p.name]) continue;

        if (info && info.active) {
            dot.classList.remove('stopped');
            label.textContent = 'Transmitindo';
            btn.textContent = 'Parar';
            btn.classList.remove('restart');
            btn.disabled = false;
        } else {
            dot.classList.add('stopped');
            label.textContent = info?.manuallyStopped ? 'Parado' : 'Reconectando...';
            btn.textContent = 'Iniciar';
            btn.classList.add('restart');
            btn.disabled = false;
        }
    }
}

function startStopCooldown(p) {
    const btn = els[p.btn];
    if (!btn) return;
    const until = Date.now() + STOP_COOLDOWN_MS;
    stopCooldowns[p.name] = until;
    btn.disabled = true;

    const tick = () => {
        const remaining = Math.ceil((until - Date.now()) / 1000);
        if (remaining <= 0) {
            delete stopCooldowns[p.name];
            btn.disabled = false;
            updateWriterControls(window._lastWriters, state.connected);
            return;
        }
        btn.textContent = `Aguarde ${remaining}s`;
        setTimeout(tick, 250);
    };
    tick();
}

platformCtrlMap.forEach(p => {
    els[p.btn]?.addEventListener('click', async () => {
        if (!isElectron) return;
        const info = window._lastWriters && window._lastWriters[p.name];
        if (info && info.active) {
            await window.api.stopPlatform(p.name);
            startStopCooldown(p);
        } else {
            await window.api.startPlatform(p.name);
        }
    });
});

// Copiar URL do RTMP local (card "RTMP Server" nas Configurações)
const btnCopyRtmpUrl = document.getElementById('btnCopyRtmpUrl');
btnCopyRtmpUrl?.addEventListener('click', () => {
    const input = document.getElementById('rtmpServerUrl');
    if (!input) return;
    navigator.clipboard.writeText(input.value);

    const originalHTML = btnCopyRtmpUrl.innerHTML;
    btnCopyRtmpUrl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
    setTimeout(() => {
        btnCopyRtmpUrl.innerHTML = originalHTML;
    }, 2000);
});

// Copiar URL do overlay (Browser Source do OBS)
const btnCopyOverlayUrl = document.getElementById('btnCopyOverlayUrl');
btnCopyOverlayUrl?.addEventListener('click', () => {
    const input = document.getElementById('overlayUrl');
    if (!input) return;
    navigator.clipboard.writeText(input.value);

    const originalHTML = btnCopyOverlayUrl.innerHTML;
    btnCopyOverlayUrl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
    setTimeout(() => {
        btnCopyOverlayUrl.innerHTML = originalHTML;
    }, 2000);
});

// Guia "como configurar no OBS" — modal com o passo a passo
const rtmpGuideModal = document.getElementById('rtmpGuideModal');
document.getElementById('btnRtmpGuide')?.addEventListener('click', () => {
    if (rtmpGuideModal) rtmpGuideModal.style.display = 'flex';
});
document.getElementById('btnCloseRtmpGuide')?.addEventListener('click', () => {
    if (rtmpGuideModal) rtmpGuideModal.style.display = 'none';
});

// Guias das chaves de transmissão (Twitch/YouTube/Kick) — mesmo padrão do
// guia do RTMP: um passo só ("copie sua chave") + imagem de referência.
const platformGuides = [
    { openBtn: 'btnTwitchGuide', modal: 'twitchGuideModal' },
    { openBtn: 'btnYoutubeGuide', modal: 'youtubeGuideModal' },
    { openBtn: 'btnKickGuide', modal: 'kickGuideModal' },
];
platformGuides.forEach(({ openBtn, modal }) => {
    const modalEl = document.getElementById(modal);
    document.getElementById(openBtn)?.addEventListener('click', () => {
        if (modalEl) modalEl.style.display = 'flex';
    });
    modalEl?.querySelector('.modal-close')?.addEventListener('click', () => {
        modalEl.style.display = 'none';
    });
});

// Fecha qualquer guia ao clicar fora do card (no fundo escuro)
document.querySelectorAll('.modal-backdrop').forEach(modalEl => {
    modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) modalEl.style.display = 'none';
    });
});

// Lightbox — clica em qualquer imagem de guia pra ver ela em tamanho grande
const guideImageLightbox = document.getElementById('guideImageLightbox');
const guideImageLightboxImg = document.getElementById('guideImageLightboxImg');
document.querySelectorAll('.guide-image').forEach(img => {
    img.addEventListener('click', (e) => {
        if (!guideImageLightbox || !guideImageLightboxImg) return;
        guideImageLightboxImg.src = e.target.src;
        guideImageLightboxImg.alt = e.target.alt;
        guideImageLightbox.style.display = 'flex';
    });
});
guideImageLightbox?.addEventListener('click', () => {
    guideImageLightbox.style.display = 'none';
});

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (guideImageLightbox && guideImageLightbox.style.display !== 'none') {
        guideImageLightbox.style.display = 'none';
        return;
    }
    document.querySelectorAll('.modal-backdrop').forEach(modalEl => {
        if (modalEl.style.display !== 'none') modalEl.style.display = 'none';
    });
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
    els.allPresetBtns.forEach(btn => {
        const d = parseInt(btn.getAttribute('data-delay'), 10);
        btn.classList.toggle('active', state.delay === d);
    });
}

const PAYMENT_LINK = 'https://buy.stripe.com/test_4gM6oHeUJfHd1FIe5983C00';
let _authUserId = null;
let _authEmail  = null;

// Keys salvas por usuário — cada conta tem seu próprio espaço no localStorage
function uKey(name) {
    return _authUserId ? `${_authUserId}_${name}` : name;
}

// Textos padrão (do HTML, antes de qualquer override salvo) — usados pra
// resetar o nome quando o usuário apaga o campo e salva vazio.
const PRESET_DEFAULT_LABELS = Array.from(els.allPresetBtns).map(btn => btn.querySelector('small').textContent);

loadPresets();

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
    if (userChanged) { loadSetup(); loadPresets(); } // recarrega keys da conta correta

    // Mostra nome se existir, senão o email
    if (emailEl)  emailEl.textContent  = info.name || info.email || '—';
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

// Tema claro/escuro — preferência de aparência, não é por conta (mesmo
// dispositivo pode ter usuários diferentes com o mesmo gosto de tema)
const darkModeToggle = document.getElementById('darkModeToggle');
function applyTheme(isDark) {
    document.body.classList.toggle('light-theme', !isDark);
}
const savedIsDark = localStorage.getItem('darkMode');
const isDark = savedIsDark !== null ? savedIsDark === 'true' : true;
if (darkModeToggle) darkModeToggle.checked = isDark;
applyTheme(isDark);
darkModeToggle?.addEventListener('change', () => {
    localStorage.setItem('darkMode', String(darkModeToggle.checked));
    applyTheme(darkModeToggle.checked);
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

// ─── Background Ripple Effect ────────────────────────────────────────────────
// Baseado em uiverse-style / aceternity background-ripple-effect, adaptado pro
// tema do app. Clique em qualquer área vazia do fundo dispara a onda.
function initRipple(container, cellSize) {
    const rect = container.getBoundingClientRect();
    const cols = Math.ceil((rect.width * 1.4) / cellSize);
    const rows = Math.ceil((rect.height * 1.4) / cellSize);
    const grid = document.createElement('div');
    grid.className = 'ripple-grid';
    // A grade é só visual agora — o clique é capturado no document (veja
    // abaixo), não precisa mais "atravessar" pointer-events pra chegar nela.
    // Isso evita o conflito com scroll/botões que existia antes.
    grid.style.pointerEvents = 'none';
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = `repeat(${cols}, ${cellSize}px)`;
    grid.style.gridTemplateRows = `repeat(${rows}, ${cellSize}px)`;
    grid.style.width = (cols * cellSize) + 'px';
    grid.style.height = (rows * cellSize) + 'px';

    const cells = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cell = document.createElement('div');
            cell.className = 'ripple-cell';
            cell.dataset.row = r;
            cell.dataset.col = c;
            grid.appendChild(cell);
            cells.push(cell);
        }
    }
    container.appendChild(grid);

    function triggerRipple(row, col) {
        // 1ª passada: calcula delay/duration e tira a classe de todo mundo
        cells.forEach(cell => {
            const cr = +cell.dataset.row, cc = +cell.dataset.col;
            const dist = Math.hypot(row - cr, col - cc);
            const delay = Math.max(0, dist * 40);
            const duration = 220 + dist * 65;
            cell.style.setProperty('--delay', delay + 'ms');
            cell.style.setProperty('--duration', duration + 'ms');
            cell.classList.remove('rippling');
        });
        // 1 único reflow forçado pra grade inteira (em vez de 1 por célula)
        void grid.offsetHeight;
        // 2ª passada: reaplica a classe, dispara a animação de todas de uma vez
        cells.forEach(cell => cell.classList.add('rippling'));
    }

    // Só reage em cima de fundo vazio — cabeçalho, presets, botões, qualquer
    // card (Streaming/Settings/About/Overlay/Update) e o número principal não
    // devem animar/destacar o background. Pega toda classe "*-card" de uma
    // vez em vez de listar uma por uma.
    const RIPPLE_EXCLUDE = 'button, a, input, select, label, #currentDelayDisplay, ' +
        '.app-header-split, .update-banner, .modal-backdrop, .image-lightbox, [class*="-card"]';

    // Clique em QUALQUER lugar do app (mesmo em cima de botões/cards) dispara
    // a onda na célula mais próxima do ponto clicado. Delegado no document
    // pra não depender de pointer-events em nada — resolve de vez o conflito
    // entre "clique atravessa até a célula" vs "página precisa de scroll".
    document.addEventListener('click', (e) => {
        if (e.target.closest(RIPPLE_EXCLUDE)) return;

        const gridRect = grid.getBoundingClientRect();
        const col = Math.round((e.clientX - gridRect.left) / cellSize);
        const row = Math.round((e.clientY - gridRect.top) / cellSize);
        if (row >= 0 && row < rows && col >= 0 && col < cols) {
            triggerRipple(row, col);
        }
    });

    // Célula sob o mouse fica "selecionada" (destacada) ao passar o cursor no
    // fundo — mesma lógica de coordenadas do clique, já que a grade está com
    // pointer-events:none (não dá pra usar :hover puro do CSS aqui).
    let hoveredCell = null;
    document.addEventListener('mousemove', (e) => {
        let cell = null;
        if (!e.target.closest(RIPPLE_EXCLUDE)) {
            const gridRect = grid.getBoundingClientRect();
            const col = Math.round((e.clientX - gridRect.left) / cellSize);
            const row = Math.round((e.clientY - gridRect.top) / cellSize);
            if (row >= 0 && row < rows && col >= 0 && col < cols) {
                cell = cells[row * cols + col];
            }
        }
        if (cell !== hoveredCell) {
            if (hoveredCell) hoveredCell.classList.remove('hovered');
            if (cell) cell.classList.add('hovered');
            hoveredCell = cell;
        }
    });
}
const rippleLayer = document.getElementById('rippleLayer');
if (rippleLayer) initRipple(rippleLayer, 40);

// ─── Logo: hover revela o texto, clique mostra agradecimento do beta ────────
const brandLogo = document.getElementById('brandLogo');
if (brandLogo) {
    brandLogo.addEventListener('click', () => {
        brandLogo.classList.add('thanked');
    });
    brandLogo.addEventListener('mouseleave', () => {
        brandLogo.classList.remove('thanked');
    });
}
