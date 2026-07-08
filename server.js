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

// Reescreve o timestamp (dts) de cada tag FLV antes de ela ir pro stdin do writer,
// como única autoridade de tempo — substitui o -use_wallclock_as_timestamps do FFmpeg.
// Necessário pra habilitar -c:v copy (passthrough): sem regeneração de timing pelo
// FFmpeg, os timestamps que chegam precisam já estar corretos e monotônicos.
// Áudio e vídeo são linhas do tempo INDEPENDENTES — cada uma tem seu próprio relógio.
class TimestampRemapper {
    constructor() {
        this._clocks = { 8: { lastOutputTs: 0, lastInputTs: null }, 9: { lastOutputTs: 0, lastInputTs: null } };
    }
    // Chamar em qualquer ponto de descontinuidade conhecida (transição de delay,
    // writer novo) — força a próxima tag de cada tipo a avançar só um passo pequeno em
    // vez de herdar o salto real entre o timestamp original antigo e o novo.
    reset() {
        this._clocks[8].lastInputTs = null;
        this._clocks[9].lastInputTs = null;
    }
    // Retorna null se a tag deve ser DESCARTADA (chegou fora de ordem — ex: replay do
    // GOP cache ainda "pingando" via setTimeout enquanto dados ao vivo já avançaram o
    // relógio). Forçar essa tag pra frente em vez de descartar quebra a ordem de
    // decodificação (visto em teste offline: "co located POCs unavailable" + "Packets
    // are not in the proper order with respect to DTS").
    remap(buf) {
        if (buf.length < 12 || (buf[0] !== 8 && buf[0] !== 9)) return buf;
        const clock = this._clocks[buf[0]];
        const originalTs = (buf[7] << 24) | (buf[4] << 16) | (buf[5] << 8) | buf[6];
        if (clock.lastInputTs !== null) {
            const natural = originalTs - clock.lastInputTs;
            if (natural < 0) return null; // fora de ordem — descarta, não força
            clock.lastOutputTs += natural <= 1000 ? natural : 33; // salto suspeito → ~1 frame
        } else {
            clock.lastOutputTs += 33;
        }
        clock.lastInputTs = originalTs;
        const out = Buffer.from(buf);
        out[4] = (clock.lastOutputTs >> 16) & 0xFF;
        out[5] = (clock.lastOutputTs >> 8) & 0xFF;
        out[6] = clock.lastOutputTs & 0xFF;
        out[7] = (clock.lastOutputTs >> 24) & 0xFF;
        return out;
    }
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
        this._resetPending      = {}; // reset pendente por plataforma — evita loops simultâneos
        this._remappers         = {}; // TimestampRemapper por plataforma

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

