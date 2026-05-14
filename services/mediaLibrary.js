const path = require('path');
const SambaClient = require('samba-client');
const Fuse = require('fuse.js');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v']);

function isVideoFile(file) {
    return file.type === 'N' && VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase());
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
        const remoteFiles = await this.client.list('*');
        this.allVideos = remoteFiles.filter(isVideoFile).map((f) => f.name);
        return this.allVideos;
    }

    getAllVideos() {
        return this.allVideos.slice();
    }

    async download(name, localPath) {
        await this.client.getFile(name, localPath);
    }

    findBestMatch(query) {
        const q = String(query || '').trim();
        if (!q) return { ok: false, message: 'Usage: !tfind <search text>' };
        if (this.allVideos.length === 0) return { ok: false, message: 'No videos found.' };

        const fuse = new Fuse(this.allVideos, {
            includeScore: true,
            threshold: 0.45,
            ignoreLocation: true,
            minMatchCharLength: 2
        });

        const results = fuse.search(q);
        if (results.length === 0) return { ok: false, message: `No match for "${q}".` };
        return { ok: true, matched: results[0].item };
    }
}

module.exports = { MediaLibrary };
