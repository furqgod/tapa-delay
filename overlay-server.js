// ===== Tapa Delay — Servidor do Overlay (Browser Source do OBS) =====
// HTTP simples (sem dependências novas) que serve a página do overlay e
// empurra eventos em tempo real via Server-Sent Events. Só localhost — o
// overlay não precisa (e não deve) ser acessível de fora da máquina.
const http = require('http');
const fs = require('fs');
const path = require('path');

class OverlayServer {
    constructor() {
        this.server = null;
        this.clients = new Set(); // respostas SSE abertas (uma por aba do OBS/navegador)
    }

    start(port = 3000) {
        if (this.server) return;
        this.server = http.createServer((req, res) => this._handleRequest(req, res));
        this.server.on('error', (err) => {
            console.error(`[Overlay] Erro no servidor: ${err.message}`);
        });
        this.server.listen(port, '127.0.0.1');
    }

    _handleRequest(req, res) {
        const url = req.url.split('?')[0];

        if (url === '/overlay') {
            fs.readFile(path.join(__dirname, 'overlay.html'), 'utf8', (err, html) => {
                if (err) {
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Overlay indisponível');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(html);
            });
            return;
        }

        if (url === '/overlay/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            });
            res.write('\n');
            this.clients.add(res);
            req.on('close', () => this.clients.delete(res));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
    }

    broadcastDelayActivated() {
        const payload = `data: ${JSON.stringify({ type: 'delayActivated' })}\n\n`;
        for (const client of this.clients) {
            try { client.write(payload); } catch {}
        }
    }

    stop() {
        for (const client of this.clients) {
            try { client.end(); } catch {}
        }
        this.clients.clear();
        this.server?.close();
        this.server = null;
    }
}

module.exports = { OverlayServer };
