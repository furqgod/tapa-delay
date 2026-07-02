// ===== StreamDelay BR - RTMP Server + Delay Engine v3 =====
const NodeMediaServer = require('node-media-server');
const Context = require('node-media-server/src/core/context');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const os  = require('os');
const net = require('net');
const fs  = require('fs');

const TWITCH_SERVERS = {
    auto: 'rtmp://ingest.twitch.tv/app/',
    sa_east: 'rtmp://sao03.contribute.live-video.net/app/',
    miami: 'rtmp://mia01.contribute.live-video.net/app/',
};

const YOUTUBE_SERVER = 'rtmp://a.rtmp.youtube.com/live2/';
const KICK_SERVER = 'rtmps://fa723fc1b171.global-contribute.live-video.net/app/';

// Buffer sempre mantém 310s de dados — permite delay de até 300s sem queda de conexão
const MAX_BUFFER_MS = 310000;

class StreamDelayServer extends EventEmitter {
    constructor() {
        super();
        this.nms = null;
        this.readerProcess = null;
        this.writerProcesses = {};
        this.delay = 0;
        this.mode = 'normal';
        this.connected = false;
        this.currentStreamPath = null;
        this.statsInterval = null;
        this.startTime = null;

        // Platform configs
        this.platforms = {
            twitch: { enabled: true, key: '', server: TWITCH_SERVERS.sa_east, stableMode: true, manuallyStopped: false, failCount: 0, persistentReconnect: false },
            youtube: { enabled: false, key: '', server: YOUTUBE_SERVER, stableMode: true, manuallyStopped: false, failCount: 0, persistentReconnect: false },
            kick: { enabled: false, key: '', server: KICK_SERVER, stableMode: true, manuallyStopped: false, failCount: 0, persistentReconnect: false },
        };

        this._spawnWriter = null;
        this._reconnectTimers = {};
        this._tempReaders = {}; // readers temporários por plataforma (para restart individual)

        // Buffer system
        // - buffer mantém sempre 310s de dados (independente do delay atual)
        // - sentUntil = wall time do último pacote enviado aos outputs
        // - drainStart = índice no buffer do próximo pacote a ser checado
        this.buffer = [];
        this.sentUntil = 0;
        this.drainStart = 0;
        this.drainInterval = null;
        this.isBuffering = false;
        this.bufferTransition = false;
        this.transitionStartTime = null;

        // Stats
        this.bytesIn = 0;
        this.bytesOut = 0;

        this.streamingBlocked = false;

        // Diagnóstico
        this.logPath = null;
        this._stderrBuffers = {};
    }

    // ─── Diagnóstico ────────────────────────────────────────────────────────────

    setLogPath(p) {
        this.logPath = p;
        this._writeLog('════════════════════════════════');
        this._writeLog('▶  Tapa Delay iniciado');
        this._writeLog('════════════════════════════════');
    }

    _writeLog(message) {
        const ts = new Date().toLocaleString('pt-BR', { hour12: false });
        const line = `[${ts}] ${message}`;
        console.log(line);
        if (this.logPath) {
            try { fs.appendFileSync(this.logPath, line + '\n', 'utf8'); } catch {}
        }
    }

