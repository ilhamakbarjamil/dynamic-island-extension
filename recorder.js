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

        this._setup();
    }

    _setup() {
        const statusArea = Main.panel?.statusArea;
        if (statusArea) {
            // Hubungkan HANYA ke indikator rekaman bawaan GNOME Ubuntu.
            // Indikator "Screen Sharing" SENGAJA tidak dipakai lagi: indikator itu
            // menyala untuk SEMUA capture layar lewat portal (OBS Pipewire capture,
            // Discord, Google Meet, dsb), bukan berarti sedang benar-benar merekam
            // ke file. Itu penyebab Dynamic Island nyala sendiri saat OBS baru
            // memilih source "Screen Capture" padahal belum menekan tombol record.
            const recIndicator = statusArea.screenRecording || statusArea['screen-recording'];
            if (recIndicator) {
                this._recordSigId = recIndicator.connect('notify::visible', () => this._checkStatus());
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
        //    Ini satu-satunya indikator panel yang dipakai. Indikator
        //    "screenSharing" tidak dicek lagi karena juga menyala untuk
        //    screen capture pihak ketiga (OBS/Discord/Meet) yang belum
        //    tentu sedang merekam ke file.
        const rec = statusArea.screenRecording || statusArea['screen-recording'];
        if (rec && rec.visible) {
            return true;
        }

        // 2. Fallback D-Bus org.gnome.Shell.Screencast
        //    Service ini eksklusif dipakai oleh perekam bawaan GNOME Shell,
        //    BUKAN oleh portal ScreenCast/RemoteDesktop yang dipakai OBS dkk,
        //    jadi aman dipakai sebagai jaring pengaman kedua.
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
        }
        this._onRecordingStarted = null;
        this._onRecordingStopped = null;
        this._onTick = null;
    }
}