    // Reinicia apenas a plataforma que falhou — as outras continuam sem interrupção.
    // O VS novo re-subscreve o NMS e recebe headers + GOP cache frescos.
    _scheduleReset(platform) {
        if (this._resetPending[platform]) return;
        this._resetPending[platform] = true;
        const streamPath = this.currentStreamPath;
        this._writeLog(`↺ ${platform} sem frames após 10s — reiniciando apenas ${platform} em 3s`);

        setTimeout(() => {
            if (!this.connected || this.currentStreamPath !== streamPath || this.platforms[platform]?.manuallyStopped) {
                this._resetPending[platform] = false;
                return;
            }
            this._writeLog(`↺ ${platform} reiniciando (outras plataformas não são afetadas)`);
            this._restartPlatform(platform);
            // Mantém resetPending por 45s para evitar loop — dá tempo ao writer arrancar
            setTimeout(() => { this._resetPending[platform] = false; }, 45000);
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
                this.connected = false;
                // _stopPipeline precisa do currentStreamPath ainda válido pra conseguir
                // desinscrever os VirtualSubscribers do broadcast.subscribers do NMS —
                // senão eles ficam presos lá, e um restart rápido do OBS reusa o mesmo
                // broadcast com VSs antigos + novos ao mesmo tempo, duplicando cada
                // pacote FLV no stdin do writer (corrupção "vidro estilhaçado").
                this._stopPipeline();
                this.currentStreamPath = null;
                this.startTime         = null;
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
                this._remappers[name]?.reset(); // salto do ponto "N segundos atrás" pro "agora"
            }
        } else if (oldDelay > 0 && this.delay > 0) {
            const newSentUntil = Date.now() - (this.delay * 1000);
            for (const name of active) {
                this.sentUntils[name]  = newSentUntil;
                this.drainStarts[name] = 0;
                this._remappers[name]?.reset(); // reposiciona o ponteiro no buffer, quebra a sequência
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
        this._remappers[name]           = new TimestampRemapper();

        // Delay ativo no momento do restart? Reentra em modo transição (como 0→N):
        // volta ao vivo e re-acumula o delay. Evita o loop de reset por "sem frames".
        if (this.delay > 0) {
            this.bufferTransitions[name]    = true;
            this.transitionStartTimes[name] = Date.now();
        }

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
                    this._remappers[name]?.reset(); // salto do "agora" pro drain N segundos atrás
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
            // Em modo transição o writer começa num keyframe limpo (evita non-existing PPS)
            if ((this.delay === 0 || this.bufferTransitions[name]) && broadcast.flvGopCache) {
                const gopChunks = [...broadcast.flvGopCache];
                if (gopChunks.length > 0) {
                    // Timestamp FLV (dts) vem nos bytes 4-7 do tag header. Reenviar o
                    // cache inteiro de uma vez (mesmo tick) faz o FFmpeg — que usa
                    // -use_wallclock_as_timestamps — carimbar todos os frames quase no
                    // mesmo instante, corrompendo a cadência logo no início do restart
                    // (stutter). Espaçar pelo timestamp original evita a rajada.
                    const readTs = (buf) => (buf[7] << 24) | (buf[4] << 16) | (buf[5] << 8) | buf[6];
                    const t0 = readTs(gopChunks[0]);
                    gopChunks.forEach(chunk => {
                        const wait = Math.max(0, readTs(chunk) - t0);
                        setTimeout(() => {
                            if (this.virtualSubscribers[name] === vs) vs.sendBuffer(chunk);
                        }, wait);
                    });
                }
            }
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

            // Fase 2 (passthrough) — TESTE nas 3 plataformas: não recodifica vídeo, só
            // remuxa o H.264 que o OBS já mandou (-c:v copy). Sem decode, então sem
            // -hwaccel cuda. Como os B-frames do OBS passam direto com copy, o bsf precisa
            // corrigir dts pelo seu PRÓPRIO valor (DTS-STARTDTS) — usar PTS-STARTPTS no dts
            // quebraria a ordem de decodificação. ATENÇÃO: Kick tem limite de ~6-8Mbps e
            // fecha a conexão se o OBS mandar mais que isso — passthrough aqui só funciona
            // se o bitrate do OBS estiver dentro desse limite.
            const isPassthrough = true;

            const writerArgs = [
                '-rw_timeout', '15000000',
                ...(isPassthrough ? [] : ['-hwaccel', 'cuda']),
                // -use_wallclock_as_timestamps removido: o TimestampRemapper (JS) agora é
                // a única autoridade de timestamp, aplicado antes de qualquer write no stdin.
                '-fflags', '+genpts+discardcorrupt',
                '-f', 'flv', '-i', 'pipe:0',
                '-map', '0:v:0', '-map', '0:a:0',
                ...(isPassthrough ? ['-c:v', 'copy'] : ['-c:v', 'h264_nvenc', '-preset', 'p4']),
                ...(!isPassthrough && isKick    ? ['-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k', '-bf', '0', '-g', '60', '-pix_fmt', 'yuv420p'] : []),
                ...(!isPassthrough && isTwitch  ? ['-b:v', '8000k', '-maxrate', '8000k', '-bufsize', '16000k', '-bf', '0', '-g', '60', '-pix_fmt', 'yuv420p'] : []),
                ...(isPassthrough
                    ? ['-bsf:v', 'setts=pts=PTS-STARTPTS:dts=DTS-STARTDTS']
                    : ['-bsf:v', 'setts=pts=PTS-STARTPTS:dts=PTS-STARTPTS']),
                '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
                '-af', 'aresample=async=1',
                '-f', 'flv', '-flvflags', 'no_duration_filesize',
                output.url
            ];

            const writer = spawn(ffmpeg, writerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
            let writerAlive    = true;
            let hasProgress    = false; // detecta se FFmpeg está realmente a encodar frames
            let outputStarted  = false; // FFmpeg imprimiu "Output #0" — NVENC inicializado e RTMP ligado
            let writerBuf      = '';

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
                    // Detecta frames reais sendo processados. Com -c:v copy (passthrough)
                    // o contador "frame=" pode não incrementar do jeito normal — "size="
                    // crescendo é prova igualmente válida de que dados estão saindo.
                    if (!hasProgress) {
                        const fm = trimmed.match(/frame=\s*(\d+)/);
                        const sm = trimmed.match(/size=\s*(\d+)/);
                        if ((fm && parseInt(fm[1]) > 0) || (sm && parseInt(sm[1]) > 0)) hasProgress = true;
                    }
                    // "Output #0" = NVENC inicializado + RTMP conectado.
                    // Só aqui o timer de "sem frames" faz sentido: cold-start do NVENC
                    // pode levar >10s na primeira vez, mas após Output #0 frames devem
                    // aparecer em <2s. O timer anterior em activateWriter dispava cedo
                    // demais e reiniciava a plataforma desnecessariamente.
                    if (!outputStarted && trimmed.includes('Output #0')) {
                        outputStarted = true;
                        setTimeout(() => {
                            if (!hasProgress && writerAlive && this.connected && !this.platforms[name]?.manuallyStopped) {
                                this._scheduleReset(name);
                            }
                        }, 10000);
                    }
                }
            });
            writer.stdin.on('error', (e) => { if (e.code !== 'EPIPE') console.error(`[StreamDelay] ${name} stdin: ${e.message}`); });
            writer.on('error', (e) => console.error(`[StreamDelay] ${name} erro: ${e.message}`));
            writer.on('close', async (code) => {
                writerAlive = false;
                console.log(`[StreamDelay] ${name} encerrado (code=${code})`);
                // Morto pelo _stopPipeline (OBS desconectou) — ignorar completamente.
                if (writer._expectedClose) return;
                // Writer antigo morto durante um restart: um writer novo já está
                // registado — este close é obsoleto, não apaga nem reconecta nada.
                if (this.writerProcesses[name] && this.writerProcesses[name] !== writer) return;
                delete this.writerProcesses[name];

                const unexpected = this.connected && !this.platforms[name]?.manuallyStopped && !this._resetPending[name];
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

                if (this.connected && !this.platforms[name]?.manuallyStopped && !this._resetPending[name]) {
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
                    // Para delay=0 faz flush de tudo o que ficou no buffer antes de o writer
                    // estar registado (headers, GOP cache inicial) — sem esta limpeza o writer
                    // arranca a meio de um GOP e stuttera até ao próximo keyframe.
                    if (this.delay === 0) {
                        const remapper = this._remappers[name];
                        for (const chunk of (this.buffers[name] || [])) {
                            const out = remapper ? remapper.remap(chunk.data) : chunk.data;
                            if (out && writer.stdin && writer.stdin.writable) writer.stdin.write(out);
                        }
                    }
                    console.log(`[StreamDelay] ✓ Writer ${name} iniciado`);
                    this.emit('status', this.getStatus());
                }
            };

            const platformBuffer = this.buffers[name] || [];
            const baseTime       = this.delay > 0 ? (this.sentUntils[name] || 0) : Date.now();
            const prerollFrom    = baseTime - 2000;
            const prerollChunks  = platformBuffer.filter(p => p.time >= prerollFrom && p.time <= baseTime);

            if (this.delay > 0 && prerollChunks.length > 1) {
                const t0 = prerollChunks[0].time;
                const remapper = this._remappers[name];
                prerollChunks.forEach(chunk => {
                    setTimeout(() => {
                        const out = remapper ? remapper.remap(chunk.data) : chunk.data;
                        if (out && writer.stdin && writer.stdin.writable) writer.stdin.write(out);
                    }, chunk.time - t0);
                });
                const dur = prerollChunks[prerollChunks.length - 1].time - t0;
                console.log(`[StreamDelay] ${name} pré-roll: ${prerollChunks.length} chunks (~${Math.round(dur / 1000)}s)`);
                setTimeout(activateWriter, dur + 100);
            } else {
                // delay=0: activar imediatamente; o flush em activateWriter envia os headers já
                // acumulados no buffer antes de o writer estar registado.
                activateWriter();
            }
        };

        return spawnWriter;
    }

