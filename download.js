import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class DownloadWatcher {
    constructor(onProgress) {
        this._onProgress = onProgress;
        this._monitor = null;
        this._monitorId = null;
        this._pollTimerId = null;

        this._activeDownload = null;
        this._downloadDir = this._getDownloadDir();

        this._setup();
    }

    _getDownloadDir() {
        const xdg = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
        if (xdg && GLib.file_test(xdg, GLib.FileTest.IS_DIR)) {
            return xdg;
        }
        return GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
    }

    _setup() {
        try {
            const dirFile = Gio.File.new_for_path(this._downloadDir);
            if (!dirFile.query_exists(null)) {
                dirFile.make_directory_with_parents(null);
            }

            // Monitor folder Downloads secara real-time
            this._monitor = dirFile.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitorId = this._monitor.connect('changed', (_m, file, otherFile, eventType) => {
                this._handleFileEvent(file, otherFile, eventType);
            });
        } catch (e) {
            console.log('[DynamicIsland] Gagal memasang monitor folder Downloads:', e.message);
        }

        // Timer polling berkala (tiap 600ms) untuk memperbarui progres ukuran & persentase
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
        try {
            const dir = Gio.File.new_for_path(this._downloadDir);
            const enumerator = dir.enumerate_children(
                'standard::name,standard::size',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let activeFound = null;
            let info;

            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (this._isDownloadFile(name)) {
                    activeFound = {
                        rawName: name,
                        cleanName: this._cleanFileName(name),
                        size: info.get_size(),
                    };
                    break;
                }
            }

            if (activeFound) {
                if (!this._activeDownload) {
                    this._activeDownload = {
                        name: activeFound.cleanName,
                        rawName: activeFound.rawName,
                        lastSize: activeFound.size,
                        pct: 12,
                    };
                } else {
                    // Jika ukuran file bertambah, naikkan progres secara dinamis
                    if (activeFound.size > this._activeDownload.lastSize) {
                        this._activeDownload.lastSize = activeFound.size;
                        this._activeDownload.pct = Math.min(95, this._activeDownload.pct + Math.floor(Math.random() * 8) + 4);
                    }
                }

                this._onProgress?.({
                    filename: this._activeDownload.name,
                    percentage: this._activeDownload.pct,
                    isCompleted: false,
                });
            } else if (this._activeDownload) {
                // File sementara (.crdownload/.part) baru saja hilang karena selesai diunduh & di-rename
                const finishedName = this._activeDownload.name;
                this._activeDownload = null;

                this._onProgress?.({
                    filename: finishedName,
                    percentage: 100,
                    isCompleted: true,
                });
            }
        } catch (_) {}
    }

    _handleFileEvent(file, otherFile, eventType) {
        const name = file ? file.get_basename() : '';
        if (!name) return;

        // Deteksi rename file saat unduhan selesai (Chrome / Firefox)
        if (eventType === Gio.FileMonitorEvent.RENAMED && otherFile) {
            const oldName = file.get_basename();
            const newName = otherFile.get_basename();

            if (this._isDownloadFile(oldName) && !this._isDownloadFile(newName)) {
                this._activeDownload = null;
                this._onProgress?.({
                    filename: newName,
                    percentage: 100,
                    isCompleted: true,
                });
                return;
            }
        }

        // Trigger scan cepat bila ada event file baru atau perubahan
        this._scanActiveDownloads();
    }

    destroy() {
        if (this._pollTimerId) {
            GLib.source_remove(this._pollTimerId);
            this._pollTimerId = null;
        }

        if (this._monitor && this._monitorId) {
            try {
                this._monitor.disconnect(this._monitorId);
            } catch (_) {}
            this._monitorId = null;
            this._monitor = null;
        }

        this._activeDownload = null;
        this._onProgress = null;
    }
}