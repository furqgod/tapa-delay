// Gera assets/icon.png e assets/icon.ico usando Electron
// Uso: npx electron scripts/generate-icon.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 256px; height: 256px; overflow: hidden; background: transparent; }
</style>
</head>
<body>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#6366F1"/>
      <stop offset="100%" stop-color="#4338CA"/>
    </linearGradient>
  </defs>
  <!-- Fundo quadrado arredondado -->
  <rect width="256" height="256" rx="56" ry="56" fill="url(#grad)"/>
  <!-- Texto TD centralizado -->
  <text
    x="128"
    y="172"
    font-family="'Arial Black', 'Arial Bold', Arial, sans-serif"
    font-size="112"
    font-weight="900"
    fill="white"
    text-anchor="middle"
    letter-spacing="-4"
  >TD</text>
</svg>
</body>
</html>`;

function createICO(pngBuffer) {
    // Formato ICO com PNG embutido (suportado desde Windows Vista)
    const header = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);
    const dir = Buffer.alloc(16);
    dir[0] = 0;    // largura = 256 (0 = 256)
    dir[1] = 0;    // altura = 256
    dir[2] = 0;    // número de cores
    dir[3] = 0;    // reservado
    dir.writeUInt16LE(1, 4);                  // planos de cor
    dir.writeUInt16LE(32, 6);                 // bits por pixel
    dir.writeUInt32LE(pngBuffer.length, 8);   // tamanho dos dados
    dir.writeUInt32LE(22, 12);                // offset dos dados (6 + 16)
    return Buffer.concat([header, dir, pngBuffer]);
}

app.whenReady().then(async () => {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });

    const htmlPath = path.join(ASSETS_DIR, '_tmp_icon.html');
    fs.writeFileSync(htmlPath, HTML, 'utf8');

    const win = new BrowserWindow({
        width: 256,
        height: 256,
        show: false,
        frame: false,
        transparent: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    win.loadFile(htmlPath);

    await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await new Promise(r => setTimeout(r, 600)); // aguarda renderização completa

    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
    const pngBuffer = img.toPNG();

    const pngPath = path.join(ASSETS_DIR, 'icon.png');
    const icoPath = path.join(ASSETS_DIR, 'icon.ico');

    fs.writeFileSync(pngPath, pngBuffer);
    console.log('✅ assets/icon.png gerado!');

    fs.writeFileSync(icoPath, createICO(pngBuffer));
    console.log('✅ assets/icon.ico gerado!');

    fs.unlinkSync(htmlPath);

    app.quit();
});
