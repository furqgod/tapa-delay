// ===== StreamDelay BR - RTMP Server + Delay Engine v5 (VirtualSubscriber per-platform) =====
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
const KICK_SERVER    = 'rtmps://fa723fc1b171.global-contribute.live-video.net/app/';
const MAX_BUFFER_MS  = 310000;

// Subscriber virtual — recebe FLV do NMS sem processo FFmpeg reader.
class VirtualSubscriber {
    constructor(onData) {
        this.id       = Date.now().toString(36) + Math.random().toString(36).slice(2);
        this.protocol = 'flv';
        this.ip       = '';
        this._onData  = onData;
    }
    sendBuffer(buffer) { this._onData(buffer); }
    close() {}
}

class StreamDelayServer extends EventEmitter {
    constructor() {
        super();
        this.nms               = null;
        this.delay             = 0;
        this.mode              = 'normal';
        this.connected         = false;
        this.currentStreamPath = null;
        this.statsInterval     = null;
        this.startTime         = null;

        this.platforms = {
            twitch:  { enabled: true,  key: '', server: TWITCH_SERVERS.sa_east, stableMode: true,  manuallyStopped: false, failCount: 0, persistentReconnect: false },
            youtube: { enabled: false, key: '', server: YOUTUBE_SERVER,          stableMode: true,  manuallyStopped: false, failCount: 0, persistentReconnect: false },
            kick:    { enabled: false, key: '', server: KICK_SERVER,             stableMode: true,  manuallyStopped: false, failCount: 0, persistentReconnect: false },
        };

        this.virtualSubscribers = {};
        this._spawnWriters      = {};
        this._reconnectTimers   = {};
        this._resetPending      = false; // evita resets simultâneos

        this.buffers              = {};
        this.sentUntils           = {};
        this.drainStarts          = {};
        this.drainIntervals       = {};
        this.isBufferings         = {};
        this.bufferTransitions    = {};
        this.transitionStartTimes = {};

        this.writerProcesses = {};
        this.bytesIn  = 0;
        this.bytesOut = 0;

        this.streamingBlocked = false;
        this.logPath          = null;
        this._stderrBuffers   = {};
    }

    setLogPath(p) {
        this.logPath = p;
        this._writeLog('════════════════════════════════');
        this._writeLog('▶  Tapa Delay iniciado');
        this._writeLog('════════════════════════════════');
    }

