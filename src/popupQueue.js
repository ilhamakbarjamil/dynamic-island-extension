// One pending event per feature. New events replace stale previews, not history.
export class PopupQueue {
    constructor(now = () => Date.now()) {
        this._now = now;
        this.pending = new Map();
        this.active = null;
    }
    request(key, priority, callback, blocked = false) {
        if (blocked || (this.active && this.active.key !== key && this.active.priority >= priority)) {
            this.pending.set(key, {key, priority, callback, time: this._now()});
            return false;
        }
        this.pending.delete(key);
        this.active = {key, priority};
        return true;
    }
    next() {
        this.active = null;
        const entries = [...this.pending.values()].filter(e => this._now() - e.time < 15000);
        this.pending.clear();
        entries.sort((a, b) => b.priority - a.priority || a.time - b.time);
        const next = entries.shift();
        for (const entry of entries) this.pending.set(entry.key, entry);
        return next?.callback ?? null;
    }
    clear() { this.active = null; this.pending.clear(); }
}
