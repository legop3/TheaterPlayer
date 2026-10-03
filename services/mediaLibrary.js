const fs = require('fs');
const path = require('path');
const { startProcess, throwIfAborted, waitFor } = require('./process');
const SambaClient = require('samba-client');
const Fuse = require('fuse.js');

const VIDEO_EXTENSIONS = new Set([
    '.mp4',
    '.mkv',
    '.mov',
    '.avi',
    '.webm',
    '.m4v'
]);
const MEDIA_EXTENSIONS = new Set([
    ...VIDEO_EXTENSIONS,
    '.mp3',
    '.flac',
    '.wav',
    '.ogg',
    '.opus',
    '.m4a',
    '.aac'
]);
const TOP_LEVEL_SCAN_CONCURRENCY = 4;
const DEFAULT_IGNORED_DIRECTORIES = new Set([
    '.hist',
    '.history',
    '.metadata',
    '.thumbs',
    '.thumbnails',
    '@eadir'
]);
const MISSING_LISTING_PATTERN = /^NT_STATUS_(NO_SUCH_FILE|OBJECT_NAME_NOT_FOUND) listing /;

function isDirectory(file) {
    // smbclient exposes SMB attribute letters as `type`. Directories include
    // "D", sometimes mixed with other attributes, so checking for containment is
    // safer than checking equality against one exact value.
    return String(file.type || '').includes('D');
}

function isMediaFile(file) {
    // Treat any non-directory entry with a known media extension as playable.
    // SMB servers may report normal files as "N", "A", or another non-directory
    // attribute mix, so extension plus "not a directory" is the reliable filter.
    return !isDirectory(file) && MEDIA_EXTENSIONS.has(path.extname(file.name).toLowerCase());
}

