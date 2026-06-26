const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const SambaClient = require('samba-client');
const Fuse = require('fuse.js');

const MEDIA_EXTENSIONS = new Set([
    '.mp4',
    '.mkv',
    '.mov',
    '.avi',
    '.webm',
    '.m4v',
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
        const match = line.match(/^(.+?)\s{2,}([A-Z0-9]{1,2})\s+([0-9]+)\s{2,}.+$/);
        if (!match) continue;

        const name = match[1].trim();
        const type = match[2];
        if (!name || shouldSkipDirectory(name) || type.includes('D')) continue;

        const remotePath = joinRemotePath(currentDir, name);
        if (MEDIA_EXTENSIONS.has(path.posix.extname(remotePath).toLowerCase())) {
            videos.push(remotePath);
        }
    }

    return videos;
}

function runSmbClient(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn('smbclient', args);
        const stdoutChunks = [];
        const stderrChunks = [];

        proc.stdout.on('data', (chunk) => {
            // Stream raw smbclient output live because the scan itself is useful
            // console feedback. Keep the same chunks for parsing once the command
            // exits so display and behavior come from one command execution.
            process.stdout.write(chunk);
            stdoutChunks.push(chunk);
        });

        proc.stderr.on('data', (chunk) => {
            // smbclient status and error details are part of the command output
            // the user asked to see, so stderr is streamed too while still being
            // retained for error classification.
            process.stderr.write(chunk);
            stderrChunks.push(chunk);
        });

        proc.on('error', reject);
        proc.on('close', (code) => {
            const stdout = Buffer.concat(stdoutChunks).toString();
            const stderr = Buffer.concat(stderrChunks).toString();

            if (code !== 0) {
                // smbclient reports useful failures in stderr/stdout, especially
                // path and auth errors. Preserve that detail so UI/status messages
                // explain the real failure instead of only showing an exit code.
                const detail = `${stderr || ''}${stdout || ''}`.trim();
                const detailLines = detail.split(/\r?\n/).filter(Boolean);
                const statusLines = detailLines.filter((line) => line.trim().startsWith('NT_STATUS_'));
                const onlyMissingListings = statusLines.length > 0
                    && statusLines.every((line) => MISSING_LISTING_PATTERN.test(line.trim()));

                if (onlyMissingListings) {
                    // Extension-filtered scans are allowed to find no matching
                    // files for some or all extensions. smbclient reports that
                    // as a nonzero status even when other extensions produced
                    // valid output, so keep stdout and let the parser ignore the
                    // missing-listing status lines.
                    resolve(stdout || '');
                    return;
                }

                reject(new Error(detail || `smbclient exited with code ${code}`));
                return;
            }

            resolve(stdout);
        });
    });
}

class MediaLibrary {
    constructor(smbConfig) {
        this.smbConfig = smbConfig;
        this.client = new SambaClient({
            address: smbConfig.address,
            username: smbConfig.username,
            password: smbConfig.password,
            domain: smbConfig.domain,
            port: smbConfig.port,
            directory: smbConfig.directory,
            timeout: smbConfig.timeout,
            maxProtocol: smbConfig.maxProtocol
        });
        this.allVideos = [];
    }

    async refresh() {
        // Keep the public library as SMB-relative paths. That lets one string do
        // all three jobs consistently: display in the UI, search in Fuse, and
        // download from the share with samba-client.getFile().
        this.allVideos = await this.listVideosHybrid();
        return this.allVideos;
    }

    async listRootDirectory() {
        const videos = [];
        const childDirectories = [];
        const remoteFiles = await this.client.list('*');

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
                videos.push(file.name);
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

    async listVideosUnderTopLevelDirectory(remoteDir) {
        const output = await runSmbClient(this.buildRecursiveListArgs(remoteDir));
        const scanDirectory = joinRemotePath(this.smbConfig.directory, remoteDir);
        return parseRecursiveListing(output, scanDirectory).map((name) => joinRemotePath(remoteDir, name));
    }

    async listVideosHybrid() {
        const root = await this.listRootDirectory();
        const videos = root.videos.slice();

        // The hybrid scan is intentionally shaped around this share's bottleneck:
        // skip metadata folders at root, then let smbclient recurse internally
        // inside only the allowed media folders. Batching keeps startup responsive
        // without launching an unbounded number of smbclient processes.
        for (let i = 0; i < root.childDirectories.length; i += TOP_LEVEL_SCAN_CONCURRENCY) {
            const batch = root.childDirectories.slice(i, i + TOP_LEVEL_SCAN_CONCURRENCY);
            const results = await Promise.all(batch.map((remoteDir) => this.listVideosUnderTopLevelDirectory(remoteDir)));

            for (const result of results) {
                videos.push(...result);
            }
        }

        return videos;
    }

    getAllVideos() {
        return this.allVideos.slice();
    }

    async download(name, localPath) {
        try {
            const stat = fs.statSync(localPath);
            if (stat.isFile() && stat.size > 0) {
                return { fromCache: true };
            }
        } catch (_) {}

        await this.client.getFile(name, localPath);
        return { fromCache: false };
    }

    findBestMatch(query) {
        const q = String(query || '').trim();
        if (!q) return { ok: false, message: 'Usage: !tfind <search text>' };
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
