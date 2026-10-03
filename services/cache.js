const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { throwIfAborted } = require('./process');

class MediaCache {
    constructor(config = {}, library) {
        this.directory = path.resolve(config.cacheDir || '/var/tmp/theaterplayer');
        this.maxBytes = (config.maxGb ?? 20) * 1024 ** 3;
        if (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0) {
            throw new Error('storage.maxGb must be a positive number');
        }
        this.library = library;
        this.protected = new Set();
        fs.mkdirSync(this.directory, { recursive: true });
        this.indexPath = path.join(this.directory, 'cache-index.json');
        try {
            this.entries = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
            if (!this.entries || typeof this.entries !== 'object' || Array.isArray(this.entries)) this.entries = {};
        } catch (error) {
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
            this.entries = {};
        }
        // Unindexed files cannot be distinguished from interrupted old downloads.
        // This directory is exclusively the disposable theater cache.
        const known = new Set(Object.keys(this.entries).map((name) => this.filename(name)));
        for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
            if (entry.name === 'cache-index.json') continue;
            if (!entry.isFile() || !known.has(entry.name)) {
                fs.rmSync(path.join(this.directory, entry.name), { recursive: true, force: true });
            }
        }
        for (const name of Object.keys(this.entries)) {
            try {
                if (fs.statSync(this.localPath(name)).size !== this.entries[name].size) this.remove(name);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                delete this.entries[name];
            }
        }
        this.makeRoom(0);
        this.save();
    }

    filename(name) {
        // Hash identity, retaining the extension for mpv's audio visualizer.
        return createHash('sha256').update(name).digest('hex') + path.posix.extname(name);
    }
    localPath(name) { return path.join(this.directory, this.filename(name)); }
    usage() { return Object.values(this.entries).reduce((sum, entry) => sum + entry.size, 0); }
    save() {
        fs.writeFileSync(`${this.indexPath}.part`, JSON.stringify(this.entries));
        fs.renameSync(`${this.indexPath}.part`, this.indexPath);
    }
    remove(name) {
        fs.rmSync(this.localPath(name), { force: true });
        delete this.entries[name];
    }

    makeRoom(bytes) {
        if (bytes > this.maxBytes) throw new Error('File exceeds the configured cache limit');
        const available = () => {
            const stat = fs.statfsSync(this.directory);
            return stat.bavail * stat.bsize;
        };
        const candidates = Object.keys(this.entries).filter((name) => !this.protected.has(name))
            .sort((a, b) => this.entries[a].usedAt - this.entries[b].usedAt);
        while ((this.usage() + bytes > this.maxBytes || available() < bytes) && candidates.length) {
            this.remove(candidates.shift());
        }
        this.save();
        if (this.usage() + bytes > this.maxBytes || available() < bytes) {
            throw new Error('Not enough cache space; active media is protected');
        }
    }

    async prepare(item, signal, onProgress = () => {}) {
        throwIfAborted(signal);
        const metadata = item.metadata;
        if (!metadata || !Number.isFinite(metadata.size) || metadata.size <= 0) {
            throw new Error('File has no usable size in the SMB listing');
        }
        const cached = this.entries[item.name];
        if (cached && cached.size === metadata.size && cached.modified === metadata.modified) {
            try {
                if (fs.statSync(this.localPath(item.name)).size === cached.size) {
                    cached.usedAt = Date.now();
                    this.save();
                    return this.localPath(item.name);
                }
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        this.remove(item.name);
        this.makeRoom(metadata.size);
        const destination = this.localPath(item.name);
        const partial = `${destination}.part`;
        const transfer = new AbortController();
        const cancel = () => transfer.abort();
        signal.addEventListener('abort', cancel, { once: true });
        let changedSize = false;
        try {
            await this.library.download(item, partial, transfer.signal, (progress) => {
                // The remote file can grow after listing. Abort before promoting
                // an unexpectedly large file, rather than treating it as complete.
                if (progress.transferredBytes > metadata.size) {
                    changedSize = true;
                    transfer.abort();
                }
                onProgress(progress);
            });
            throwIfAborted(signal);
            const size = fs.statSync(partial).size;
            if (size !== metadata.size) throw new Error('File changed or download was incomplete; try again');
            fs.renameSync(partial, destination);
            this.entries[item.name] = { size, modified: metadata.modified, usedAt: Date.now() };
            this.save();
            return destination;
        } catch (error) {
            if (changedSize) throw new Error('File grew during download; try again');
            if (error.code === 'ENOSPC' || /No space left on device/i.test(error.message)) {
                throw new Error('Not enough free disk space for this download');
            }
            throw error;
        } finally {
            signal.removeEventListener('abort', cancel);
            fs.rmSync(partial, { force: true });
        }
    }
}

module.exports = { MediaCache };
