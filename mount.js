import Gio from 'gi://Gio';

export class MountWatcher {
    constructor({ onDriveMounted, onDriveRemoved } = {}) {
        this._onDriveMounted = onDriveMounted;
        this._onDriveRemoved = onDriveRemoved;
        this._monitor = Gio.VolumeMonitor.get();
        this._mountAddedId = null;
        this._mountRemovedId = null;

        this._install();
    }

    _install() {
        if (!this._monitor) return;

        this._mountAddedId = this._monitor.connect('mount-added', (_monitor, mount) => {
            this._notifyMounted(mount);
        });

        this._mountRemovedId = this._monitor.connect('mount-removed', (_monitor, mount) => {
            const name = mount?.get_name?.() || 'Drive';
            this._onDriveRemoved?.(name);
        });

        // Existing mounts are not new attachment events.
    }

    _notifyMounted(mount) {
        if (!mount) return;

        const name = mount.get_name?.() || 'USB Drive';
        let freeSpace = 'Drive Terhubung';

        try {
            const root = mount.get_root?.();
            if (root && typeof root.get_path === 'function') {
                freeSpace = root.get_path();
            }
        } catch (_) {}

        this._onDriveMounted?.({
            name,
            mount,
            freeSpace,
        });
    }

    eject(mount, callback) {
        if (!mount) { callback?.(false); return; }
        const eject = mount.can_eject?.();
        const method = eject ? 'eject_with_operation' : 'unmount_with_operation';
        const finish = `${method}_finish`;
        if (!eject && !mount.can_unmount?.()) { callback?.(false); return; }
        try {
            mount[method](Gio.MountUnmountFlags.NONE, new Gio.MountOperation(), null,
                (object, result) => {
                    let ok = false;
                    try { ok = object[finish](result); } catch (_) { }
                    if (this._monitor) callback?.(ok);
                });
        } catch (_) { callback?.(false); }
    }

    destroy() {
        if (this._monitor) {
            if (this._mountAddedId) {
                try { this._monitor.disconnect(this._mountAddedId); } catch (_) {}
                this._mountAddedId = null;
            }
            if (this._mountRemovedId) {
                try { this._monitor.disconnect(this._mountRemovedId); } catch (_) {}
                this._mountRemovedId = null;
            }
        }

        this._monitor = null;
        this._onDriveMounted = null;
        this._onDriveRemoved = null;
    }
}
