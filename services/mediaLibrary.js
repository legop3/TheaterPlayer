const fs = require('fs');
const path = require('path');
const SambaClient = require('samba-client');
const Fuse = require('fuse.js');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v']);
const SMB_ROOT_PATTERN = '*';

function isVideoFile(file) {
    // smbclient reports file attributes as compact strings. Directories include
    // "D", while normal files can be reported as "N" or with archive/hidden
    // attributes depending on the server. Treat any non-directory entry with a
    // video extension as playable so NAS-specific attributes do not hide videos.
    return !isDirectory(file) && VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase());
}

function isDirectory(file) {
    // The Samba wrapper exposes the raw smbclient attribute field as `type`.
    // Checking for "D" is the important part because SMB folders can be "D",
    // "DA", or another combination of attributes depending on the share.
    return String(file.type || '').includes('D');
}

function shouldSkipDirectory(name) {
    // smbclient directory listings commonly include "." and "..". Recursing
    // into either one would loop forever, so they are filtered before building
    // child paths.
    return name === '.' || name === '..';
}

function joinRemotePath(parentPath, childName) {
    // SMB commands in samba-client accept forward-slash paths and translate them
    // to backslashes internally. path.posix keeps the saved library names stable
    // on every OS and avoids Windows-style separators leaking into search/UI text.
    return parentPath ? path.posix.join(parentPath, childName) : childName;
}

class MediaLibrary {
    constructor(smbConfig) {
        this.client = new SambaClient({
            address: smbConfig.address,
            directory: smbConfig.directory
        });
        this.allVideos = [];
    }

    async refresh() {
        // Keep the public library as SMB-relative paths. That lets one string do
        // all three jobs consistently: display in the UI, search in Fuse, and
        // download from the share with samba-client.getFile().
        this.allVideos = await this.listVideosRecursive('');
        return this.allVideos;
    }

    async listVideosRecursive(remoteDir) {
        const videos = [];
        const listPattern = remoteDir ? joinRemotePath(remoteDir, SMB_ROOT_PATTERN) : SMB_ROOT_PATTERN;
        const remoteFiles = await this.client.list(listPattern);

        for (const file of remoteFiles) {
            const remotePath = joinRemotePath(remoteDir, file.name);

            if (isDirectory(file)) {
                if (shouldSkipDirectory(file.name)) continue;

                // Folder support needs real recursion because samba-client.list()
                // only returns the entries for the pattern it is given. A nested
                // video such as "movies/trailers/foo.mkv" is invisible unless each
                // parent folder is listed and then walked.
                videos.push(...await this.listVideosRecursive(remotePath));
                continue;
            }

            if (isVideoFile(file)) {
                videos.push(remotePath);
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
