import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';


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
                this._cameraItem = qs._camera?._indicator || null;
                this._micItem = qs._volumeInput?._indicator || qs._volume?._inputIndicator || null;
            }
        } catch (_) {}

        this._connections = [];
        for (const actor of [this._cameraItem, this._micItem]) {
            if (actor) this._connections.push([actor,
                actor.connect('notify::visible', () => this._checkAndEmit())]);
        }

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

        return false;
    }

    _isMicActive() {
        let isRecording = false;
        if (this._micItem) {
            isRecording = this._micItem.visible;
        }

        // A muted microphone may still be held by an application.
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
        for (const [actor, id] of this._connections ?? []) actor.disconnect(id);
        this._connections = [];
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = null;
        }
        this._onChange = null;
    }
}