const Fuse = require('fuse.js');
const { QueueManager } = require('./queueManager');
const { playWithMpv } = require('./playback');
const { createPlayerState, updateFormattedState } = require('./state');
const { waitFor, throwIfAborted } = require('./process');

function formatBytes(bytes) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

class PlayerController {
    constructor(config, library, cache, render, notify) {
        this.config = config;
        this.library = library;
        this.cache = cache;
        this.render = render;
        this.notify = notify;
        this.state = createPlayerState();
        this.queue = new QueueManager();
        this.streams = Object.entries(config.streams || {})
            .filter(([name, url]) => name.trim() && typeof url === 'string' && url.trim())
            .map(([name, url]) => ({ type: 'stream', name: name.trim(), url: url.trim() }));
        this.streamSearch = new Fuse(this.streams, {
            keys: ['name'], threshold: 0.45, ignoreLocation: true, minMatchCharLength: 2
        });
        this.jobs = new Set();
        this.current = null;
        this.activeRequest = null;
        this.cycle = null;
        this.prefetch = null;
        this.autoNext = null;
        this.previousName = null;
        this.lastError = null;
        this.stopped = false;
        this.playing = false;
        this.serverMode = config.bot?.serverUrl ? null : 'open';
        this.modeWait = this.playbackBlocked()
            ? new Promise((resolve) => { this.releaseModeWait = resolve; }) : null;
    }

    playbackBlocked() {
        return this.serverMode !== 'open' && this.serverMode !== 'turns';
    }

    restrictionStatus() {
        return this.serverMode ? `Theater stopped: server is in ${this.serverMode} mode`
            : 'Waiting for server mode';
    }

    setServerMode(mode) {
        if (this.stopped) return;
        const wasBlocked = this.playbackBlocked();
        this.serverMode = ['open', 'turns', 'admin', 'lockdown'].includes(mode) ? mode : null;
        if (this.playbackBlocked()) {
            if (!wasBlocked) {
                this.modeWait = new Promise((resolve) => { this.releaseModeWait = resolve; });
                this.interrupt();
                // Pending requests retain their positions, but their SMB work
                // stops until the server allows playback again.
                for (const entry of this.jobs) entry.lookupAbort?.abort();
            }
        } else if (wasBlocked) {
            this.releaseModeWait?.();
            this.modeWait = null;
            this.releaseModeWait = null;
        }
        this.sync();
    }

    async resolveWhenAllowed(entry, youtube) {
        while (!this.stopped) {
            if (this.modeWait) await waitFor(this.modeWait, entry.abort.signal);
            throwIfAborted(entry.abort.signal);
            const lookup = new AbortController();
            entry.lookupAbort = lookup;
            const cancel = () => lookup.abort();
            entry.abort.signal.addEventListener('abort', cancel, { once: true });
            try {
                return await this.resolve(entry.query, youtube, lookup.signal);
            } catch (error) {
                // A mode change suspends queued lookup; skip/replacement cancels it.
                if (error.name !== 'AbortError' || entry.abort.signal.aborted) throw error;
            } finally {
                entry.abort.signal.removeEventListener('abort', cancel);
                entry.lookupAbort = null;
            }
        }
        return null;
    }

    sync() {
        if (this.playbackBlocked()) this.state.status = this.restrictionStatus();
        this.state.queue = this.queue.getQueue().map((entry) => entry.item ? entry.item.name : entry.query);
        updateFormattedState(this.state);
        this.render(this.state);
    }