    _writeToOutput(platformName, data) {
        const writer = this.writerProcesses[platformName];
        if (writer && writer.stdin.writable) {
            const remapper = this._remappers[platformName];
            const out = remapper ? remapper.remap(data) : data;
            if (!out) return; // fora de ordem — descartado pelo remapper
            try { writer.stdin.write(out); this.bytesOut += out.length; } catch (e) {}
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
            if (!writer) continue;
            writer._expectedClose = true;
            // Fecha o stdin em vez de matar na hora — o FFmpeg processa o que sobrou e
            // encerra a conexão RTMP de forma limpa, avisando a plataforma que a live
            // ACABOU (em vez de um corte abrupto, que a Twitch/YouTube interpretam como
            // "conexão caiu, pode voltar" e mostram o overlay de "reconectando").
            try { writer.stdin.end(); } catch {}
            const killTimer = setTimeout(() => { try { writer.kill('SIGKILL'); } catch {} }, 2000);
            writer.once('close', () => clearTimeout(killTimer));
        }
        this.writerProcesses = {};

        this.buffers              = {};
        this.sentUntils           = {};
        this.drainStarts          = {};
        this.isBufferings         = {};
        this.bufferTransitions    = {};
        this.transitionStartTimes = {};
        this._resetPending        = {};

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
