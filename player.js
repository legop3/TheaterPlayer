const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn, execFile } = require('child_process');
const yaml = require('js-yaml');
const SambaClient = require('samba-client');
const { startTheaterBot } = require('./theaterBot');

const DEFAULT_CACHE_DIR = '/var/tmp/theaterplayer';
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v']);
const QUEUE_TARGET = 6;
const REFILL_RETRY_MS = 5000;
const CLEANUP_EVERY_PLAYS = 5;

function loadConfig() {
    const configContents = fs.readFileSync('config.yml', 'utf-8');
    return yaml.load(configContents);
}

function isVideoFile(file) {
    return file.type === 'N' && VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase());
}

function chooseRandom(items) {
    return items[Math.floor(Math.random() * items.length)];
}

function getDurationSeconds(filePath) {
    return new Promise((resolve) => {
        execFile('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], (err, stdout) => {
            if (err) return resolve(null);
            const n = Number((stdout || '').trim());
            resolve(Number.isFinite(n) ? Math.round(n) : null);
        });
    });
}

function getVideoCodec(filePath) {
    return new Promise((resolve) => {
        execFile('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], (err, stdout) => {
            if (err) return resolve(null);
            resolve((stdout || '').trim().toLowerCase() || null);
        });
    });
}

function playWithMpv(filePath, displayConfig) {
    const args = [];
    if (displayConfig && displayConfig.fullscreen) args.push('--fs');
    if (displayConfig && Number.isInteger(displayConfig.screen)) args.push(`--screen=${displayConfig.screen}`);
    args.push(filePath);

    const proc = spawn('mpv', args, { stdio: 'inherit' });
    const done = new Promise((resolve, reject) => {
        proc.on('error', reject);
        proc.on('close', (code, signal) => resolve({ code, signal }));
    });

    return { proc, done };
}

function formatSeconds(totalSeconds) {
    if (totalSeconds == null) return '--:--';
    const s = Math.max(0, totalSeconds);
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

function cleanupTempDir(tempDir) {
    try {
        for (const name of fs.readdirSync(tempDir)) {
            const filePath = path.join(tempDir, name);
            try {
                fs.rmSync(filePath, { recursive: true, force: true });
            } catch (_) {}
        }
    } catch (_) {}
}

async function main() {
    const config = loadConfig();
    const webPort = (config.web && config.web.port) || 3000;
    const tempDir = (config.storage && config.storage.cacheDir) || DEFAULT_CACHE_DIR;
    fs.mkdirSync(tempDir, { recursive: true });

    const app = express();
    const server = http.createServer(app);
    const io = new Server(server);
    app.use(express.static(path.join(__dirname, 'public')));

    const state = {
        title: 'Nothing playing',
        durationSeconds: null,
        elapsedSeconds: null,
        remainingSeconds: null,
        durationLabel: '--:--',
        elapsedLabel: '--:--',
        remainingLabel: '--:--',
        progressLabel: '--:--/--:--',
        queue: [],
        status: 'starting'
    };

    function broadcastState() {
        state.durationLabel = formatSeconds(state.durationSeconds);
        state.elapsedLabel = formatSeconds(state.elapsedSeconds);
        state.remainingLabel = formatSeconds(state.remainingSeconds);
        state.progressLabel = `${state.elapsedLabel}/${state.durationLabel}`;
        io.emit('state', state);
    }

    io.on('connection', (socket) => {
        socket.emit('state', state);
    });

    server.listen(webPort, () => {
        console.log(`web ui: http://localhost:${webPort}`);
    });

    const client = new SambaClient({
        address: config.smb.address,
        directory: config.smb.directory
    });

    let currentMpvProcess = null;
    function skipCurrentPlayback() {
        if (!currentMpvProcess) return false;
        try {
            currentMpvProcess.kill('SIGTERM');
            return true;
        } catch (_) {
            return false;
        }
    }

    startTheaterBot(config.bot && config.bot.serverUrl, skipCurrentPlayback);

    let allVideos = [];
    const queue = [];
    let completedPlays = 0;

    async function refreshVideos() {
        const remoteFiles = await client.list('*');
        allVideos = remoteFiles.filter(isVideoFile).map((f) => f.name);
    }

    async function refillQueue(currentName) {
        if (allVideos.length === 0) await refreshVideos();
        const blocked = new Set(queue);
        if (currentName) blocked.add(currentName);

        while (queue.length < QUEUE_TARGET) {
            const candidates = allVideos.filter((name) => !blocked.has(name));
            if (candidates.length === 0) break;
            const picked = chooseRandom(candidates);
            queue.push(picked);
            blocked.add(picked);
        }

        state.queue = queue.slice();
        broadcastState();
    }

    state.status = 'idle';
    broadcastState();

    while (true) {
        try {
            await refreshVideos();
            await refillQueue(null);

            if (queue.length === 0) {
                state.status = 'no videos found, retrying';
                broadcastState();
                await new Promise((r) => setTimeout(r, REFILL_RETRY_MS));
                continue;
            }

            const nextName = queue.shift();
            state.queue = queue.slice();
            state.status = 'downloading';
            state.title = nextName;
            state.durationSeconds = null;
            state.elapsedSeconds = null;
            state.remainingSeconds = null;
            broadcastState();

            const localPath = path.join(tempDir, nextName);
            try {
                await client.getFile(nextName, localPath);
            } catch (downloadError) {
                try {
                    fs.unlinkSync(localPath);
                } catch (_) {}
                throw downloadError;
            }
            await refillQueue(nextName);

            // const codec = await getVideoCodec(localPath);
            // if (codec === 'av1') {
            //     state.status = 'skipping av1';
            //     broadcastState();
            //     try {
            //         fs.unlinkSync(localPath);
            //     } catch (_) {}
            //     continue;
            // }

            state.durationSeconds = await getDurationSeconds(localPath);
            state.elapsedSeconds = 0;
            state.remainingSeconds = state.durationSeconds;
            state.status = 'playing';
            broadcastState();

            const startedAt = Date.now();
            const ticker = setInterval(() => {
                if (state.durationSeconds == null) return;
                const elapsed = Math.floor((Date.now() - startedAt) / 1000);
                state.elapsedSeconds = Math.min(elapsed, state.durationSeconds);
                state.remainingSeconds = Math.max(0, state.durationSeconds - elapsed);
                broadcastState();
            }, 1000);

            const playback = playWithMpv(localPath, config.display);
            currentMpvProcess = playback.proc;
            const playResult = await playback.done;
            currentMpvProcess = null;
            clearInterval(ticker);

            if (playResult && playResult.signal === 'SIGTERM') state.status = 'skipped';
            else state.status = 'ended';
            state.elapsedSeconds = state.durationSeconds;
            state.remainingSeconds = 0;
            broadcastState();

            try {
                fs.unlinkSync(localPath);
            } catch (_) {}

            completedPlays += 1;
            if (completedPlays % CLEANUP_EVERY_PLAYS === 0) {
                cleanupTempDir(tempDir);
            }
        } catch (e) {
            state.status = `error: ${e.message}`;
            broadcastState();
            console.error(e);
            await new Promise((r) => setTimeout(r, REFILL_RETRY_MS));
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