    _checkNetwork() {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(2000);
            socket.on('connect', () => { socket.destroy(); resolve(true); });
            socket.on('error',   () => { socket.destroy(); resolve(false); });
            socket.on('timeout', () => { socket.destroy(); resolve(false); });
            socket.connect(53, '8.8.8.8');
        });
    }

    _parseFFmpegError(lines) {
        const text = lines.join(' ').toLowerCase();
        if (text.includes('connection timed out') || text.includes('timed out')) return 'connection timed out';
        if (text.includes('connection refused'))   return 'connection refused';
        if (text.includes('connection reset'))     return 'connection reset';
        if (text.includes('broken pipe'))          return 'broken pipe';
        if (text.includes('network unreachable'))  return 'network unreachable';
        if (text.includes('no route to host'))     return 'no route to host';
        if (text.includes('eof') || text.includes('end of file')) return 'disconnected (EOF)';
        if (text.includes('rtmp'))                 return 'RTMP error';
        if (text.includes('error'))                return 'erro desconhecido';
        return 'desconectado';
    }

    setStreamingBlocked(blocked) {
        this.streamingBlocked = !!blocked;
        if (this.streamingBlocked) {
            // Mata writers ativos se existirem
            for (const [name, writer] of Object.entries(this.writerProcesses)) {
                if (writer) writer.kill('SIGKILL');
            }
            this.writerProcesses = {};
        }
        console.log(`[StreamDelay] Streaming ${this.streamingBlocked ? 'BLOQUEADO' : 'liberado'}`);
    }

    start() {
        const config = {
            rtmp: {
                port: 1935,
                chunk_size: 60000,
                gop_cache: true,
                ping: 30,
                ping_timeout: 60
            }
        };

        this.nms = new NodeMediaServer(config);
        this.nms.run();

        Context.eventEmitter.on('prePublish', (id, streamPath, args) => {
            let sp = typeof id === 'object' && id.streamPath ? id.streamPath : streamPath;
            if (!sp) return;

            console.log(`[StreamDelay] Stream recebida: ${sp}`);
            this._writeLog(`▶ Stream iniciada (OBS conectou)`);
            this.currentStreamPath = sp;
            this.connected = true;
            this.startTime = Date.now();
            this.emit('status', this.getStatus());

            this._startPipeline(sp);
            this._startStatsReporting();
        });

        Context.eventEmitter.on('donePublish', (id, streamPath, args) => {
            let sp = typeof id === 'object' && id.streamPath ? id.streamPath : streamPath;
            if (!sp) return;

            console.log(`[StreamDelay] Stream encerrada: ${sp}`);
            this._writeLog(`■ Stream encerrada (OBS desconectou)`);
            if (this.currentStreamPath === sp) {
                this.connected = false;
                this.currentStreamPath = null;
                this.startTime = null;
                this._stopPipeline();

                if (this.statsInterval) clearInterval(this.statsInterval);
                this.emit('status', this.getStatus());
            }
        });
    }

    setPlatformKey(platform, key) {
        if (this.platforms[platform]) {
            this.platforms[platform].key = key;
            console.log(`[StreamDelay] ${platform} key atualizada`);
        }
        return { success: true };
    }

    setPlatformServer(platform, serverKey) {
        if (this.platforms[platform]) {
            const url = platform === 'twitch' ? TWITCH_SERVERS[serverKey] : null;
            if (url) {
                this.platforms[platform].server = url;
                console.log(`[StreamDelay] ${platform} servidor: ${url}`);
            }
        }
        return { success: true };
    }

    setPlatformEnabled(platform, enabled) {
        if (this.platforms[platform]) {
            this.platforms[platform].enabled = enabled;
            console.log(`[StreamDelay] ${platform}: ${enabled ? 'ATIVADO' : 'DESATIVADO'}`);
        }
        return { success: true };
    }

    stopPlatform(platform) {
        if (!this.platforms[platform]) return { success: false };
        this.platforms[platform].manuallyStopped = true;
        this.platforms[platform].persistentReconnect = false;
        if (this.writerProcesses[platform]) {
            this.writerProcesses[platform].kill('SIGKILL');
            // o handler 'close' vai remover de writerProcesses
        }
        console.log(`[StreamDelay] ${platform} parado manualmente`);
        this.emit('status', this.getStatus());
        return { success: true };
    }

    startPlatform(platform) {
        if (!this.platforms[platform]) return { success: false };
        if (!this.connected) {
            this.emit('status', { ...this.getStatus(), writerError: 'OBS não conectado — inicie a transmissão no OBS primeiro' });
            return { success: false, error: 'Stream não ativa' };
        }
        const p = this.platforms[platform];
        if (!p.key) return { success: false, error: 'Stream key não configurada' };
        p.manuallyStopped = false;
        p.failCount = 0;
        p.persistentReconnect = true;
        if (this._reconnectTimers[platform]) {
            clearTimeout(this._reconnectTimers[platform]);
            delete this._reconnectTimers[platform];
        }
        // Reader temporário: fornece MPEGTS fresco para esta plataforma sem afetar as outras
        this._startTempReader(platform);
        console.log(`[StreamDelay] ${platform} iniciado manualmente`);
        this.emit('status', this.getStatus());
        return { success: true };
    }

    // Inicia um reader temporário para uma plataforma individual.
    // Fornece MPEGTS fresco do OBS por 5s → plataforma ativa o broadcast.
    // Após 5s o reader temporário é destruído e o reader compartilhado assume.
    _startTempReader(platform) {
        if (!this.connected || !this.currentStreamPath) return;
        const p = this.platforms[platform];
        if (!p || !p.key) return;

        // Mata temp reader anterior desta plataforma (se existir)
        if (this._tempReaders[platform]) {
            this._tempReaders[platform].kill('SIGKILL');
            delete this._tempReaders[platform];
        }
        // Mata writer existente desta plataforma
        if (this.writerProcesses[platform]) {
            this.writerProcesses[platform].kill('SIGKILL');
            delete this.writerProcesses[platform];
        }

        this._stderrBuffers[platform] = [];

        const ffmpeg   = this._findFFmpeg();
        const inputUrl = `rtmp://127.0.0.1:1935${this.currentStreamPath}`;
        const output   = { name: platform, url: `${p.server}${p.key}`, stableMode: p.stableMode };

        // Reader temporário: conexão limpa com o OBS → MPEGTS fresco com headers corretos
        const tempReader = spawn(ffmpeg, [
            '-rw_timeout', '10000000',
            '-i', inputUrl,
            '-c', 'copy',
            '-f', 'mpegts',
            '-flush_packets', '1',
            'pipe:1',
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        this._tempReaders[platform] = tempReader;
        console.log(`[StreamDelay] TempReader ${platform} iniciado`);

        tempReader.stderr.on('data', () => {});
        tempReader.on('error', () => {});
        tempReader.on('close', () => {
            if (this._tempReaders[platform] === tempReader) delete this._tempReaders[platform];
        });

        // Writer desta plataforma (args idênticos ao spawnWriter normal)
        const isKick    = platform === 'kick';
        const isTwitch  = platform === 'twitch';
        const isYoutube = platform === 'youtube';

        const writerArgs = [
            '-rw_timeout', '15000000',
            '-hwaccel', 'cuda',
            '-fflags', '+genpts+discardcorrupt',
            '-f', 'mpegts',
            '-i', 'pipe:0',
            '-map', '0:v:0', '-map', '0:a:0',
            '-c:v', 'h264_nvenc',
            ...(isKick    ? ['-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k', '-bf', '0', '-g', '60', '-pix_fmt', 'yuv420p'] : []),
            ...(isTwitch  ? ['-b:v', '8000k', '-maxrate', '8000k', '-bufsize', '16000k', '-bf', '0', '-g', '60', '-pix_fmt', 'yuv420p'] : []),
            ...(isYoutube ? ['-b:v', '8000k', '-maxrate', '8000k', '-bufsize', '16000k', '-bf', '0', '-g', '60', '-pix_fmt', 'yuv420p'] : []),
            '-bsf:v', 'setts=pts=PTS-STARTPTS:dts=PTS-STARTPTS',
            '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
            '-af', 'aresample=async=1:first_pts=0',
            '-f', 'flv', '-flvflags', 'no_duration_filesize',
            output.url
        ];

        const writer = spawn(ffmpeg, writerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
        let inTempPhase = true;

        let writerBuf = '';
        writer.stderr.on('data', (data) => {
            writerBuf += data.toString();
            const lines = writerBuf.split('\n');
            writerBuf = lines.pop();
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const buf = this._stderrBuffers[platform];
                if (buf) { buf.push(trimmed); if (buf.length > 10) buf.shift(); }
                if (trimmed.match(/error|failed|refused|timeout|connection|rtmp|broken|eof/i)) {
                    console.error(`[${platform}] ${trimmed}`);
                }
            }
        });
        writer.stdin.on('error', (e) => {
            if (e.code !== 'EPIPE') console.error(`[StreamDelay] ${platform} stdin: ${e.message}`);
        });
        writer.on('error', (e) => console.error(`[StreamDelay] ${platform} erro: ${e.message}`));
        writer.on('close', async (code) => {
            inTempPhase = false;
            console.log(`[StreamDelay] ${platform} encerrado (code=${code})`);
            if (this.writerProcesses[platform] === writer) delete this.writerProcesses[platform];

            if (!this.connected || this.platforms[platform]?.manuallyStopped) {
                delete this._stderrBuffers[platform];
                this.emit('status', this.getStatus());
                return;
            }

            const stderrLines = this._stderrBuffers[platform] || [];
            const reason = this._parseFFmpegError(stderrLines);
            const online = await this._checkNetwork();
            if (stderrLines.length > 0) this._writeLog(`⚠ ${platform} stderr: ${stderrLines.slice(-3).join(' | ')}`);
            this._writeLog(`⚠ ${platform} caiu — ${reason} | Rede: ${online ? 'ONLINE' : 'OFFLINE'}`);
            this.emit('status', { ...this.getStatus(), writerError: `${platform}: ${reason} | rede ${online ? 'online' : 'offline'}` });

            delete this._stderrBuffers[platform];

            this.platforms[platform].failCount = (this.platforms[platform].failCount || 0) + 1;
            if (this.platforms[platform].failCount >= 3 && !this.platforms[platform].persistentReconnect) {
                this.platforms[platform].manuallyStopped = true;
                this.platforms[platform].failCount = 0;
                this._writeLog(`⚠ ${platform} parou após 3 tentativas — clique Iniciar para tentar novamente`);
                this.emit('status', this.getStatus());
                return;
            }

            // Reconecta usando temp reader para garantir MPEGTS fresco
            this._writeLog(`↺ ${platform} reconectando em 3s (reader temporário)...`);
            if (this._reconnectTimers[platform]) clearTimeout(this._reconnectTimers[platform]);
            this._reconnectTimers[platform] = setTimeout(() => {
                delete this._reconnectTimers[platform];
                if (this.connected && !this.platforms[platform]?.manuallyStopped) {
                    this._startTempReader(platform);
                }
            }, 3000);

            this.emit('status', this.getStatus());
        });

        // Temp reader alimenta o writer diretamente durante a fase inicial
        tempReader.stdout.on('data', (chunk) => {
            if (inTempPhase && writer.stdin.writable) {
                writer.stdin.write(chunk);
            }
        });

        // Após 5s: destrói temp reader, writer passa para o reader compartilhado
        setTimeout(() => {
            inTempPhase = false;
            if (this._tempReaders[platform] === tempReader) {
                tempReader.kill('SIGKILL');
                delete this._tempReaders[platform];
            }
            if (writer.exitCode === null && !this.writerProcesses[platform]) {
                this.writerProcesses[platform] = writer;
                this._writeLog(`↺ ${platform} ativo — reader compartilhado assumiu`);
                this.emit('status', this.getStatus());
            }
        }, 5000);
    }

    setPlatformStableMode(platform, enabled) {
        if (this.platforms[platform]) {
            this.platforms[platform].stableMode = !!enabled;
            console.log(`[StreamDelay] ${platform} modo estável: ${enabled ? 'ATIVADO' : 'DESATIVADO'}`);
        }
        return { success: true };
    }

    setDelay(seconds) {
        const oldDelay = this.delay;
        let parsed = parseInt(seconds);
        if (isNaN(parsed)) parsed = 0;
        this.delay = Math.max(0, Math.min(300, parsed));
        console.log(`[StreamDelay] Delay: ${oldDelay}s → ${this.delay}s`);

        if (!this.connected || Object.keys(this.writerProcesses).length === 0) {
            return { delay: this.delay, success: true };
        }

        if (oldDelay === 0 && this.delay > 0) {
            // LIVE → DELAY: inicia bufferização, mantém live por N segundos
            console.log(`[StreamDelay] Transição LIVE → ${this.delay}s delay`);
            this.buffer = [];
            this.sentUntil = 0;
            this.drainStart = 0;
            this.bufferTransition = true;
            this.transitionStartTime = Date.now();

        } else if (oldDelay > 0 && this.delay === 0) {
            // DELAY → LIVE: corte imediato para ao vivo
            console.log(`[StreamDelay] Corte para LIVE!`);
            this.buffer = [];
            this.sentUntil = 0;
            this.drainStart = 0;
            this.isBuffering = false;
            this.bufferTransition = false;
            this.transitionStartTime = null;

        } else if (oldDelay > 0 && this.delay > 0) {
            // DELAY → DELAY (aumentar ou diminuir):
            // Reposiciona sentUntil para o novo delay.
            // Como o buffer mantém 310s, os dados já estão lá — sem queda de conexão.
            const newSentUntil = Date.now() - (this.delay * 1000);
            console.log(`[StreamDelay] Reposicionando: ${oldDelay}s → ${this.delay}s (sentUntil ajustado)`);
            this.sentUntil = newSentUntil;
            this.drainStart = 0; // reseta índice para o drain encontrar a posição certa
        }

        return { delay: this.delay, success: true };
    }

    setMode(mode) {
        this.mode = mode;
        return { mode: this.mode, success: true };
    }

    _findFFmpeg() {
        // App instalado: usa ffmpeg bundled nos resources
        try {
            const bundled = require('path').join(process.resourcesPath, 'ffmpeg.exe');
            if (require('fs').existsSync(bundled)) return bundled;
        } catch {}
        // Dev / fallback: usa ffmpeg do sistema
        return os.platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    }

    _getEnabledOutputs() {
        const outputs = [];
        if (this.platforms.twitch.enabled && this.platforms.twitch.key) {
            outputs.push({
                name: 'twitch',
                url: `${this.platforms.twitch.server}${this.platforms.twitch.key}`,
                stableMode: this.platforms.twitch.stableMode
            });
        }
        if (this.platforms.youtube.enabled && this.platforms.youtube.key) {
            outputs.push({
                name: 'youtube',
                url: `${this.platforms.youtube.server}${this.platforms.youtube.key}`,
                stableMode: this.platforms.youtube.stableMode
            });
        }
        if (this.platforms.kick.enabled && this.platforms.kick.key) {
            outputs.push({
                name: 'kick',
                url: `${this.platforms.kick.server}${this.platforms.kick.key}`,
                stableMode: this.platforms.kick.stableMode
            });
        }
        return outputs;
    }

    _startPipeline(streamPath) {
        if (this.streamingBlocked) {
            this.emit('status', { connected: true, error: 'Assine o Tapa Delay para transmitir' });
            return;
        }
        const outputs = this._getEnabledOutputs();
        if (outputs.length === 0) {
            this.emit('status', { connected: true, error: 'Configure pelo menos uma stream key na aba Setup' });
            return;
        }

        const ffmpeg = this._findFFmpeg();
        this._stopPipeline();

        const inputUrl = `rtmp://127.0.0.1:1935${streamPath}`;
        console.log(`[StreamDelay] Pipeline iniciando`);
        console.log(`[StreamDelay] IN:  ${inputUrl}`);
        outputs.forEach(o => console.log(`[StreamDelay] OUT: ${o.name} → ${o.url}`));

        // READER: recebe RTMP do OBS e converte para MPEGTS (copia tudo sem re-encodar)
        this.readerProcess = spawn(ffmpeg, [
            '-rw_timeout', '10000000',
            '-i', inputUrl,
            '-c', 'copy',
            '-f', 'mpegts',
            '-flush_packets', '1',
            'pipe:1',
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        this.readerProcess.stderr.on('data', () => {});
        this.readerProcess.on('error', (e) => console.error(`[StreamDelay] Reader erro: ${e.message}`));
        this.readerProcess.on('close', async (code) => {
            console.log(`[StreamDelay] Reader encerrado (${code})`);
            if (code !== 0 && this.connected) {
                const online = await this._checkNetwork();
                this._writeLog(`⚠ Reader caiu (code=${code}) | Rede: ${online ? 'ONLINE' : 'OFFLINE'} — possível queda do OBS ou rede`);
            }
            this.readerProcess = null;
        });

        // WRITERS: um FFmpeg por plataforma, com auto-reconexão
        const spawnWriter = (output) => {
            if (!this.connected) return;
            // Guard: nunca spawna dois writers para a mesma plataforma
            if (this.writerProcesses[output.name]) {
                console.log(`[StreamDelay] Writer ${output.name} já existe, ignorando spawn duplicado`);
                return;
            }
            // Cancela qualquer timer de reconexão pendente para esta plataforma
            if (this._reconnectTimers[output.name]) {
                clearTimeout(this._reconnectTimers[output.name]);
                delete this._reconnectTimers[output.name];
            }
            this._stderrBuffers[output.name] = [];

            const isKick    = output.name === 'kick';
            const isTwitch  = output.name === 'twitch';
            const isYoutube = output.name === 'youtube';

            const writerArgs = [
                '-rw_timeout', '15000000',
                // Todas as plataformas usam NVDEC para decode — evita saturar a CPU com software decode
                // de 3 streams h264 simultâneos (causaria queda para ~20fps).
                '-hwaccel', 'cuda',
                '-fflags', '+genpts+discardcorrupt',
                '-f', 'mpegts',
                '-i', 'pipe:0',
            ];
            writerArgs.push(
                '-map', '0:v:0',
                '-map', '0:a:0',
                // Todas as plataformas re-encodam com nvenc para garantir keyframe interval correto (-g 60).
                // YouTube em copy mode recebia keyframe a cada 6s mesmo com OBS em 2s — copy não garante
                // o marking correto de keyframes no FLV de saída. Re-encode resolve definitivamente.
                '-c:v', 'h264_nvenc',
                // -bf 0: desativa B-frames (evita DTS não-monotônico que quebra o RTMP)
                // -g 60: keyframe a cada 60 frames (1s@60fps / 2s@30fps)
                // -pix_fmt yuv420p: formato correto esperado pelo ingest das plataformas
                ...(isKick    ? ['-b:v', '6000k',  '-maxrate', '6000k',  '-bufsize', '12000k', '-bf', '0', '-g', '60', '-pix_fmt', 'yuv420p'] : []),
                ...(isTwitch  ? ['-b:v', '8000k',  '-maxrate', '8000k',  '-bufsize', '16000k', '-bf', '0', '-g', '60', '-pix_fmt', 'yuv420p'] : []),
                ...(isYoutube ? ['-b:v', '8000k',  '-maxrate', '8000k',  '-bufsize', '16000k', '-bf', '0', '-g', '60', '-pix_fmt', 'yuv420p'] : []),
                // setts zera timestamps após RECONECTAR (necessário para copy e NVENC)
                '-bsf:v', 'setts=pts=PTS-STARTPTS:dts=PTS-STARTPTS',
                '-c:a', 'aac',
                '-b:a', '160k',
                '-ar', '48000',
                '-ac', '2',
                '-af', 'aresample=async=1:first_pts=0',
                '-f', 'flv',
                '-flvflags', 'no_duration_filesize',
                output.url
            );

            const writer = spawn(ffmpeg, writerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

            let writerAlive = true;
            let writerBuf = '';
            writer.stderr.on('data', (data) => {
                writerBuf += data.toString();
                const lines = writerBuf.split('\n');
                writerBuf = lines.pop();
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    // Rolling buffer: mantém últimas 10 linhas por writer
                    const buf = this._stderrBuffers[output.name];
                    if (buf) {
                        buf.push(trimmed);
                        if (buf.length > 10) buf.shift();
                    }
                    if (trimmed.match(/error|failed|refused|timeout|connection|rtmp|broken|eof/i)) {
                        console.error(`[${output.name}] ${trimmed}`);
                    }
                }
            });
            writer.stdin.on('error', (e) => {
                if (e.code !== 'EPIPE') console.error(`[StreamDelay] ${output.name} stdin: ${e.message}`);
            });
            writer.on('error', (e) => console.error(`[StreamDelay] ${output.name} erro: ${e.message}`));
            writer.on('close', async (code) => {
                writerAlive = false;
                console.log(`[StreamDelay] ${output.name} encerrado (code=${code})`);
                delete this.writerProcesses[output.name];

                const unexpected = this.connected && !this.platforms[output.name]?.manuallyStopped;

                if (unexpected) {
                    const stderrLines = this._stderrBuffers[output.name] || [];
                    const reason  = this._parseFFmpegError(stderrLines);
                    const online  = await this._checkNetwork();
                    const netStr  = online ? 'ONLINE' : 'OFFLINE';
                    // Loga últimas linhas do stderr para diagnóstico
                    if (stderrLines.length > 0) {
                        this._writeLog(`⚠ ${output.name} stderr: ${stderrLines.slice(-3).join(' | ')}`);
                    }
                    this._writeLog(`⚠ ${output.name} caiu — ${reason} | Rede: ${netStr}`);
                    this.emit('status', { ...this.getStatus(), writerError: `${output.name}: ${reason} | rede ${netStr.toLowerCase()}` });

                    // Conta falhas consecutivas — após 3, para sempre (sem loop)
                    // O usuário pode clicar Reconectar quando quiser (reseta o contador)
                    this.platforms[output.name].failCount = (this.platforms[output.name].failCount || 0) + 1;
                    if (this.platforms[output.name].failCount >= 3 && !this.platforms[output.name].persistentReconnect) {
                        this.platforms[output.name].manuallyStopped = true;
                        this.platforms[output.name].failCount = 0;
                        this._writeLog(`⚠ ${output.name} parou após 3 tentativas — clique Reconectar para tentar novamente`);
                        delete this._stderrBuffers[output.name];
                        this.emit('status', this.getStatus());
                        return;
                    }
                }

                delete this._stderrBuffers[output.name];

                // Auto-reconexão se stream ainda ativa E não foi parado manualmente
                // Skip se já existe um temp reader ativo para esta plataforma (evita spawn duplo)
                if (this.connected && !this.platforms[output.name]?.manuallyStopped && !this._tempReaders[output.name]) {
                    this._writeLog(`↺ ${output.name} reconectando em 3s...`);
                    // Cancela timer anterior se existir (evita spawn duplo)
                    if (this._reconnectTimers[output.name]) {
                        clearTimeout(this._reconnectTimers[output.name]);
                    }
                    this._reconnectTimers[output.name] = setTimeout(() => {
                        delete this._reconnectTimers[output.name];
                        if (this.connected && !this.platforms[output.name]?.manuallyStopped) spawnWriter(output);
                    }, 3000);
                }
                this.emit('status', this.getStatus());
            });

            // Pré-roll com velocidade real: envia os últimos 2s do buffer no ritmo original.
            // Garante keyframe para o decoder antes do fluxo ao vivo, sem rajada de dados.
            const baseTime = this.delay > 0 ? this.sentUntil : Date.now();
            const prerollFrom = baseTime - 2000;
            const prerollChunks = this.buffer.filter(p => p.time >= prerollFrom && p.time <= baseTime);

            const activateWriter = () => {
                if (writerAlive && !this.writerProcesses[output.name]) {
                    this.writerProcesses[output.name] = writer;
                    console.log(`[StreamDelay] ✓ Writer ${output.name} iniciado`);
                    this.emit('status', this.getStatus());
                }
            };

            if (prerollChunks.length > 1) {
                const t0 = prerollChunks[0].time;
                prerollChunks.forEach(chunk => {
                    setTimeout(() => {
                        if (writer.stdin && writer.stdin.writable) writer.stdin.write(chunk.data);
                    }, chunk.time - t0);
                });
                const prerollDuration = prerollChunks[prerollChunks.length - 1].time - t0;
                console.log(`[StreamDelay] ${output.name} pré-roll: ${prerollChunks.length} chunks (~${Math.round(prerollDuration / 1000)}s)`);
                setTimeout(activateWriter, prerollDuration + 100);
            } else {
                activateWriter();
            }
        };

        // Guarda referência para permitir startPlatform() em qualquer momento
        this._spawnWriter = spawnWriter;

        // Writers só iniciam quando o reader tiver dados reais
        // Evita o bug do YouTube "Preparando transmissão" sem vídeo
        let writersStarted = false;

        // CONTROLADOR DE FLUXO
        this.readerProcess.stdout.on('data', (chunk) => {
            this.bytesIn += chunk.length;
            const buf = Buffer.from(chunk);
            const now = Date.now();

            // Inicia writers apenas na primeira chegada de dados
            if (!writersStarted) {
                writersStarted = true;
                console.log(`[StreamDelay] Reader com dados — iniciando writers`);
                for (const output of outputs) spawnWriter(output);
                // Notifica o frontend que os writers estão ativos
                setTimeout(() => this.emit('status', this.getStatus()), 200);
            }

            // SEMPRE bufferiza — mantém 310s de histórico para mudanças de delay
            this.buffer.push({ data: buf, time: now });
            const cutoff = now - MAX_BUFFER_MS;
            while (this.buffer.length > 0 && this.buffer[0].time < cutoff) {
                this.buffer.shift();
                if (this.drainStart > 0) this.drainStart--;
            }

            if (this.delay === 0 && !this.bufferTransition && !this.isBuffering) {
                // MODO LIVE: passthrough direto
                this._writeToOutputs(buf);

            } else if (this.bufferTransition) {
                // TRANSIÇÃO 0→N: envia ao vivo E bufferiza simultaneamente
                this._writeToOutputs(buf);

                const elapsed = now - this.transitionStartTime;
                if (elapsed >= this.delay * 1000) {
                    console.log(`[StreamDelay] Delay ${this.delay}s ativo!`);
                    this.bufferTransition = false;
                    this.isBuffering = true;
                    this.transitionStartTime = null;
                    // Posiciona sentUntil no ponto certo do buffer
                    this.sentUntil = now - (this.delay * 1000);
                    this.drainStart = 0;
                }
            }
            // isBuffering=true: drain cuida de enviar com delay
        });

        // DRAIN: envia pacotes do buffer baseado em sentUntil + delay atual
        this.drainInterval = setInterval(() => {
            if (!this.isBuffering || Object.keys(this.writerProcesses).length === 0) return;
            if (this.delay === 0) return;

            const now = Date.now();
            const targetTime = now - (this.delay * 1000);

            // Avança drainStart até o primeiro pacote ainda não enviado
            while (this.drainStart < this.buffer.length &&
                   this.buffer[this.drainStart].time <= this.sentUntil) {
                this.drainStart++;
            }

            // Envia todos os pacotes entre sentUntil e targetTime
            for (let i = this.drainStart; i < this.buffer.length; i++) {
                const pkt = this.buffer[i];
                if (pkt.time > targetTime) break; // muito recente
                this._writeToOutputs(pkt.data);
                this.sentUntil = pkt.time;
                this.drainStart = i + 1;
            }
        }, 30);

        console.log(`[StreamDelay] Pipeline ativo! Delay: ${this.delay}s | Saídas: ${outputs.map(o => o.name).join(', ')}`);
    }

    _writeToOutputs(data) {
        for (const [name, writer] of Object.entries(this.writerProcesses)) {
            if (writer && writer.stdin.writable) {
                try {
                    writer.stdin.write(data);
                } catch (e) { /* ignore */ }
            }
        }
        this.bytesOut += data.length;
    }

    stop() {
        this._stopPipeline();
        if (this.statsInterval) clearInterval(this.statsInterval);
        return new Promise((resolve) => {
            try { if (this.nms) { this.nms.stop(); this.nms = null; } } catch {}
            setTimeout(resolve, 800); // aguarda OS liberar porta 1935
        });
    }

    _stopPipeline() {
        if (this.drainInterval) clearInterval(this.drainInterval);
        for (const [name, timer] of Object.entries(this._reconnectTimers)) {
            clearTimeout(timer);
        }
        this._reconnectTimers = {};
        this._spawnWriter = null;

        // Mata todos os readers temporários
        for (const [name, tempReader] of Object.entries(this._tempReaders)) {
            if (tempReader) tempReader.kill('SIGKILL');
        }
        this._tempReaders = {};

        if (this.readerProcess) {
            this.readerProcess.kill('SIGKILL');
            this.readerProcess = null;
        }

        for (const [name, writer] of Object.entries(this.writerProcesses)) {
            if (writer) writer.kill('SIGKILL');
        }
        this.writerProcesses = {};
        this.buffer = [];
        this.sentUntil = 0;
        this.drainStart = 0;
        this.isBuffering = false;
        this.bufferTransition = false;
        this.transitionStartTime = null;

        // Reseta flags ao encerrar a stream
        for (const p of Object.values(this.platforms)) {
            p.manuallyStopped = false;
            p.failCount = 0;
            p.persistentReconnect = false;
        }
    }

    _startStatsReporting() {
        if (this.statsInterval) clearInterval(this.statsInterval);

        let lastIn = this.bytesIn;
        let lastOut = this.bytesOut;

        this.statsInterval = setInterval(() => {
            const now = Date.now();
            const inRate = ((this.bytesIn - lastIn) / 1024) * 8;
            const outRate = ((this.bytesOut - lastOut) / 1024) * 8;

            lastIn = this.bytesIn;
            lastOut = this.bytesOut;

            const uptime = this.startTime ? Math.floor((now - this.startTime) / 1000) : 0;

            this.emit('stats', {
                inKbps: Math.round(inRate),
                outKbps: Math.round(outRate),
                bufferSize: Math.round(this.buffer.length * 60000 / 1024 / 1024),
                uptime: uptime
            });
        }, 1000);
    }

    getStatus() {
        const writers = {};
        for (const name of Object.keys(this.platforms)) {
            writers[name] = {
                active: !!this.writerProcesses[name],
                manuallyStopped: this.platforms[name].manuallyStopped
            };
        }
        return {
            connected: this.connected,
            delay: this.delay,
            mode: this.mode,
            platforms: this.platforms,
            writers
        };
    }
}

module.exports = { StreamDelayServer };
