const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Fuse = require('fuse.js');

const { startTheaterBot } = require('./theaterBot');
const { loadConfig } = require('./services/config');
const { getDurationSeconds, playWithMpv, cleanupTempDir } = require('./services/playback');
const { createPlayerState, broadcastState } = require('./services/state');
const { QueueManager, createFileItem, getItemDisplayName } = require('./services/queueManager');
const { MediaLibrary } = require('./services/mediaLibrary');

const DEFAULT_CACHE_DIR = '/var/tmp/theaterplayer';
const QUEUE_TARGET = 6;
const REFILL_RETRY_MS = 5000;
const CACHE_CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000;

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

function createStreamItem(name, url) {
    // Streams are intentionally represented with the same small item contract as
    // files. The `type` tells the playback loop to skip SMB download/duration
    // probing, while `name` keeps chat and UI output readable.
    return { type: 'stream', name, url };
}

function getConfiguredStreams(rawStreams) {
    // The config file is meant to stay simple: a top-level map of alias -> URL.
    // Filtering here keeps malformed entries from crashing startup while still
    // making the valid aliases available to fuzzy search.
    return Object.entries(rawStreams || {})
        .map(([alias, url]) => ({
            alias: String(alias || '').trim(),
            url: String(url || '').trim()
        }))
        .filter((stream) => stream.alias && stream.url);
}

function parseUrlLikeSource(value) {
    try {
        // There is deliberately no protocol allowlist. mpv and the installed
        // FFmpeg/ytdl stack are the authority on which protocols and stream
        // formats are supported on this machine; the app only decides whether
        // the user's input is URL-shaped enough to pass straight through.
        const parsed = new URL(String(value || '').trim());
        return parsed.protocol ? parsed.href : null;
    } catch (_) {
        return null;
    }
}

function findBestStreamAlias(query, streams) {
    const q = String(query || '').trim();
    if (!q || streams.length === 0) return null;

    // Fuse is already used for file search, so stream aliases use the same
    // library instead of introducing a second fuzzy matching behavior. Exact
    // alias matches are naturally scored best, while partial or misspelled names
    // can still work when the score is confident enough.
    const fuse = new Fuse(streams, {
        keys: ['alias'],
        includeScore: true,
        threshold: 0.45,
        ignoreLocation: true,
        minMatchCharLength: 2
    });

    const results = fuse.search(q);
    return results.length > 0 ? results[0].item : null;
}

