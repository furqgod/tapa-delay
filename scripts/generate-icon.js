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
  <!-- Fundo quadrado arredondado, tom escuro do app -->
  <rect width="256" height="256" rx="56" ry="56" fill="#1a1a1c"/>
  <!-- Mão (logo nova), centralizada. viewBox original 0 0 596 645 escalado
       e centralizado dentro do quadrado com margem. -->
  <g transform="translate(35.6, 28) scale(0.3101)">
    <g>
      <g>
        <path d="M339.355,251.224l0,-145.833c0,-25.142 20.692,-45.833 45.833,-45.833c25.142,0 45.833,20.692 45.833,45.833l0,145.833" style="fill:none;fill-rule:nonzero;stroke:#3b82f6;stroke-width:31.25px;"/>
        <path d="M431.022,251.224c125,0 125,145.833 83.333,208.333c-41.667,104.167 -166.667,125 -270.833,125c-125,0 -187.5,-83.333 -187.5,-208.333l0,-83.333" style="fill:none;fill-rule:nonzero;stroke:#3b82f6;stroke-width:31.25px;"/>
        <path d="M56.022,292.891l0,-20.833c0,-25.142 20.692,-45.833 45.833,-45.833c25.142,0 45.833,20.692 45.833,45.833l0,20.833" style="fill:none;fill-rule:nonzero;stroke:#3b82f6;stroke-width:31.25px;"/>
        <path d="M147.689,292.891l0,-54.167c0,-25.142 20.692,-45.833 45.833,-45.833c25.142,0 45.833,20.692 45.833,45.833l0,33.333" style="fill:none;fill-rule:nonzero;stroke:#3b82f6;stroke-width:31.25px;"/>
        <path d="M239.355,272.057l0,-50c0,-27.429 22.571,-50 50,-50c27.429,0 50,22.571 50,50l0,29.167" style="fill:none;fill-rule:nonzero;stroke:#3b82f6;stroke-width:31.25px;"/>
        <path d="M212.272,451.647c68.664,70.27 137.332,70.27 205.996,0" style="fill:none;fill-rule:nonzero;stroke:#3b82f6;stroke-width:36.96px;"/>
        <circle cx="364.857" cy="381.075" r="35.286" style="fill:#3b82f6;"/>
        <circle cx="262.362" cy="381.075" r="35.286" style="fill:#3b82f6;"/>
      </g>
    </g>
  </g>
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
