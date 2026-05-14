const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { startTheaterBot } = require('./theaterBot');
const { loadConfig } = require('./services/config');
const { getDurationSeconds, playWithMpv, cleanupTempDir } = require('./services/playback');
const { createPlayerState, broadcastState } = require('./services/state');
const { QueueManager } = require('./services/queueManager');
const { MediaLibrary } = require('./services/mediaLibrary');

const DEFAULT_CACHE_DIR = '/var/tmp/theaterplayer';
const QUEUE_TARGET = 6;
const REFILL_RETRY_MS = 5000;
const CLEANUP_EVERY_PLAYS = 5;

async function main() {
    const config = loadConfig();
    const webPort = (config.web && config.web.port) || 3000;
    const tempDir = (config.storage && config.storage.cacheDir) || DEFAULT_CACHE_DIR;
    fs.mkdirSync(tempDir, { recursive: true });

    const app = express();
    const server = http.createServer(app);
    const io = new Server(server);
    app.use(express.static(path.join(__dirname, 'public')));

    const state = createPlayerState();
    const syncState = () => broadcastState(io, state);

    io.on('connection', (socket) => {
        socket.emit('state', state);
    });

    server.listen(webPort, () => {
        console.log(`web ui: http://localhost:${webPort}`);
    });

    const mediaLibrary = new MediaLibrary(config.smb);
    const queueManager = new QueueManager(QUEUE_TARGET);

    let currentMpvProcess = null;
    let completedPlays = 0;

    function skipCurrentPlayback() {
        if (!currentMpvProcess) return false;
        try {
            currentMpvProcess.kill('SIGTERM');
            return true;
        } catch (_) {
            return false;
        }
    }

    async function refreshAndRefill(currentName) {
        await mediaLibrary.refresh();
        queueManager.refill(mediaLibrary.getAllVideos(), currentName);
        state.queue = queueManager.getQueue();
        syncState();
    }

    async function findAndPlayByQuery(query) {
        await mediaLibrary.refresh();
        const result = mediaLibrary.findBestMatch(query);
        if (!result.ok) return result;

        queueManager.forceNext(result.matched);
        state.queue = queueManager.getQueue();
        state.status = `queued from search: ${result.matched}`;
        syncState();

        skipCurrentPlayback();
        return result;
    }

    startTheaterBot(config.bot && config.bot.serverUrl, {
        onSkip: skipCurrentPlayback,
        onFindAndPlay: findAndPlayByQuery
    });

    state.status = 'idle';
    syncState();

    while (true) {
        try {
            await refreshAndRefill(null);

            const nextName = queueManager.shiftNext();
            if (!nextName) {
                state.status = 'no videos found, retrying';
                syncState();
                await new Promise((r) => setTimeout(r, REFILL_RETRY_MS));
                continue;
            }

            state.queue = queueManager.getQueue();
            state.status = 'downloading';
            state.title = nextName;
            state.durationSeconds = null;
            state.elapsedSeconds = null;
            state.remainingSeconds = null;
            syncState();

            const localPath = path.join(tempDir, nextName);
            try {
                await mediaLibrary.download(nextName, localPath);
            } catch (downloadError) {
                try { fs.unlinkSync(localPath); } catch (_) {}
                throw downloadError;
            }

            queueManager.refill(mediaLibrary.getAllVideos(), nextName);
            state.queue = queueManager.getQueue();
            syncState();

            state.durationSeconds = await getDurationSeconds(localPath);
            state.elapsedSeconds = 0;
            state.remainingSeconds = state.durationSeconds;
            state.status = 'playing';
            syncState();

            const startedAt = Date.now();
            const ticker = setInterval(() => {
                if (state.durationSeconds == null) return;
                const elapsed = Math.floor((Date.now() - startedAt) / 1000);
                state.elapsedSeconds = Math.min(elapsed, state.durationSeconds);
                state.remainingSeconds = Math.max(0, state.durationSeconds - elapsed);
                syncState();
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
            syncState();

            try { fs.unlinkSync(localPath); } catch (_) {}

            completedPlays += 1;
            if (completedPlays % CLEANUP_EVERY_PLAYS === 0) {
                cleanupTempDir(tempDir);
            }
        } catch (e) {
            state.status = `error: ${e.message}`;
            syncState();
            console.error(e);
            await new Promise((r) => setTimeout(r, REFILL_RETRY_MS));
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
