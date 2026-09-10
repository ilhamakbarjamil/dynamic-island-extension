import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export class PrivacyWatcher {
    constructor(onChange) {
        this._onChange = onChange;
        this._cameraItem = null;
        this._micItem = null;
        this._lastCamera = false;
        this._lastMic = false;

        this._setup();
    }

    _setup() {
        try {
            const qs = Main.panel.statusArea.quickSettings;
            if (qs) {
                this._cameraItem = qs._camera || null;
                this._micItem = qs._volumeInput || qs._volume?._inputIndicator || null;
            }
        } catch (_) {}

        // Polling cepat setiap 300ms agar respon kamera & mic instan (real-time)
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._checkAndEmit();
            return GLib.SOURCE_CONTINUE;
        });

        this._checkAndEmit();
    }

    _isCameraActive() {
        // 1. Cek portal kamera GNOME (Snapshot, Flatpak, dll)
        if (this._cameraItem && this._cameraItem.visible) {
            return true;
        }

        // 2. Cek Driver Kernel Linux UVC (Google Meet, Chrome, Zoom, OBS, Browser)
        try {
            const file = Gio.File.new_for_path('/sys/module/uvcvideo/refcnt');
            if (file.query_exists(null)) {
                const [ok, bytes] = file.load_contents(null);
                if (ok) {
                    const count = parseInt(new TextDecoder().decode(bytes).trim(), 10);
                    if (count > 0) return true;
                }
            }
        } catch (_) {}

        return false;
    }

    _isMicActive() {
        let isRecording = false;
        if (this._micItem) {
            isRecording = this._micItem.visible;
        }

        // Jika mikrofon di-mute di level sistem (tombol keyboard / sound settings), paksa mati
        try {
            const inputControl = Main.panel.statusArea.quickSettings?._volumeInput?._control;
            if (inputControl) {
                const defaultSource = inputControl.get_default_source();
                if (defaultSource && defaultSource.is_muted) {
                    return false;
                }
            }
        } catch (_) {}

        return isRecording;
    }

    _checkAndEmit() {
        const camera = this._isCameraActive();
        const mic = this._isMicActive();

        if (camera !== this._lastCamera || mic !== this._lastMic) {
            this._lastCamera = camera;
            this._lastMic = mic;
            this._onChange?.({ camera, mic });
        }
    }

    destroy() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = null;
        }
        this._onChange = null;
    }
}