function normalizeSmbPath(smbPath) {
    // smbclient prints remote paths with backslashes because it follows SMB's
    // Windows-style path syntax. The rest of this app stores forward-slash paths
    // so search, UI display, local cache paths, and samba-client downloads all
    // use one consistent representation.
    return String(smbPath || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
}

function shouldSkipDirectory(name) {
    // smbclient directory listings commonly include "." and "..". Recursing into
    // either one would loop forever. The other defaults are metadata/cache
    // folders that can contain thousands of irrelevant files and should never be
    // searched for playable media.
    return name === '.' || name === '..' || DEFAULT_IGNORED_DIRECTORIES.has(String(name).toLowerCase());
}

function joinRemotePath(parentPath, childName) {
    const normalizedParent = normalizeSmbPath(parentPath);
    return normalizedParent ? path.posix.join(normalizedParent, childName) : childName;
}

function stripBaseDirectory(remoteDir, baseDirectory) {
    const normalizedDir = normalizeSmbPath(remoteDir);
    const normalizedBase = normalizeSmbPath(baseDirectory);

    // With `-D`, smbclient can still print recursive directory markers as full
    // paths such as "\OMVshare\HFS\rover_theater\movies". Downloads are issued
    // relative to that same configured directory, so the library must strip the
    // configured prefix and keep only "movies".
    if (!normalizedBase) return normalizedDir;
    if (normalizedDir === normalizedBase) return '';
    if (normalizedDir.startsWith(normalizedBase + '/')) {
        return normalizedDir.slice(normalizedBase.length + 1);
    }

    return normalizedDir;
}

function parseRecursiveListing(output, baseDirectory) {
    const videos = [];
    let currentDir = '';

    for (const rawLine of String(output || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        // smbclient prints a directory marker before recursively listed entries.
        // Tracking that marker is how extension-filtered recursive results become
        // the same SMB-relative paths used by queueing and downloads.
        if (line.startsWith('\\')) {
            currentDir = stripBaseDirectory(line, baseDirectory);
            continue;
        }

        // File rows are "name  attributes size  timestamp". The filename can
        // contain spaces, so the parser anchors on the wide whitespace before the
        // SMB attribute field instead of splitting on every space.
        const match = line.match(/^(.+?)\s{2,}([A-Z0-9]{1,2})\s+([0-9]+)\s{2,}(.+)$/);
        if (!match) continue;

        const name = match[1].trim();
        const type = match[2];
        if (!name || shouldSkipDirectory(name) || type.includes('D')) continue;

        const remotePath = joinRemotePath(currentDir, name);
        if (MEDIA_EXTENSIONS.has(path.posix.extname(remotePath).toLowerCase())) {
            // Preserve the size already included in smbclient's listing. The
            // downloader needs the remote total to calculate a real percentage
            // and ETA while the destination file grows.
            videos.push({ name: remotePath, size: Number(match[3]), modified: match[4].trim() });
        }
    }

    return videos;
}

async function runSmbClient(args, signal, allowMissing = false) {
    const { proc, done } = startProcess('smbclient', args, { signal });
    const stdoutChunks = [];
    let stderr = '';
    proc.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    const { code } = await done;
    const stdout = Buffer.concat(stdoutChunks).toString();
    if (code !== 0) {
        const detail = `${stderr}\n${stdout}`.trim();
        const statuses = detail.split(/\r?\n/).map((line) => line.trim())
            .filter((line) => line.startsWith('NT_STATUS_'));
        // Empty extension matches are normal during a recursive library scan.
        if (!allowMissing || !statuses.length || !statuses.every((line) => MISSING_LISTING_PATTERN.test(line))) {
            throw new Error(detail.slice(-2000) || `smbclient exited with code ${code}`);
        }
    }
    return stdout;
}

function createClient(config, signal) {
    const client = new SambaClient(config);
    // Keep the library's SMB argument construction and listing parser, but own
    // its child process so cancellation reaches both scans and downloads.
    client.execute = (command, args) => runSmbClient(client.getSmbClientArgs(command, args), signal);
    return client;
}

class MediaLibrary {
    constructor(smbConfig) {
        this.smbConfig = smbConfig;
        this.allVideos = [];
        this.metadata = new Map();
        this.scanTail = Promise.resolve();
    }

    async refresh(signal) {
        // Each caller gets its own fresh scan. Serialize scans to avoid flooding
        // the share, rather than returning an older or already-running snapshot.
        const scan = this.scanTail.then(async () => {
            throwIfAborted(signal);
            const videos = await this.listVideosHybrid(signal);
            throwIfAborted(signal);
            this.allVideos = videos.map((video) => video.name);
            this.metadata = new Map(videos.map((video) => [video.name, video]));
            return this.allVideos;
        });
        this.scanTail = scan.catch(() => {});
        return waitFor(scan, signal);
    }

    getFileItem(name) {
        return { type: 'file', name, metadata: this.metadata.get(name) };
    }

    async listRootDirectory(signal) {
        const videos = [];
        const childDirectories = [];
        const remoteFiles = await createClient(this.smbConfig, signal).list('*');

        for (const file of remoteFiles) {
            if (isDirectory(file)) {
                if (shouldSkipDirectory(file.name)) continue;

                // Root is the only directory we inspect entry-by-entry. That lets
                // us reject `.hist` before any recursive command can enter it,
                // while still avoiding one SMB command for every nested folder.
                childDirectories.push(file.name);
                continue;
            }

            if (isMediaFile(file)) {
                videos.push({ name: file.name, size: file.size, modified: Number.isFinite(file.modifyTime.getTime()) ? file.modifyTime.toISOString() : null });
            }
        }

        return { videos, childDirectories };
    }

    buildRecursiveListArgs(remoteDir) {
        const args = [];
        const scanDirectory = joinRemotePath(this.smbConfig.directory, remoteDir);

        // Match samba-client's auth behavior so scanning and downloading work
        // from the same simple config. Guest shares get `-N`; authenticated
        // shares can still use username/password/domain when present.
        args.push('-U', this.smbConfig.username || 'guest');
        if (this.smbConfig.password) args.push('--password', this.smbConfig.password);
        else args.push('-N');

        if (this.smbConfig.domain) args.push('-W', this.smbConfig.domain);
        if (scanDirectory) args.push('-D', scanDirectory);
        if (this.smbConfig.maxProtocol) args.push('--max-protocol', this.smbConfig.maxProtocol);
        if (this.smbConfig.port) args.push('-p', String(this.smbConfig.port));
        if (this.smbConfig.timeout) args.push('-t', String(this.smbConfig.timeout));

        // Scope recursion to one allowed top-level folder. smbclient still walks
        // that folder internally, but it never gets a chance to enter ignored
        // root metadata folders such as `.hist`.
        const listCommands = Array.from(MEDIA_EXTENSIONS, (extension) => `ls *${extension}`);
        args.push('-c', ['recurse', ...listCommands].join(';'), this.smbConfig.address);
        return args;
    }

    async listVideosUnderTopLevelDirectory(remoteDir, signal) {
        const output = await runSmbClient(this.buildRecursiveListArgs(remoteDir), signal, true);
        const scanDirectory = joinRemotePath(this.smbConfig.directory, remoteDir);
        return parseRecursiveListing(output, scanDirectory).map((video) => ({
            name: joinRemotePath(remoteDir, video.name),
            size: video.size,
            modified: video.modified
        }));
    }

    async listVideosHybrid(signal) {
        const root = await this.listRootDirectory(signal);
        const videos = root.videos.slice();

        // The hybrid scan is intentionally shaped around this share's bottleneck:
        // skip metadata folders at root, then let smbclient recurse internally
        // inside only the allowed media folders. Batching keeps startup responsive
        // without launching an unbounded number of smbclient processes.
        for (let i = 0; i < root.childDirectories.length; i += TOP_LEVEL_SCAN_CONCURRENCY) {
            const batch = root.childDirectories.slice(i, i + TOP_LEVEL_SCAN_CONCURRENCY);
            throwIfAborted(signal);
            const results = await Promise.allSettled(batch.map((remoteDir) => this.listVideosUnderTopLevelDirectory(remoteDir, signal)));

            for (const result of results) {
                if (result.status === 'rejected') throw result.reason;
                videos.push(...result.value);
            }
        }

        return videos;
    }

    getAllVideos() {
        return this.allVideos.slice();
    }

    getAutoplayVideos() {
        // Audio stays searchable for explicit requests, but never fills autoplay.
        return this.allVideos.filter((name) => VIDEO_EXTENSIONS.has(path.posix.extname(name).toLowerCase()));
    }

    async download(item, localPath, signal, onProgress = () => {}) {
        // smbclient has its own command tokenizer in addition to process argv.
        // Reject delimiters it cannot safely represent inside a quoted filename.
        if (/[";\r\n]/.test(item.name) || /[";\r\n]/.test(localPath)) {
            throw new Error('SMB filename contains unsupported command delimiters');
        }
        const totalBytes = item.metadata && item.metadata.size;
        const startedAt = Date.now();
        const reportProgress = () => {
            let transferredBytes = 0;
            try { transferredBytes = fs.statSync(localPath).size; } catch (_) {}
            const bytesPerSecond = transferredBytes / Math.max((Date.now() - startedAt) / 1000, 0.001);
            onProgress({
                transferredBytes, totalBytes, bytesPerSecond,
                percent: totalBytes > 0 ? Math.min(1, transferredBytes / totalBytes) : null,
                etaSeconds: Number.isFinite(totalBytes) && bytesPerSecond > 0
                    ? Math.max(0, totalBytes - transferredBytes) / bytesPerSecond : null
            });
        };
        reportProgress();
        const timer = setInterval(reportProgress, 250);
        try {
            await createClient(this.smbConfig, signal).getFile(item.name, localPath);
            throwIfAborted(signal);
            reportProgress();
        } finally {
            clearInterval(timer);
        }
    }

    findBestMatch(query) {
        const q = String(query || '').trim();
        if (!q) return { ok: false, message: 'Usage: !play <search text>' };
        if (this.allVideos.length === 0) return { ok: false, message: 'No videos found.' };

        // Fuse searches objects here instead of plain strings so a person can
        // match either the full folder path ("horror alien") or just the file
        // name ("alien"). The returned value remains the SMB-relative path,
        // because that path is what the queue and downloader need.
        const searchableVideos = this.allVideos.map((name) => ({
            name,
            basename: path.posix.basename(name),
            folder: path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name)
        }));

        const fuse = new Fuse(searchableVideos, {
            keys: [
                { name: 'name', weight: 0.65 },
                { name: 'basename', weight: 0.3 },
                { name: 'folder', weight: 0.05 }
            ],
            includeScore: true,
            threshold: 0.45,
            ignoreLocation: true,
            minMatchCharLength: 2
        });

        const results = fuse.search(q);
        if (results.length === 0) return { ok: false, message: `No match for "${q}".` };
        return { ok: true, matched: results[0].item.name };
    }
}

module.exports = { MediaLibrary };
