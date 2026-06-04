// ===== StreamDelay BR - Preload Script =====
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Window
    minimize: () => ipcRenderer.send('window-min'),
    maximize: () => ipcRenderer.send('window-max'),
    close: () => ipcRenderer.send('window-close'),

    // Control
    setDelay: (seconds) => ipcRenderer.invoke('set-delay', seconds),
    setMode: (mode) => ipcRenderer.invoke('set-mode', mode),
    getStatus: () => ipcRenderer.invoke('get-status'),
    
    // Live controls por plataforma
    stopPlatform: (platform) => ipcRenderer.invoke('stop-platform', platform),
    startPlatform: (platform) => ipcRenderer.invoke('start-platform', platform),

    // Config
    setPlatformKey: (platform, key) => ipcRenderer.invoke('set-platform-key', {platform, key}),
    setPlatformEnabled: (platform, enabled) => ipcRenderer.invoke('set-platform-enabled', {platform, enabled}),
    setPlatformServer: (platform, serverKey) => ipcRenderer.invoke('set-platform-server', {platform, serverKey}),
    setPlatformStableMode: (platform, enabled) => ipcRenderer.invoke('set-platform-stable-mode', {platform, enabled}),
    isSetupComplete: () => ipcRenderer.invoke('is-setup-complete'),

    // Auth
    openExternal:  (url)    => ipcRenderer.invoke('app:open-external', url),
    openLog:       ()       => ipcRenderer.invoke('app:open-log'),
    getVersion:    ()       => ipcRenderer.invoke('app:version'),
    logout:        ()       => ipcRenderer.invoke('app:logout'),
    getAccessInfo: ()       => ipcRenderer.invoke('app:get-access-info'),
    onAuthInfo:    (cb)     => ipcRenderer.on('auth-info', (_, data) => cb(data)),

    // Events
    onStatusUpdate: (callback) => ipcRenderer.on('status-update', (e, data) => callback(data)),
    onStatsUpdate:  (callback) => ipcRenderer.on('stats-update',  (e, data) => callback(data)),

    // Auto-update
    onUpdateAvailable:  (cb) => ipcRenderer.on('update-available',  (_, info) => cb(info)),
    onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_, info) => cb(info)),
    installUpdate:      ()   => ipcRenderer.send('update-install')
});