async function main() {
    const config = loadConfig();
    const webPort = (config.web && config.web.port) || 3000;
    const tempDir = (config.storage && config.storage.cacheDir) || DEFAULT_CACHE_DIR;
    const streams = getConfiguredStreams(config.streams);
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
    let nextCacheCleanupAt = Date.now() + CACHE_CLEANUP_INTERVAL_MS;

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
        state.queue = queueManager.getDisplayQueue();
        syncState();
    }

    async function findAndPlayByQuery(query) {
        const q = String(query || '').trim();
        if (!q) return { ok: false, message: 'Usage: !play <url, stream alias, or search text>' };

        const directUrl = parseUrlLikeSource(q);
        if (directUrl) {
            // Direct URLs bypass fuzzy search entirely. That lets someone paste
            // any mpv-supported stream/media URL and have it play exactly as
            // entered instead of being compared with local filenames.
            const streamItem = createStreamItem(directUrl, directUrl);
            queueManager.forceNext(streamItem);
            state.queue = queueManager.getDisplayQueue();
            state.status = `queued stream: ${directUrl}`;
            syncState();

            skipCurrentPlayback();
            return { ok: true, type: 'stream', matched: directUrl };
        }

        const streamMatch = findBestStreamAlias(q, streams);
        if (streamMatch) {
            const streamItem = createStreamItem(streamMatch.alias, streamMatch.url);
            queueManager.forceNext(streamItem);
            state.queue = queueManager.getDisplayQueue();
            state.status = `queued stream: ${streamMatch.alias}`;
            syncState();

            skipCurrentPlayback();
            return { ok: true, type: 'stream', matched: streamMatch.alias };
        }

        await mediaLibrary.refresh();
        const result = mediaLibrary.findBestMatch(q);
        if (!result.ok) return result;

        queueManager.forceNext(createFileItem(result.matched));
        state.queue = queueManager.getDisplayQueue();
        state.status = `queued from search: ${result.matched}`;
        syncState();

        skipCurrentPlayback();
        return { ...result, type: 'file' };
    }

    function getNowMessage() {
        const current = state.title || 'Nothing playing';
        const firstLine = state.playbackType === 'stream'
            ? `Now playing stream: ${current}`
            : `Now playing: ${current}`;
        return [
            firstLine,
            `Status: ${state.status || 'unknown'}`,
            `Progress: ${state.isLive ? 'live' : (state.progressLabel || '--:--/--:--')}`
        ].join('\n');
    }

    function getInfoMessage() {
        // These counts are intentionally direct snapshots. `!info` should be
        // fast and non-disruptive, so it reports the most recent library scan
        // rather than forcing a new SMB traversal from chat.
        return [
            `Status: ${state.status || 'unknown'}`,
            `Library files: ${mediaLibrary.getAllVideos().length}`,
            `Queued items: ${queueManager.getQueue().length}`,
            `Configured streams: ${streams.length}`,
            `Current: ${state.title || 'Nothing playing'}`
        ].join('\n');
    }

    startTheaterBot(config.bot && config.bot.serverUrl, {
        onSkip: skipCurrentPlayback,
        onFindAndPlay: findAndPlayByQuery,
        onNow: getNowMessage,
        onInfo: getInfoMessage,
        profileImage: config.bot && config.bot.profileImage
    });

    state.status = 'idle';
    syncState();

    while (true) {
        try {
            // Cache cleanup happens only at this safe boundary between playback
            // iterations. A wall-clock interval could fire while samba-client is
            // writing a download and remove the file before ffprobe or mpv opens
            // it. Waiting until the loop returns here avoids that race and also
            // lets the current video finish before its cached file is removed.
            if (Date.now() >= nextCacheCleanupAt) {
                cleanupTempDir(tempDir);

                // Base the next deadline on the cleanup that just ran. This keeps
                // long videos or temporary playback errors from causing several
                // overdue cleanups to run back-to-back when the loop resumes.
                nextCacheCleanupAt = Date.now() + CACHE_CLEANUP_INTERVAL_MS;
            }

            await refreshAndRefill(null);

            const nextItem = queueManager.shiftNext();
            if (!nextItem) {
                state.status = 'no videos found, retrying';
                syncState();
                await new Promise((r) => setTimeout(r, REFILL_RETRY_MS));
                continue;
            }

            const nextDisplayName = getItemDisplayName(nextItem);
            state.queue = queueManager.getDisplayQueue();
            state.playbackType = nextItem.type;
            state.isLive = nextItem.type === 'stream';
            state.status = nextItem.type === 'stream' ? 'playing stream' : 'downloading';
            state.title = nextDisplayName;
            state.durationSeconds = null;
            state.elapsedSeconds = null;
            state.remainingSeconds = null;
            syncState();

            if (nextItem.type === 'stream') {
                // Livestreams and direct remote media sources should go straight
                // to mpv. Downloading or ffprobing them would either be wrong
                // for endless streams or slow for protocol-specific sources that
                // mpv already knows how to open.
                queueManager.refill(mediaLibrary.getAllVideos(), null);
                state.queue = queueManager.getDisplayQueue();
                syncState();

                const playback = playWithMpv(nextItem.url, config.display);
                currentMpvProcess = playback.proc;
                const playResult = await playback.done;
                currentMpvProcess = null;

                if (playResult && playResult.signal === 'SIGTERM') state.status = 'skipped';
                else state.status = 'ended';
                state.isLive = false;
                state.playbackType = null;
                state.elapsedSeconds = null;
                state.remainingSeconds = null;
                syncState();
                continue;
            }

            const nextName = nextItem.name;
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
            state.queue = queueManager.getDisplayQueue();
            syncState();

            state.durationSeconds = await getDurationSeconds(localPath);
            state.elapsedSeconds = 0;
            state.remainingSeconds = state.durationSeconds;
            state.status = 'playing';
            state.isLive = false;
            state.playbackType = 'file';
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
            state.playbackType = null;
            state.isLive = false;
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
