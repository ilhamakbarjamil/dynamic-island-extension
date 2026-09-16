import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';


export class PrivacyWatcher {
    constructor(onChange) {
        this._onChange = onChange;
        this._cameraItem = null;
        this._micItem = null;
        this._lastCamera = null;
        this._lastMic = null;

        this._cameraProbeActive = false;
        this._cameraProbe = null;
        this._cameraProbeTick = 0;
        this._fuserPath = GLib.find_program_in_path('fuser');
        this._destroyed = false;
        this._setup();
    }

    _setup() {
        this._connections = [];
        this._refreshIndicators();
        // Rebind if Shell creates or replaces an indicator after extension startup.
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._refreshIndicators();
            if (++this._cameraProbeTick % 3 === 0) this._probeCameraDevices();
            this._checkAndEmit();
            return GLib.SOURCE_CONTINUE;
        });
        this._probeCameraDevices();
        this._checkAndEmit();
    }

    _refreshIndicators() {
        const qs = Main.panel?.statusArea?.quickSettings;
        const camera = qs?._camera?._indicator ?? null;
        const mic = qs?._volumeInput?._indicator ?? qs?._volume?._inputIndicator ?? null;
        if (camera === this._cameraItem && mic === this._micItem) return;
        for (const [actor, id] of this._connections) {
            try { actor.disconnect(id); } catch (_) { }
        }
        this._connections = [];
        this._cameraItem = camera;
        this._micItem = mic;
        for (const actor of [camera, mic]) {
            if (actor) this._connections.push([actor,
                actor.connect('notify::visible', () => this._checkAndEmit())]);
        }
    }

    _isCameraActive() {
        // 1. Cek portal kamera GNOME (Snapshot, Flatpak, dll)
        if (this._cameraItem && this._cameraItem.visible) {
            return true;
        }

        return this._cameraProbeActive;
    }

    _probeCameraDevices() {
        if (!this._fuserPath || this._cameraProbe || this._destroyed) return;
        const devices = [];
        let entries;
        try {
            entries = Gio.File.new_for_path('/sys/class/video4linux').enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = entries.next_file(null))) {
                if (/^video\d+$/.test(info.get_name())) devices.push(`/dev/${info.get_name()}`);
            }
        } catch (_) { }
        finally { entries?.close(null); }
        if (!devices.length) {
            this._cameraProbeActive = false;
            this._checkAndEmit();
            return;
        }
        // GNOME's portal indicator misses applications opening V4L2 directly.
        // Check device usage asynchronously without blocking Shell animations.
        try {
            const process = Gio.Subprocess.new([this._fuserPath, ...devices],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._cameraProbe = process;
            process.wait_async(null, (child, result) => {
                let active = false;
                try { child.wait_finish(result); active = child.get_successful(); } catch (_) { }
                if (this._destroyed) return;
                this._cameraProbe = null;
                this._cameraProbeActive = active;
                this._checkAndEmit();
            });
        } catch (_) { this._cameraProbe = null; }
    }

    _isMicActive() {
        let isRecording = false;
        if (this._micItem) {
            isRecording = this._micItem.visible;
        }

        // Keyboard mute changes the source, not the application's recording state.
        const qs = Main.panel?.statusArea?.quickSettings;
        const control = qs?._volumeInput?._control ?? qs?._volume?._control;
        const source = control?.get_default_source();
        if (source?.is_muted) return false;
        return Boolean(isRecording);
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
        this._destroyed = true;
        this._cameraProbe?.force_exit();
        this._cameraProbe = null;
        for (const [actor, id] of this._connections ?? []) {
            try { actor.disconnect(id); } catch (_) { }
        }
        this._connections = [];
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = null;
        }
        this._onChange = null;
    }
}