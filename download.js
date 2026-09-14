export class DownloadWatcher {
    constructor(onProgress) {
        this._onProgress = onProgress;
        this._timer = null;
    }

    destroy() {
        if (this._timer) {
            try {
                clearTimeout(this._timer);
            } catch (_) {}
            this._timer = null;
        }

        this._onProgress = null;
    }
}
