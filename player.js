const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const { startTheaterBot } = require('./theaterBot');
const { loadConfig } = require('./services/config');
const { getDurationSeconds, playWithMpv } = require('./services/playback');
const { createPlayerState, broadcastState } = require('./services/state');
const { QueueManager } = require('./services/queueManager');
const { MediaLibrary } = require('./services/mediaLibrary');

const DEFAULT_CACHE_DIR = '/var/tmp/theaterplayer';
const QUEUE_TARGET = 6;
const REFILL_RETRY_MS = 5000;

function getLocalCachePath(cacheDir, remoteName) {
    // Remote library names are SMB-relative paths such as "trailers/foo.mkv".
    // Keeping that folder shape in the cache prevents collisions between files
    // with the same basename in different SMB folders.
    const cacheRoot = path.resolve(cacheDir);
    const remoteParts = String(remoteName || '')
        .split(/[\\/]+/)
        .filter((part) => part && part !== '.');

    // The SMB share is trusted for media, but its filenames still come from
    // outside this process. Reject parent-directory segments so a weird or
    // malicious remote name cannot escape the configured cache directory.
    if (remoteParts.length === 0 || remoteParts.includes('..')) {
        throw new Error(`invalid remote video path: ${remoteName}`);
    }

    const localPath = path.resolve(cacheRoot, ...remoteParts);

    // Resolve-and-prefix checking is the last guard after segment validation.
    // It keeps all cached downloads inside cacheRoot even if path behavior or
    // future input normalization changes.
    if (localPath !== cacheRoot && !localPath.startsWith(cacheRoot + path.sep)) {
        throw new Error(`invalid cache path for remote video: ${remoteName}`);
    }

    return localPath;
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
        onFindAndPlay: findAndPlayByQuery,
        profileImage: config.bot && config.bot.profileImage
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

            const localPath = getLocalCachePath(tempDir, nextName);
            try {
                // Nested SMB videos map to nested cache paths. Ensure the local
                // parent folder exists immediately before downloading so cache
                // cleanup or a fresh machine cannot make samba-client.getFile()
                // fail with a missing local directory.
                fs.mkdirSync(path.dirname(localPath), { recursive: true });
                const downloadResult = await mediaLibrary.download(nextName, localPath);
                state.status = downloadResult.fromCache ? 'using cached file' : 'downloaded';
                syncState();
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
