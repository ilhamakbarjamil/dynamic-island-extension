import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH   = '/org/mpris/MediaPlayer2';
const MPRIS_IFACE  = 'org.mpris.MediaPlayer2.Player';

// Helper untuk membongkar GLib.Variant bertingkat secara aman
function unwrap(val) {
    if (val === null || val === undefined) return val;
    if (typeof val.deep_unpack === 'function') return unwrap(val.deep_unpack());
    if (typeof val.unpack === 'function') return unwrap(val.unpack());
    return val;
}

export class MediaWatcher {
    constructor(onUpdate) {
        this._onUpdate = onUpdate;
        this._bus = Gio.DBus.session;
        this._players = new Map();
        this._activeBusName = null;
        this._graceTimerId = null;

        // Mendeteksi aplikasi pemutar musik/video yang dibuka atau ditutup
        this._ownerChangedId = this._bus.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                const [name, oldOwner, newOwner] = params.deep_unpack();
                if (!name.startsWith(MPRIS_PREFIX)) return;

                if (newOwner) {
                    this._addPlayer(name);
                } else {
                    this._removePlayer(name);
                }
            }
        );

        this.refresh();
    }

    _getProperty(proxy, propName) {
        if (!proxy) return null;
        try {
            const variant = proxy.get_cached_property(propName);
            return unwrap(variant);
        } catch (_) {
            return null;
        }
    }

    _getPlayerStatus(proxy) {
        if (!proxy) return 'Stopped';
        try {
            const val = this._getProperty(proxy, 'PlaybackStatus');
            return val ? String(val) : 'Stopped';
        } catch (_) {
            return 'Stopped';
        }
    }

    _addPlayer(busName) {
        if (this._players.has(busName)) return;

        try {
            // Gunakan sync constructor yang 100% stabil di GJS
            const proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                busName,
                MPRIS_PATH,
                MPRIS_IFACE,
                null
            );

            const status = this._getPlayerStatus(proxy);
            const isPlaying = (status === 'Playing');

            const playerData = {
                proxy,
                sigId: null,
                lastUpdate: isPlaying ? Date.now() : 0,
                lastTitle: '',
                lastArtist: '',
            };

            // Tangkap perubahan status, pergantian lagu, maupun perubahan metadata
            playerData.sigId = proxy.connect('g-properties-changed', (_p, changed) => {
                this._onPropertiesChanged(busName, changed);
            });

            this._players.set(busName, playerData);
            this._checkPriority();
        } catch (e) {
            console.log(`[DynamicIsland] Gagal inisialisasi proxy ${busName}:`, e.message);
        }
    }

    _onPropertiesChanged(busName, changed) {
        const player = this._players.get(busName);
        if (!player) return;

        let changedProps = {};
        try {
            changedProps = changed.deep_unpack() || {};
        } catch (_) {
            try {
                changedProps = changed.unpack() || {};
            } catch (_) {}
        }

        const status = changedProps['PlaybackStatus']
            ? unwrap(changedProps['PlaybackStatus'])
            : this._getPlayerStatus(player.proxy);

        // KUNCI PERBAIKAN YOUTUBE vs SPOTIFY:
        // Jika status menjadi Playing ATAU ada pembaruan Metadata (Spotify ganti lagu saat playing)
        if (status === 'Playing' || 'PlaybackStatus' in changedProps || 'Metadata' in changedProps) {
            player.lastUpdate = Date.now();
        }

        this._checkPriority();
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (player) {
            if (player.sigId && player.proxy) {
                try { player.proxy.disconnect(player.sigId); } catch (_) {}
            }
            this._players.delete(busName);
        }

        if (this._activeBusName === busName) {
            this._activeBusName = null;
            this._checkPriority();
        }
    }

    _checkPriority() {
        let bestPlayingBus = null;
        let latestPlayingTime = -1;

        let bestPausedBus = null;
        let latestPausedTime = -1;

        // Pilih pemutar terbaik berdasarkan status dan aktivitas terbarunya
        for (const [busName, player] of this._players) {
            const status = this._getPlayerStatus(player.proxy);

            if (status === 'Playing') {
                if (player.lastUpdate > latestPlayingTime) {
                    latestPlayingTime = player.lastUpdate;
                    bestPlayingBus = busName;
                }
            } else if (status === 'Paused') {
                if (player.lastUpdate > latestPausedTime) {
                    latestPausedTime = player.lastUpdate;
                    bestPausedBus = busName;
                }
            }
        }

        // Pemutar 'Playing' selalu didahulukan daripada 'Paused'
        const targetBus = bestPlayingBus || bestPausedBus || null;

        if (targetBus) {
            // Jika ada player yang aktif, batalkan grace timer penutupan
            if (this._graceTimerId) {
                GLib.source_remove(this._graceTimerId);
                this._graceTimerId = null;
            }
            this._activeBusName = targetBus;
            this._emit();
        } else {
            // KUNCI PERBAIKAN "MATI DI TENGAH LAGU":
            // Beri Grace Period 1.5 detik jika player mendadak berhenti sesaat
            // (misalnya buffer video YouTube atau transisi antartrack).
            if (!this._graceTimerId && this._activeBusName) {
                this._graceTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                    this._graceTimerId = null;
                    this._activeBusName = null;
                    this._onUpdate?.(null);
                    return GLib.SOURCE_REMOVE;
                });
            } else if (!this._activeBusName) {
                this._onUpdate?.(null);
            }
        }
    }

    _emit() {
        if (!this._activeBusName) return;
        const player = this._players.get(this._activeBusName);
        if (!player || !player.proxy) return;

        try {
            const proxy = player.proxy;
            const status = this._getPlayerStatus(proxy);
            const metadataRaw = this._getProperty(proxy, 'Metadata');
            const metadata = (metadataRaw && typeof metadataRaw === 'object') ? metadataRaw : {};

            // Parsing Metadata dengan aman
            let title = unwrap(metadata['xesam:title']) || '';
            let artist = unwrap(metadata['xesam:artist']) || '';

            if (Array.isArray(artist)) {
                artist = artist.map(a => String(unwrap(a) || '')).filter(Boolean).join(', ');
            } else if (artist) {
                artist = String(artist);
            }

            // Pertahankan info track terakhir jika metadata sempat kosong saat buffering
            if (!title && player.lastTitle) {
                title = player.lastTitle;
                artist = player.lastArtist;
            } else if (title) {
                player.lastTitle = title;
                player.lastArtist = artist;
            }

            let artUrl = unwrap(metadata['mpris:artUrl']) || null;
            let length = unwrap(metadata['mpris:length']) || 0;

            this._onUpdate?.({
                status: String(status),
                title: String(title || 'Unknown Title'),
                artist: String(artist || 'Unknown Artist'),
                artUrl: artUrl ? String(artUrl) : null,
                length: Number(length) || 0,
                canPlay: Boolean(this._getProperty(proxy, 'CanPlay') ?? true),
                canNext: Boolean(this._getProperty(proxy, 'CanGoNext') ?? true),
                canPrev: Boolean(this._getProperty(proxy, 'CanGoPrevious') ?? true),
            });
        } catch (e) {
            console.log('[DynamicIsland] Error pada _emit MPRIS:', e.message);
        }
    }

    getPosition() {
        const busName = this._activeBusName;
        const player = this._players.get(busName);
        if (!player?.proxy) return 0;
        if (!player.positionPending) {
            player.positionPending = true;
            player.proxy.get_connection().call(
                busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [MPRIS_IFACE, 'Position']), null,
                Gio.DBusCallFlags.NONE, 1000, null, (connection, result) => {
                    try {
                        const [value] = connection.call_finish(result).deep_unpack();
                        if (this._players.get(busName) === player)
                            player.position = Math.max(0, Number(unwrap(value)) || 0);
                    } catch (_) { /* Keep the last confirmed position on timeout. */ }
                    player.positionPending = false;
                });
        }
        return player.position ?? 0;
    }

    togglePlayPause() { this._call('PlayPause'); }
    next()            { this._call('Next'); }
    previous()        { this._call('Previous'); }

    _call(method) {
        if (!this._activeBusName) return;
        const player = this._players.get(this._activeBusName);
        if (!player || !player.proxy) return;

        // Perbarui waktu aktivitas saat tombol Dynamic Island diklik
        player.lastUpdate = Date.now();
        player.proxy.call(method, null, Gio.DBusCallFlags.NONE, 500, null, null);
    }

    refresh() {
        try {
            const dbusProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                null
            );
            const res = dbusProxy.call_sync('ListNames', null, 0, 1000, null);
            const [names] = res.deep_unpack();
            names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._addPlayer(n));
        } catch (e) {
            console.log('[DynamicIsland] Gagal refresh MPRIS list:', e.message);
        }
    }

    destroy() {
        if (this._graceTimerId) {
            GLib.source_remove(this._graceTimerId);
            this._graceTimerId = null;
        }
        if (this._ownerChangedId) {
            this._bus.signal_unsubscribe(this._ownerChangedId);
            this._ownerChangedId = null;
        }
        for (const player of this._players.values()) {
            if (player.sigId && player.proxy) {
                try { player.proxy.disconnect(player.sigId); } catch (_) {}
            }
        }
        this._players.clear();
        this._activeBusName = null;
        this._onUpdate = null;
        this._bus = null;
    }
}