    _writeLog(message) {
        const ts   = new Date().toLocaleString('pt-BR', { hour12: false });
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
            for (const [, writer] of Object.entries(this.writerProcesses)) {
                if (writer) writer.kill('SIGKILL');
            }
            this.writerProcesses = {};
        }
        console.log(`[StreamDelay] Streaming ${this.streamingBlocked ? 'BLOQUEADO' : 'liberado'}`);
    }

    // Reinicia o pipeline completo internamente (sem precisar reiniciar o OBS).
    // Usado quando uma plataforma não activa após 10s — equivale a reiniciar o OBS.
    _scheduleReset(platform) {
        if (this._resetPending) return;
        this._resetPending = true;
        const streamPath = this.currentStreamPath;
        this._writeLog(`↺ ${platform} sem frames após 10s — reiniciando pipeline em 3s (todas as plataformas)`);

        setTimeout(() => {
            if (!this.connected || this.currentStreamPath !== streamPath) {
                this._resetPending = false;
                return;
            }
            this._writeLog(`↺ Pipeline reiniciando — reconectando todas as plataformas`);
            this._stopPipeline();

            setTimeout(() => {
                if (this.connected && this.currentStreamPath === streamPath) {
                    this._startPipeline(streamPath);
                }
                // Mantém resetPending por 45s para evitar loop — dá tempo aos writers arrancarem
                setTimeout(() => { this._resetPending = false; }, 45000);
            }, 5000);
        }, 3000);
    }

    start() {
        const config = { rtmp: { port: 1935, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 } };
        this.nms = new NodeMediaServer(config);
        this.nms.run();

        Context.eventEmitter.on('prePublish', (id, streamPath) => {
            let sp = typeof id === 'object' && id.streamPath ? id.streamPath : streamPath;
            if (!sp) return;
            this._writeLog(`▶ Stream iniciada (OBS conectou)`);
            this.currentStreamPath = sp;
            this.connected         = true;
            this.startTime         = Date.now();
            this.emit('status', this.getStatus());
            this._startPipeline(sp);
            this._startStatsReporting();
        });

        Context.eventEmitter.on('donePublish', (id, streamPath) => {
            let sp = typeof id === 'object' && id.streamPath ? id.streamPath : streamPath;
            if (!sp) return;
            this._writeLog(`■ Stream encerrada (OBS desconectou)`);
            if (this.currentStreamPath === sp) {
                this.connected         = false;
                this.currentStreamPath = null;
                this.startTime         = null;
                this._stopPipeline();
                if (this.statsInterval) clearInterval(this.statsInterval);
                this.emit('status', this.getStatus());
            }
        });
    }

    setPlatformKey(platform, key) {
        if (this.platforms[platform]) this.platforms[platform].key = key;
        return { success: true };
    }
    setPlatformServer(platform, serverKey) {
        if (this.platforms[platform]) {
            const url = platform === 'twitch' ? TWITCH_SERVERS[serverKey] : null;
            if (url) this.platforms[platform].server = url;
        }
        return { success: true };
    }
    setPlatformEnabled(platform, enabled) {
        if (this.platforms[platform]) this.platforms[platform].enabled = enabled;
        return { success: true };
    }
    setPlatformStableMode(platform, enabled) {
        if (this.platforms[platform]) this.platforms[platform].stableMode = !!enabled;
        return { success: true };
    }

    stopPlatform(platform) {
        if (!this.platforms[platform]) return { success: false };
        this.platforms[platform].manuallyStopped = true;
        this.platforms[platform].persistentReconnect = false;
        this._unsubscribePlatform(platform);
        if (this.writerProcesses[platform]) this.writerProcesses[platform].kill('SIGKILL');
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
        p.failCount       = 0;
        p.persistentReconnect = true;
        if (this._reconnectTimers[platform]) {
            clearTimeout(this._reconnectTimers[platform]);
            delete this._reconnectTimers[platform];
        }
        this._restartPlatform(platform);
        console.log(`[StreamDelay] ${platform} iniciado manualmente`);
        this.emit('status', this.getStatus());
        return { success: true };
    }

    _unsubscribePlatform(platform) {
        const vs = this.virtualSubscribers[platform];
        if (vs && this.currentStreamPath) {
            const broadcast = Context.broadcasts.get(this.currentStreamPath);
            if (broadcast) broadcast.subscribers.delete(vs.id);
        }
        delete this.virtualSubscribers[platform];
    }

    _restartPlatform(platform) {
        if (!this.connected || !this.currentStreamPath) return;
        const p = this.platforms[platform];
        if (!p || !p.key) return;

        this._unsubscribePlatform(platform);
        if (this.writerProcesses[platform]) {
            this.writerProcesses[platform].kill('SIGKILL');
            delete this.writerProcesses[platform];
        }
        this.buffers[platform]              = [];
        this.sentUntils[platform]           = 0;
        this.drainStarts[platform]          = 0;
        this.isBufferings[platform]         = false;
        this.bufferTransitions[platform]    = false;
        this.transitionStartTimes[platform] = null;
        if (this.drainIntervals[platform]) {
            clearInterval(this.drainIntervals[platform]);
            delete this.drainIntervals[platform];
        }
        const output = { name: platform, url: `${p.server}${p.key}`, stableMode: p.stableMode };
        this._startPlatformPipeline(output);
    }

    setDelay(seconds) {
        const oldDelay = this.delay;
        let parsed = parseInt(seconds);
        if (isNaN(parsed)) parsed = 0;
        this.delay = Math.max(0, Math.min(300, parsed));
        console.log(`[StreamDelay] Delay: ${oldDelay}s → ${this.delay}s`);

        const hasWriters = Object.keys(this.writerProcesses).length > 0;
        if (!this.connected || !hasWriters) return { delay: this.delay, success: true };

        const active = Object.keys(this.buffers);

        if (oldDelay === 0 && this.delay > 0) {
            for (const name of active) {
                this.buffers[name]              = [];
                this.sentUntils[name]           = 0;
                this.drainStarts[name]          = 0;
                this.bufferTransitions[name]    = true;
                this.transitionStartTimes[name] = Date.now();
            }
        } else if (oldDelay > 0 && this.delay === 0) {
            for (const name of active) {
                this.buffers[name]              = [];
                this.sentUntils[name]           = 0;
                this.drainStarts[name]          = 0;
                this.isBufferings[name]         = false;
                this.bufferTransitions[name]    = false;
                this.transitionStartTimes[name] = null;
            }
        } else if (oldDelay > 0 && this.delay > 0) {
            const newSentUntil = Date.now() - (this.delay * 1000);
            for (const name of active) {
                this.sentUntils[name]  = newSentUntil;
                this.drainStarts[name] = 0;
            }
        }
        return { delay: this.delay, success: true };
    }

    setMode(mode) { this.mode = mode; return { mode: this.mode, success: true }; }

    _findFFmpeg() {
        try {
            const bundled = require('path').join(process.resourcesPath, 'ffmpeg.exe');
            if (require('fs').existsSync(bundled)) return bundled;
        } catch {}
        return os.platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    }

    _getEnabledOutputs() {
        const outputs = [];
        if (this.platforms.twitch.enabled  && this.platforms.twitch.key)
            outputs.push({ name: 'twitch',  url: `${this.platforms.twitch.server}${this.platforms.twitch.key}`,   stableMode: this.platforms.twitch.stableMode });
        if (this.platforms.youtube.enabled && this.platforms.youtube.key)
            outputs.push({ name: 'youtube', url: `${this.platforms.youtube.server}${this.platforms.youtube.key}`, stableMode: this.platforms.youtube.stableMode });
        if (this.platforms.kick.enabled    && this.platforms.kick.key)
            outputs.push({ name: 'kick',    url: `${this.platforms.kick.server}${this.platforms.kick.key}`,       stableMode: this.platforms.kick.stableMode });
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
        this._stopPipeline();
        console.log(`[StreamDelay] Pipeline iniciando — VirtualSubscriber por plataforma`);
        for (const output of outputs) this._startPlatformPipeline(output);
        console.log(`[StreamDelay] Pipeline ativo! Delay: ${this.delay}s | Saídas: ${outputs.map(o => o.name).join(', ')}`);
    }

    _startPlatformPipeline(output) {
        const name = output.name;

        this.buffers[name]              = [];
        this.sentUntils[name]           = 0;
        this.drainStarts[name]          = 0;
        this.isBufferings[name]         = false;
        this.bufferTransitions[name]    = false;
        this.transitionStartTimes[name] = null;

        const spawnWriter = this._createSpawnWriter(output);
        this._spawnWriters[name] = spawnWriter;

        let writersStarted = false;

        const vs = new VirtualSubscriber((data) => {
            const platformNames = Object.keys(this.buffers);
            if (platformNames.length === 0 || platformNames[0] === name) this.bytesIn += data.length;

            const now = Date.now();

            if (!writersStarted) {
                const bc = Context.broadcasts.get(this.currentStreamPath);
                if (bc && bc.flvAudioHeader && bc.flvVideoHeader) {
                    writersStarted = true;
                    console.log(`[StreamDelay] ${name} com headers completos — iniciando writer`);
                    spawnWriter();
                    setTimeout(() => this.emit('status', this.getStatus()), 200);
                }
            }

            this.buffers[name].push({ data, time: now });
            const cutoff = now - MAX_BUFFER_MS;
            while (this.buffers[name].length > 0 && this.buffers[name][0].time < cutoff) {
                this.buffers[name].shift();
                if (this.drainStarts[name] > 0) this.drainStarts[name]--;
            }

            if (this.delay === 0 && !this.bufferTransitions[name] && !this.isBufferings[name]) {
                this._writeToOutput(name, data);
            } else if (this.bufferTransitions[name]) {
                this._writeToOutput(name, data);
                const elapsed = now - this.transitionStartTimes[name];
                if (elapsed >= this.delay * 1000) {
                    console.log(`[StreamDelay] Delay ${this.delay}s ativo para ${name}!`);
                    this.bufferTransitions[name]    = false;
                    this.isBufferings[name]         = true;
                    this.transitionStartTimes[name] = null;
                    this.sentUntils[name]           = now - (this.delay * 1000);
                    this.drainStarts[name]          = 0;
                }
            }
        });

        this.virtualSubscribers[name] = vs;

        const broadcast = Context.broadcasts.get(this.currentStreamPath);
        if (broadcast) {
            if (broadcast.flvHeader)      vs.sendBuffer(broadcast.flvHeader);
            if (broadcast.flvMetaData)    vs.sendBuffer(broadcast.flvMetaData);
            if (broadcast.flvAudioHeader) vs.sendBuffer(broadcast.flvAudioHeader);
            if (broadcast.flvVideoHeader) vs.sendBuffer(broadcast.flvVideoHeader);
            if (this.delay === 0 && broadcast.flvGopCache) broadcast.flvGopCache.forEach(v => vs.sendBuffer(v));
            broadcast.subscribers.set(vs.id, vs);
        }

        this.drainIntervals[name] = setInterval(() => {
            if (!this.isBufferings[name] || !this.writerProcesses[name] || this.delay === 0) return;
            const platformBuffer = this.buffers[name];
            const now            = Date.now();
            const targetTime     = now - (this.delay * 1000);
            while (this.drainStarts[name] < platformBuffer.length &&
                   platformBuffer[this.drainStarts[name]].time <= this.sentUntils[name]) {
                this.drainStarts[name]++;
            }
            for (let i = this.drainStarts[name]; i < platformBuffer.length; i++) {
                const pkt = platformBuffer[i];
                if (pkt.time > targetTime) break;
                this._writeToOutput(name, pkt.data);
                this.sentUntils[name]  = pkt.time;
                this.drainStarts[name] = i + 1;
            }
        }, 30);
    }

    _createSpawnWriter(output) {
        const name = output.name;

        const spawnWriter = () => {
            if (!this.connected) return;
            if (this.writerProcesses[name]) { console.log(`[StreamDelay] Writer ${name} já existe`); return; }
            if (this._reconnectTimers[name]) { clearTimeout(this._reconnectTimers[name]); delete this._reconnectTimers[name]; }
            this._stderrBuffers[name] = [];

            const ffmpeg    = this._findFFmpeg();
            const isKick    = name === 'kick';
            const isTwitch  = name === 'twitch';
            const isYoutube = name === 'youtube';

            const writerArgs = [
                '-rw_timeout', '15000000',
                '-hwaccel', 'cuda',
                '-fflags', '+genpts+discardcorrupt',
                '-use_wallclock_as_timestamps', '1',
                '-f', 'flv', '-i', 'pipe:0',
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
            let writerAlive  = true;
            let hasProgress  = false; // detecta se FFmpeg está realmente a encodar frames
            let writerBuf    = '';

            writer.stderr.on('data', (data) => {
                writerBuf += data.toString();
                const lines = writerBuf.split('\n');
                writerBuf = lines.pop();
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    const buf = this._stderrBuffers[name];
                    if (buf) { buf.push(trimmed); if (buf.length > 10) buf.shift(); }
                    if (trimmed.match(/error|failed|refused|timeout|connection|rtmp|broken|eof/i)) {
                        console.error(`[${name}] ${trimmed}`);
                    }
                    // Detecta frames reais a ser encodados
                    if (!hasProgress) {
                        const m = trimmed.match(/frame=\s*(\d+)/);
                        if (m && parseInt(m[1]) > 0) hasProgress = true;
                    }
                }
            });
            writer.stdin.on('error', (e) => { if (e.code !== 'EPIPE') console.error(`[StreamDelay] ${name} stdin: ${e.message}`); });
            writer.on('error', (e) => console.error(`[StreamDelay] ${name} erro: ${e.message}`));
            writer.on('close', async (code) => {
                writerAlive = false;
                console.log(`[StreamDelay] ${name} encerrado (code=${code})`);
                delete this.writerProcesses[name];

                const unexpected = this.connected && !this.platforms[name]?.manuallyStopped && !this._resetPending;
                if (unexpected) {
                    const stderrLines = this._stderrBuffers[name] || [];
                    const reason  = this._parseFFmpegError(stderrLines);
                    const online  = await this._checkNetwork();
                    const netStr  = online ? 'ONLINE' : 'OFFLINE';
                    if (stderrLines.length > 0) this._writeLog(`⚠ ${name} stderr: ${stderrLines.slice(-3).join(' | ')}`);
                    this._writeLog(`⚠ ${name} caiu — ${reason} | Rede: ${netStr}`);
                    this.emit('status', { ...this.getStatus(), writerError: `${name}: ${reason} | rede ${netStr.toLowerCase()}` });

                    this.platforms[name].failCount = (this.platforms[name].failCount || 0) + 1;
                    if (this.platforms[name].failCount >= 3 && !this.platforms[name].persistentReconnect) {
                        this.platforms[name].manuallyStopped = true;
                        this.platforms[name].failCount = 0;
                        this._writeLog(`⚠ ${name} parou após 3 tentativas — clique Iniciar para tentar novamente`);
                        delete this._stderrBuffers[name];
                        this.emit('status', this.getStatus());
                        return;
                    }
                }
                delete this._stderrBuffers[name];

                if (this.connected && !this.platforms[name]?.manuallyStopped && !this._resetPending) {
                    this._writeLog(`↺ ${name} reconectando em 3s (GOP cache fresco)...`);
                    if (this._reconnectTimers[name]) clearTimeout(this._reconnectTimers[name]);
                    this._reconnectTimers[name] = setTimeout(() => {
                        delete this._reconnectTimers[name];
                        if (this.connected && !this.platforms[name]?.manuallyStopped) {
                            this._restartPlatform(name);
                        }
                    }, 3000);
                }
                this.emit('status', this.getStatus());
            });

            const activateWriter = () => {
                if (writerAlive && !this.writerProcesses[name]) {
                    this.writerProcesses[name] = writer;
                    console.log(`[StreamDelay] ✓ Writer ${name} iniciado`);
                    this.emit('status', this.getStatus());

                    // Verifica após 10s se a plataforma está realmente a receber dados.
                    // Se não houver frames → dispara reset completo do pipeline.
                    setTimeout(() => {
                        if (!hasProgress && writerAlive && this.connected && !this.platforms[name]?.manuallyStopped) {
                            this._scheduleReset(name);
                        }
                    }, 10000);
                }
            };

            const platformBuffer = this.buffers[name] || [];
            const baseTime       = this.delay > 0 ? (this.sentUntils[name] || 0) : Date.now();
            const prerollFrom    = baseTime - 2000;
            const prerollChunks  = platformBuffer.filter(p => p.time >= prerollFrom && p.time <= baseTime);

            if (prerollChunks.length > 1) {
                const t0 = prerollChunks[0].time;
                prerollChunks.forEach(chunk => {
                    setTimeout(() => { if (writer.stdin && writer.stdin.writable) writer.stdin.write(chunk.data); }, chunk.time - t0);
                });
                const dur = prerollChunks[prerollChunks.length - 1].time - t0;
                console.log(`[StreamDelay] ${name} pré-roll: ${prerollChunks.length} chunks (~${Math.round(dur / 1000)}s)`);
                setTimeout(activateWriter, dur + 100);
            } else {
                activateWriter();
            }
        };

        return spawnWriter;
    }

    _writeToOutput(platformName, data) {
        const writer = this.writerProcesses[platformName];
        if (writer && writer.stdin.writable) {
            try { writer.stdin.write(data); this.bytesOut += data.length; } catch (e) {}
        }
    }

    stop() {
        this._stopPipeline();
        if (this.statsInterval) clearInterval(this.statsInterval);
        return new Promise((resolve) => {
            try { if (this.nms) { this.nms.stop(); this.nms = null; } } catch {}
            setTimeout(resolve, 800);
        });
    }

    _stopPipeline() {
        for (const [, interval] of Object.entries(this.drainIntervals)) clearInterval(interval);
        this.drainIntervals = {};
        for (const [, timer] of Object.entries(this._reconnectTimers)) clearTimeout(timer);
        this._reconnectTimers = {};
        this._spawnWriters    = {};

        if (this.currentStreamPath) {
            const broadcast = Context.broadcasts.get(this.currentStreamPath);
            if (broadcast) {
                for (const [, vs] of Object.entries(this.virtualSubscribers)) broadcast.subscribers.delete(vs.id);
            }
        }
        this.virtualSubscribers = {};

        for (const [, writer] of Object.entries(this.writerProcesses)) {
            if (writer) writer.kill('SIGKILL');
        }
        this.writerProcesses = {};

        this.buffers              = {};
        this.sentUntils           = {};
        this.drainStarts          = {};
        this.isBufferings         = {};
        this.bufferTransitions    = {};
        this.transitionStartTimes = {};

        for (const p of Object.values(this.platforms)) {
            p.manuallyStopped     = false;
            p.failCount           = 0;
            p.persistentReconnect = false;
        }
    }

    _startStatsReporting() {
        if (this.statsInterval) clearInterval(this.statsInterval);
        let lastIn = this.bytesIn, lastOut = this.bytesOut;
        this.statsInterval = setInterval(() => {
            const now     = Date.now();
            const inRate  = ((this.bytesIn  - lastIn)  / 1024) * 8;
            const outRate = ((this.bytesOut - lastOut) / 1024) * 8;
            lastIn  = this.bytesIn;
            lastOut = this.bytesOut;
            const uptime = this.startTime ? Math.floor((now - this.startTime) / 1000) : 0;
            this.emit('stats', { inKbps: Math.round(inRate), outKbps: Math.round(outRate), bufferSize: 0, uptime });
        }, 1000);
    }

    getStatus() {
        const writers = {};
        for (const name of Object.keys(this.platforms)) {
            writers[name] = { active: !!this.writerProcesses[name], manuallyStopped: this.platforms[name].manuallyStopped };
        }
        return { connected: this.connected, delay: this.delay, mode: this.mode, platforms: this.platforms, writers };
    }
}

module.exports = { StreamDelayServer };
