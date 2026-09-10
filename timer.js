import GLib from 'gi://GLib';

export class TimerManager {
    constructor({ onTick, onFinished, onStateChange }) {
        this._onTick = onTick;
        this._onFinished = onFinished;
        this._onStateChange = onStateChange;

        this._totalSeconds = 0;
        this._remainingSeconds = 0;
        this._isRunning = false;
        this._isPaused = false;
        this._timerId = null;
    }

    start(seconds) {
        this.stop();
        this._totalSeconds = seconds;
        this._remainingSeconds = seconds;
        this._isRunning = true;
        this._isPaused = false;

        this._emitTick();
        this._onStateChange?.({ isRunning: true, isPaused: false });

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (!this._isPaused) {
                this._remainingSeconds--;
                this._emitTick();

                if (this._remainingSeconds <= 0) {
                    this.stop();
                    this._onFinished?.();
                    return GLib.SOURCE_REMOVE;
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    pause() {
        if (!this._isRunning || this._isPaused) return;
        this._isPaused = true;
        this._onStateChange?.({ isRunning: true, isPaused: true });
    }

    resume() {
        if (!this._isRunning || !this._isPaused) return;
        this._isPaused = false;
        this._onStateChange?.({ isRunning: true, isPaused: false });
    }

    togglePause() {
        if (this._isPaused) this.resume();
        else this.pause();
    }

    addMinute() {
        if (!this._isRunning) return;
        this._remainingSeconds += 60;
        this._totalSeconds += 60;
        this._emitTick();
    }

    stop() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        this._isRunning = false;
        this._isPaused = false;
        this._remainingSeconds = 0;
        this._totalSeconds = 0;
        this._onStateChange?.({ isRunning: false, isPaused: false });
    }

    _emitTick() {
        const m = Math.floor(this._remainingSeconds / 60);
        const s = this._remainingSeconds % 60;
        const formatted = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        const ratio = this._totalSeconds > 0 ? (this._remainingSeconds / this._totalSeconds) : 0;

        this._onTick?.({
            remainingSeconds: this._remainingSeconds,
            formatted,
            ratio,
            isPaused: this._isPaused,
        });
    }

    get isActive() {
        return this._isRunning;
    }

    destroy() {
        this.stop();
        this._onTick = null;
        this._onFinished = null;
        this._onStateChange = null;
    }
}
