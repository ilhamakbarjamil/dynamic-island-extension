import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';

export class ScreenRecordWatcher {
    constructor({ onRecordingStarted, onRecordingStopped, onTick }) {
        this._onRecordingStarted = onRecordingStarted;
        this._onRecordingStopped = onRecordingStopped;
        this._onTick = onTick;

        this._isRecording = false;
        this._elapsedSeconds = 0;
        this._timerId = null;
        this._pollId = null;
        this._recordSigId = null;
        this._shareSigId = null;

        this._setup();
    }

    _setup() {
        const statusArea = Main.panel?.statusArea;
        if (statusArea) {
            // 1. Hubungkan langsung ke indikator rekaman bawaan GNOME Ubuntu
            const recIndicator = statusArea.screenRecording || statusArea['screen-recording'];
            if (recIndicator) {
                this._recordSigId = recIndicator.connect('notify::visible', () => this._checkStatus());
            }

            // 2. Hubungkan ke indikator Screencast (OBS Studio, Discord, Google Meet Wayland)
            const shareIndicator = statusArea.screenSharing || statusArea['screen-sharing'];
            if (shareIndicator) {
                this._shareSigId = shareIndicator.connect('notify::visible', () => this._checkStatus());
            }
        }

        // Polling pelindung cepat setiap 300ms agar respon seketika
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._checkStatus();
            return GLib.SOURCE_CONTINUE;
        });

        this._checkStatus();
    }

    _isSystemRecording() {
        const statusArea = Main.panel?.statusArea;
        if (!statusArea) return false;

        // 1. Perekam Bawaan GNOME Ubuntu (PrtScn / Ctrl + Alt + Shift + R)
        const rec = statusArea.screenRecording || statusArea['screen-recording'];
        if (rec && rec.visible) {
            return true;
        }

        // 2. OBS Studio / Discord / Google Meet (Screen sharing di Wayland)
        const share = statusArea.screenSharing || statusArea['screen-sharing'];
        if (share && share.visible) {
            return true;
        }

        // 3. Fallback D-Bus Screencast GNOME Shell
        try {
            const screencast = Main.shellDBusService?._screencast;
            if (screencast && screencast._recorders && screencast._recorders.size > 0) {
                return true;
            }
        } catch (_) {}

        return false;
    }

    _checkStatus() {
        const active = this._isSystemRecording();

        if (active && !this._isRecording) {
            this._startTracking();
        } else if (!active && this._isRecording) {
            this._stopTracking();
        }
    }

    _startTracking() {
        this._isRecording = true;
        this._elapsedSeconds = 0;
        this._onRecordingStarted?.();

        // Mulai timer hitungan detik
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (this._isRecording) {
                this._elapsedSeconds++;
                this._emitTick();
            }
            return GLib.SOURCE_CONTINUE;
        });

        this._emitTick();
    }

    _stopTracking() {
        this._isRecording = false;
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        this._elapsedSeconds = 0;
        this._onRecordingStopped?.();
    }

    _emitTick() {
        const m = Math.floor(this._elapsedSeconds / 60);
        const s = this._elapsedSeconds % 60;
        const formatted = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        this._onTick?.({ seconds: this._elapsedSeconds, formatted });
    }

    stopRecordingSession() {
        // Hentikan sesi rekaman bawaan GNOME saat tombol [Stop] di Dynamic Island diklik
        try {
            if (Main.screenshotUI && typeof Main.screenshotUI.stopScreencast === 'function') {
                Main.screenshotUI.stopScreencast();
            }
        } catch (_) {}

        try {
            const indicator = Main.panel?.statusArea?.screenRecording || Main.panel?.statusArea?.['screen-recording'];
            if (indicator && typeof indicator.stop === 'function') {
                indicator.stop();
            }
        } catch (_) {}

        this._stopTracking();
    }

    get isRecording() {
        return this._isRecording;
    }

    destroy() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = null;
        }
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        const statusArea = Main.panel?.statusArea;
        if (statusArea) {
            const rec = statusArea.screenRecording || statusArea['screen-recording'];
            if (rec && this._recordSigId) rec.disconnect(this._recordSigId);

            const share = statusArea.screenSharing || statusArea['screen-sharing'];
            if (share && this._shareSigId) share.disconnect(this._shareSigId);
        }
        this._onRecordingStarted = null;
        this._onRecordingStopped = null;
        this._onTick = null;
    }
}