// ===== Tapa Delay — Preload da janela de Login =====
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('authApi', {
    login:          (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
    signup:         (email, password, name) => ipcRenderer.invoke('auth:signup', { email, password, name }),
    logout:         ()                => ipcRenderer.invoke('auth:logout'),
    checkAccess:    ()                => ipcRenderer.invoke('auth:check-access'),
    notifySuccess:  (info)            => ipcRenderer.send('auth:login-success', info),
    closeWindow:    ()                => ipcRenderer.send('auth:close-login'),
    openExternal:   (url)             => ipcRenderer.invoke('auth:open-external', url),
    redeemCode:     (userId, code)    => ipcRenderer.invoke('auth:redeem-code', { userId, code }),
    onShowExpired:  (cb)              => ipcRenderer.on('auth:show-expired', (_, data) => cb(data)),
});
