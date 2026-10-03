class QueueManager {
    constructor() {
        this.requests = [];
    }

    add(request, immediate = false) {
        // Reserve a position before asynchronous lookup so requests stay in
        // arrival order even when different sources take different times.
        if (immediate) this.requests.unshift(request);
        else this.requests.push(request);
        return this.requests.length;
    }

    remove(request) {
        const index = this.requests.indexOf(request);
        if (index !== -1) this.requests.splice(index, 1);
    }

    shift() { return this.requests.shift(); }
    peek() { return this.requests[0]; }
    getQueue() { return this.requests.slice(); }

    chooseRandom(names, excluded = []) {
        const blocked = new Set(excluded.filter(Boolean));
        for (const request of this.requests) {
            if (request.item && request.item.type === 'file') blocked.add(request.item.name);
        }
        const candidates = names.filter((name) => !blocked.has(name));
        return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
    }
}

module.exports = { QueueManager };
