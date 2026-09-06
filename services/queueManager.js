function chooseRandom(items) {
    return items[Math.floor(Math.random() * items.length)];
}

function createFileItem(name) {
    // The player loop needs to know whether an item should be downloaded from
    // SMB or handed directly to mpv. Keeping that reason in a tiny object avoids
    // guessing from the value later, which matters because URLs and filenames
    // are prepared in very different ways.
    return { type: 'file', name };
}

function getItemKey(item) {
    // Queue de-duplication only needs a stable identity, not the full object.
    // Files are keyed by SMB-relative name. Streams are keyed by URL so the same
    // live source does not appear repeatedly under slightly different aliases.
    if (!item || typeof item !== 'object') return String(item || '');
    if (item.type === 'stream') return `stream:${item.url}`;
    return `file:${item.name}`;
}

function getItemDisplayName(item) {
    // Terminal and chat output should stay human-readable. Stream aliases
    // display as their alias, while direct URLs display as the URL itself.
    if (!item || typeof item !== 'object') return String(item || '');
    return item.name || item.url || '';
}

class QueueManager {
    constructor(targetSize) {
        this.targetSize = targetSize;
        this.queue = [];
        this.forcedNextItem = null;
    }

    getQueue() {
        return this.queue.slice();
    }

    getDisplayQueue() {
        return this.queue.map(getItemDisplayName);
    }

    refill(allVideos, currentName) {
        const blocked = new Set(this.queue.map(getItemKey));
        if (currentName) blocked.add(getItemKey(createFileItem(currentName)));

        while (this.queue.length < this.targetSize) {
            const candidates = allVideos.filter((name) => !blocked.has(getItemKey(createFileItem(name))));
            if (candidates.length === 0) break;
            const picked = chooseRandom(candidates);
            const item = createFileItem(picked);
            this.queue.push(item);
            blocked.add(getItemKey(item));
        }
    }

    shiftNext() {
        if (this.forcedNextItem) {
            const item = this.forcedNextItem;
            this.forcedNextItem = null;
            // `forceNext()` also places the item at the front of the visible
            // queue so the UI immediately reflects what will play next. Remove
            // that visible copy when the loop consumes the forced item, otherwise
            // the same file or stream would remain queued and play a second time.
            if (this.queue.length > 0 && getItemKey(this.queue[0]) === getItemKey(item)) {
                this.queue.shift();
            }
            return item;
        }
        return this.queue.shift();
    }

    forceNext(item) {
        const key = getItemKey(item);
        this.forcedNextItem = item;
        const idx = this.queue.findIndex((queuedItem) => getItemKey(queuedItem) === key);
        if (idx !== -1) this.queue.splice(idx, 1);
        this.queue.unshift(item);
    }
}

module.exports = { QueueManager, createFileItem, getItemDisplayName };
