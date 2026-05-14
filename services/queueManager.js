function chooseRandom(items) {
    return items[Math.floor(Math.random() * items.length)];
}

class QueueManager {
    constructor(targetSize) {
        this.targetSize = targetSize;
        this.queue = [];
        this.forcedNextName = null;
    }

    getQueue() {
        return this.queue.slice();
    }

    refill(allVideos, currentName) {
        const blocked = new Set(this.queue);
        if (currentName) blocked.add(currentName);

        while (this.queue.length < this.targetSize) {
            const candidates = allVideos.filter((name) => !blocked.has(name));
            if (candidates.length === 0) break;
            const picked = chooseRandom(candidates);
            this.queue.push(picked);
            blocked.add(picked);
        }
    }

    shiftNext() {
        if (this.forcedNextName) {
            const name = this.forcedNextName;
            this.forcedNextName = null;
            return name;
        }
        return this.queue.shift();
    }

    forceNext(name) {
        this.forcedNextName = name;
        const idx = this.queue.indexOf(name);
        if (idx !== -1) this.queue.splice(idx, 1);
        this.queue.unshift(name);
    }
}

module.exports = { QueueManager };