    async resolve(query, youtube, signal) {
        if (youtube) return { type: 'youtube', name: query, url: `ytdl://ytsearch:${query}` };
        // mpv pseudo-URLs are not ordinary web URLs. Preserve the exact source,
        // including spaces in ytsearch expressions, rather than URL-normalizing it.
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(query)) return { type: 'url', name: query, url: query };
        const stream = this.streams.find((item) => item.name.toLowerCase() === query.toLowerCase())
            || this.streamSearch.search(query)[0]?.item;
        if (stream) return { ...stream };
        await this.library.refresh(signal);
        throwIfAborted(signal);
        const match = this.library.findBestMatch(query);
        if (match.ok) return this.library.getFileItem(match.matched);
        this.notify(`No local match for “${query}”; searching YouTube…`);
        return { type: 'youtube', name: query, url: `ytdl://ytsearch:${query}` };
    }

    request(query, { next = false, youtube = false } = {}) {
        if (this.stopped) return;
        if (this.playbackBlocked()) throw new Error(this.restrictionStatus());
        if (!next) {
            // Only immediate requests supersede each other. Explicit !q
            // requests survive replacement of the currently selected item.
            for (const entry of this.queue.getQueue()) {
                if (entry.immediate) {
                    entry.abort.abort();
                    this.queue.remove(entry);
                }
            }
            this.interrupt();
        } else if ((!this.current && this.state.status !== 'searching') || this.state.status.startsWith('error:')) {
            this.cycle?.abort();
        }
        const entry = { query, immediate: !next, abort: new AbortController(), item: null };
        const position = this.queue.add(entry, !next);
        this.notify(next ? `Queued #${position}: ${query}` : `Preparing: ${query}`);
        entry.ready = this.resolveWhenAllowed(entry, youtube).then((item) => {
            throwIfAborted(entry.abort.signal);
            entry.item = item;
            if (next && this.queue.getQueue().includes(entry) && item.name !== query) {
                this.notify(`Queued: ${item.name}`);
            }
            this.sync();
            this.updatePrefetch();
            return item;
        }).catch((error) => {
            if (error.name !== 'AbortError') {
                this.reportError(query, error, true);
                this.queue.remove(entry);
            }
            return null;
        }).finally(() => {
            this.jobs.delete(entry);
            this.sync();
        });
        this.jobs.add(entry);
        this.updatePrefetch();
        this.sync();
    }

    interrupt() {
        this.cycle?.abort();
        this.activeRequest?.abort.abort();
        this.prefetch?.abort.abort();
    }

    skip() {
        if (this.playbackBlocked()) throw new Error(this.restrictionStatus());
        const pendingImmediate = this.queue.getQueue().find((entry) => entry.immediate);
        const active = Boolean(this.current || this.activeRequest || pendingImmediate
            || this.state.status === 'searching media library');
        if (!active) return false;
        if (pendingImmediate) {
            pendingImmediate.abort.abort();
            this.queue.remove(pendingImmediate);
        }
        this.interrupt();
        return true;
    }

    reportError(name, error, requested = false) {
        const message = String(error.message || error).replace(/\s+/g, ' ').slice(0, 300);
        const text = `${name}: ${message}`;
        // Automatic failures belong in local status and !info, never unsolicited chat.
        if (requested) {
            this.notify(`Couldn't play ${text}`);
        }
        this.lastError = { text, at: Date.now() };
    }

    protectCache() {
        this.cache.protected = new Set([
            this.current?.type === 'file' ? this.current.name : null,
            this.prefetch?.item.name
        ].filter(Boolean));
    }

    updatePrefetch() {
        if (!this.playing || this.stopped || this.playbackBlocked() || this.cycle?.signal.aborted) return;
        const firstRequest = this.queue.peek();
        let candidate = firstRequest?.item;
        if (!firstRequest) {
            if (!this.autoNext) {
                const name = this.queue.chooseRandom(this.library.getAutoplayVideos(), [this.current?.name]);
                if (name) this.autoNext = this.library.getFileItem(name);
            }
            candidate = this.autoNext;
        }
        if (candidate?.type !== 'file') candidate = null;
        if (candidate?.name === this.current?.name) candidate = null;
        if (this.prefetch) {
            if (this.prefetch.item.name === candidate?.name) return;
            if (!this.prefetch.done) {
                this.prefetch.abort.abort();
                return;
            }
            this.prefetch = null;
            this.protectCache();
        }
        if (!candidate) return;
        const job = { item: candidate, abort: new AbortController(), progress: null, done: false };
        this.prefetch = job;
        this.protectCache();
        // Resolve failures as data so speculative downloads never create an
        // unhandled rejection or interrupt the item people are watching.
        job.promise = this.cache.prepare(candidate, job.abort.signal, (progress) => {
            job.progress = progress;
            job.onProgress?.(progress);
        }).then((localPath) => ({ localPath }), (error) => ({ error })).then((result) => {
            job.done = true;
            job.result = result;
            if (result.error && result.error.name === 'AbortError' && this.prefetch === job) {
                this.prefetch = null;
                this.protectCache();
                this.updatePrefetch();
            }
            return result;
        });
    }

    async prepare(item, signal) {
        const prefetch = this.prefetch;
        if (prefetch) {
            const same = item.name === prefetch.item.name
                && item.metadata?.size === prefetch.item.metadata?.size
                && item.metadata?.modified === prefetch.item.metadata?.modified;
            if (!same) prefetch.abort.abort();
            if (same) {
                prefetch.onProgress = (progress) => {
                    if (signal.aborted) return;
                    this.state.downloadProgress = progress;
                    this.sync();
                };
                if (prefetch.progress) prefetch.onProgress(prefetch.progress);
            }
            const cancel = () => prefetch.abort.abort();
            signal.addEventListener('abort', cancel, { once: true });
            let result;
            try { result = await prefetch.promise; }
            finally {
                signal.removeEventListener('abort', cancel);
                prefetch.onProgress = null;
            }
            if (this.prefetch === prefetch) this.prefetch = null;
            this.protectCache();
            throwIfAborted(signal);
            if (same && result.localPath) return result.localPath;
            // A speculative transfer may have failed only because the previous
            // item occupied the cache. Foreground preparation gets its own attempt.
        }
        return this.cache.prepare(item, signal, (progress) => {
            if (signal.aborted) return;
            this.state.downloadProgress = progress;
            this.sync();
        });
    }

    async retry(signal) {
        let timer;
        try { await waitFor(new Promise((resolve) => { timer = setTimeout(resolve, 5000); }), signal); }
        finally { clearTimeout(timer); }
    }

    async run() {
        while (!this.stopped) {
            if (this.modeWait) {
                this.sync();
                await this.modeWait;
            }
            if (this.stopped) break;
            this.cycle = new AbortController();
            const { signal } = this.cycle;
            const entry = this.queue.shift();
            this.activeRequest = entry || null;
            this.state = createPlayerState();
            try {
                let item;
                if (entry) {
                    this.state.title = entry.query;
                    this.state.status = 'searching';
                    this.sync();
                    item = await waitFor(entry.ready, signal);
                    if (!item) continue;
                } else {
                    this.state.status = 'searching media library';
                    this.sync();
                    await this.library.refresh(signal);
                    throwIfAborted(signal);
                    // A request arriving during the automatic scan takes priority.
                    if (this.queue.peek()) continue;
                    const names = this.library.getAutoplayVideos();
                    let name = this.autoNext && this.autoNext.name !== this.previousName && names.includes(this.autoNext.name)
                        ? this.autoNext.name : null;
                    if (!name) name = this.queue.chooseRandom(names, [this.previousName]);
                    if (!name && names.length === 1) name = names[0];
                    this.autoNext = null;
                    if (!name) {
                        this.state.status = 'no videos found, retrying';
                        this.sync();
                        await this.retry(signal);
                        continue;
                    }
                    item = this.library.getFileItem(name);
                }
                throwIfAborted(signal);
                this.current = item;
                if (this.autoNext?.name === item.name) this.autoNext = null;
                this.protectCache();
                this.state.title = item.name;
                this.state.playbackType = item.type;
                this.state.status = item.type === 'file' ? 'downloading' : 'opening';
                this.sync();
                if (entry && !entry.immediate) this.notify(`Preparing: ${item.name}`);
                let source = item.url;
                if (item.type === 'file') source = await this.prepare(item, signal);
                else if (this.prefetch) {
                    this.prefetch.abort.abort();
                    await this.prefetch.promise;
                    this.prefetch = null;
                    this.protectCache();
                }
                throwIfAborted(signal);
                this.state.downloadProgress = null;
                this.state.status = 'opening';
                this.sync();
                let announced = false;
                await playWithMpv(source, this.config.display, signal, ({ started, properties }) => {
                    if (signal.aborted) return;
                    this.playing = started;
                    if (item.type !== 'file' && properties['media-title']) this.state.title = properties['media-title'];
                    this.state.durationSeconds = Number.isFinite(properties.duration) ? properties.duration : null;
                    this.state.elapsedSeconds = Number.isFinite(properties['time-pos']) ? properties['time-pos'] : null;
                    this.state.remainingSeconds = this.state.durationSeconds != null && this.state.elapsedSeconds != null
                        ? Math.max(0, this.state.durationSeconds - this.state.elapsedSeconds) : null;
                    this.state.status = !started ? 'opening' : properties.pause ? 'paused'
                        : properties['paused-for-cache'] ? 'buffering' : 'playing';
                    if (started && !announced) {
                        announced = true;
                        this.lastError = null;
                        if (entry) this.notify(`Now playing: ${this.state.title}`);
                        this.updatePrefetch();
                    }
                    this.sync();
                });
            } catch (error) {
                this.playing = false;
                if (error.name !== 'AbortError') {
                    this.reportError(this.current?.name || entry?.query || 'Library', error, Boolean(entry));
                    this.state.status = `error: ${error.message}; retrying`;
                    this.sync();
                    // Pending requests should not wait behind a failed auto item.
                    if (!this.queue.peek()) {
                        try { await this.retry(signal); } catch (_) {}
                    }
                }
            } finally {
                if (this.current?.type === 'file') this.previousName = this.current.name;
                this.playing = false;
                this.current = null;
                this.activeRequest = null;
                this.protectCache();
            }
        }
    }

    sourceLabel() {
        return ({ file: 'Library', stream: 'Configured stream', youtube: 'YouTube', url: 'URL' })[this.current?.type] || 'Request';
    }

    now(includeNext = true) {
        if (this.playbackBlocked()) return this.restrictionStatus();
        const state = this.state;
        const progress = state.downloadProgress;
        const detail = progress ? `${Math.round((progress.percent || 0) * 100)}% downloaded`
            : state.progressLabel;
        const lines = this.current || this.activeRequest
            ? [`${state.status}: ${state.title}`, `Source: ${this.sourceLabel()} • ${detail}`]
            : [`Status: ${state.status}`];
        if (includeNext) {
            const next = this.queue.peek();
            lines.push(`Next: ${next ? next.item?.name || next.query : 'Automatic random playback'}`);
        }
        return lines.join('\n');
    }

    info() {
        const requests = this.queue.getQueue();
        const next = requests[0];
        const lines = [this.now(false)];
        if (next) {
            lines.push(`Next request: ${next.item?.name || next.query}${next.item ? '' : this.playbackBlocked() ? ' (waiting)' : ' (searching)'}${requests.length > 1 ? ` (+${requests.length - 1} requests)` : ''}`);
        } else {
            lines.push(`No pending requests; random playback${this.autoNext ? ` next: ${this.autoNext.name}` : ''}`);
        }
        if (this.current) lines.push(`Selection: ${this.activeRequest ? 'Requested' : 'Automatic random'}`);
        if (this.prefetch) {
            const job = this.prefetch;
            const status = job.result?.error ? `Unavailable: ${job.result.error.message}`
                : job.done ? 'Ready' : `${Math.round((job.progress?.percent || 0) * 100)}%`;
            lines.push(`Download: ${job.item.name} — ${status}`);
        }
        const partialBytes = !this.prefetch?.done && this.prefetch?.progress
            ? this.prefetch.progress.transferredBytes : this.state.downloadProgress?.transferredBytes || 0;
        lines.push(`Cache: ${formatBytes(this.cache.usage() + partialBytes)} / ${formatBytes(this.cache.maxBytes)}`);
        lines.push(`Library: ${this.library.getAllVideos().length} files • ${this.streams.length} configured streams`);
        if (this.lastError) lines.push(`Latest failure: ${this.lastError.text}`);
        return lines.join('\n');
    }

    listStreams() {
        return this.streams.length ? `Configured streams (${this.streams.length}):\n${this.streams.map((stream) => stream.name).join('\n')}`
            : 'No streams configured.';
    }

    async close() {
        this.stopped = true;
        this.releaseModeWait?.();
        this.interrupt();
        for (const entry of this.jobs) entry.abort.abort();
        await Promise.allSettled([...Array.from(this.jobs, (entry) => entry.ready), this.prefetch?.promise, this.library.scanTail]);
    }
}

module.exports = { PlayerController };
