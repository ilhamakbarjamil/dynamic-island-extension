import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Filesystem fallback: temporary files expose bytes, never the expected total.
// Do not invent a percentage or treat deletion/cancellation as completion.
export class DownloadWatcher {
    constructor(onProgress) {
        this._onProgress = onProgress;
        this._downloads = new Map();
        this._downloadDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ||
            GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
        this._setup();
    }

    _setup() {
        try {
            const dir = Gio.File.new_for_path(this._downloadDir);
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitorId = this._monitor.connect('changed', (_monitor, file, other, event) => {
                this._handleFileEvent(file, other, event);
            });
        } catch (e) {
            console.log('[DynamicIsland] Download monitor:', e.message);
        }
        this._pollTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            this._scanActiveDownloads();
            return GLib.SOURCE_CONTINUE;
        });
        this._scanActiveDownloads();
    }

    _cleanFileName(name) {
        return name.replace(/\.(crdownload|part|download|aria2)$/i, '');
    }

    _isDownloadFile(name) {
        return /\.(crdownload|part|download|aria2)$/i.test(name);
    }

    _scanActiveDownloads() {
        let enumerator;
        try {
            const dir = Gio.File.new_for_path(this._downloadDir);
            enumerator = dir.enumerate_children('standard::name,standard::size,standard::type',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            const next = new Map();
            const now = GLib.get_monotonic_time();
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (!this._isDownloadFile(name) || info.get_file_type() !== Gio.FileType.REGULAR)
                    continue;
                // aria2 control files contain metadata, not downloaded payload bytes.
                let size = info.get_size();
                if (/\.aria2$/i.test(name)) {
                    size = null;
                }
                const previous = this._downloads.get(name);
                const changed = !previous || size !== previous.size;
                next.set(name, {
                    filename: this._cleanFileName(name), rawName: name, size,
                    changedAt: changed ? now : previous.changedAt,
                    percentage: null, isCompleted: false,
                });
            }
            const hadDownloads = this._downloads.size > 0;
            this._downloads = next;
            if (next.size) {
                // Keep the selected file stable even when enumeration order changes.
                if (!next.has(this._selectedName)) this._selectedName = next.keys().next().value;
                const item = next.get(this._selectedName);
                this._onProgress?.({...item, activeCount: next.size,
                    waiting: now - item.changedAt > 5000000});
            } else if (hadDownloads) {
                this._selectedName = null;
                this._onProgress?.(null);
            }
        } catch (e) {
            // An inaccessible directory is not proof that an unduhan completed.
        } finally {
            enumerator?.close(null);
        }
    }

    _handleFileEvent(file, otherFile, eventType) {
        const name = file?.get_basename();
        if (!name) return;
        if (eventType === Gio.FileMonitorEvent.RENAMED && otherFile &&
            this._downloads.has(name) && !/\.aria2$/i.test(name) &&
            !this._isDownloadFile(otherFile.get_basename()) && otherFile.query_exists(null)) {
            this._downloads.delete(name);
            // Ongoing downloads take precedence over a completion banner.
            if (!this._downloads.size) {
                this._onProgress?.({filename: otherFile.get_basename(),
                    percentage: 100, isCompleted: true});
            }
        }
        this._scanActiveDownloads();
    }

    destroy() {
        if (this._pollTimerId) GLib.source_remove(this._pollTimerId);
        if (this._monitorId) this._monitor.disconnect(this._monitorId);
        this._monitor?.cancel();
        this._pollTimerId = null;
        this._monitorId = null;
        this._monitor = null;
        this._downloads.clear();
        this._onProgress = null;
    }
}
