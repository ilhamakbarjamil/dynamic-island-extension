import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH   = '/org/mpris/MediaPlayer2';
const MPRIS_IFACE  = 'org.mpris.MediaPlayer2.Player';
const PROPS_IFACE  = 'org.freedesktop.DBus.Properties';

export class MediaWatcher {
    constructor(onUpdate) {
        this._onUpdate = onUpdate;
        this._bus = Gio.DBus.session;
        this._players = new Map(); // Untuk menyimpan banyak player (Spotify, Browser, dll)
        this._activeBusName = null;

        // Monitor aplikasi musik yang buka atau tutup
        this._nameOwnerId = this._bus.signal_subscribe(
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

    async _addPlayer(busName) {
        if (this._players.has(busName)) return;

        try {
            // Gunakan Proxy asinkron agar tidak membekukan desktop
            const proxy = await Gio.DBusProxy.new_for_bus(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                busName,
                MPRIS_PATH,
                MPRIS_IFACE,
                null
            );

            // Pasang pendeteksi perubahan status (Play/Pause/Ganti Lagu)
            const sigId = proxy.connect('g-properties-changed', (p, changed) => {
                const changedProps = changed.unpack();
                
                // Jika status berubah jadi Playing, update waktu aktivitas terakhir
                if (changedProps['PlaybackStatus']?.unpack() === 'Playing') {
                    const data = this._players.get(busName);
                    if (data) data.lastUpdate = Date.now();
                }
                this._checkPriority();
            });

            this._players.set(busName, {
                proxy,
                sigId,
                lastUpdate: Date.now()
            });

            this._checkPriority();
        } catch (e) {
            console.log(`[DynamicIsland] Gagal connect ke ${busName}: ${e.message}`);
        }
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (player) {
            player.proxy.disconnect(player.sigId);
            this._players.delete(busName);
        }
        
        if (this._activeBusName === busName) {
            this._activeBusName = null;
            this._checkPriority();
        }
    }

    _checkPriority() {
        let bestBusName = null;
        let bestProxy = null;
        let latestTime = 0;

        // LOGIKA: Cari yang sedang 'Playing' dengan waktu aktivitas terbaru
        for (const [busName, player] of this._players) {
            const status = player.proxy.get_cached_property('PlaybackStatus')?.unpack();
            
            if (status === 'Playing') {
                if (player.lastUpdate > latestTime) {
                    latestTime = player.lastUpdate;
                    bestBusName = busName;
                    bestProxy = player.proxy;
                }
            }
        }

        // FALLBACK: Jika tidak ada yang 'Playing', ambil yang terakhir kali aktif (Paused)
        if (!bestBusName && this._players.size > 0) {
            for (const [busName, player] of this._players) {
                if (player.lastUpdate > latestTime) {
                    latestTime = player.lastUpdate;
                    bestBusName = busName;
                    bestProxy = player.proxy;
                }
            }
        }

        if (bestBusName && bestProxy) {
            this._activeBusName = bestBusName;
            this._emit(bestProxy);
        } else {
            this._activeBusName = null;
            this._onUpdate?.(null);
        }
    }

    _emit(proxy) {
        try {
            const status = proxy.get_cached_property('PlaybackStatus')?.unpack() || 'Stopped';
            const metadata = proxy.get_cached_property('Metadata')?.unpack() || {};

            let title = metadata['xesam:title']?.unpack() || 'Unknown Title';
            let artist = metadata['xesam:artist']?.unpack() || 'Unknown Artist';
            if (Array.isArray(artist)) artist = artist.join(', ');

            this._onUpdate?.({
                status: String(status),
                title: String(title),
                artist: String(artist),
                artUrl: metadata['mpris:artUrl']?.unpack() || null,
                length: Number(metadata['mpris:length']?.unpack() || 0),
                canPlay: proxy.get_cached_property('CanPlay')?.unpack() ?? false,
                canNext: proxy.get_cached_property('CanGoNext')?.unpack() ?? false,
                canPrev: proxy.get_cached_property('CanGoPrevious')?.unpack() ?? false,
            });
        } catch (e) {
            console.log('[DynamicIsland] Error emit metadata:', e.message);
        }
    }

    getPosition() {
        if (!this._activeBusName) return 0;
        try {
            const player = this._players.get(this._activeBusName);
            // Ambil posisi langsung dari DBus (karena Position tidak dikirim via signal)
            const res = player.proxy.get_connection().call_sync(
                this._activeBusName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [MPRIS_IFACE, 'Position']), 
                null, Gio.DBusCallFlags.NONE, -1, null);
            const [variant] = res.deep_unpack();
            return Number(variant.unpack()) || 0;
        } catch (_) { return 0; }
    }

    togglePlayPause() { this._call('PlayPause'); }
    next()            { this._call('Next'); }
    previous()        { this._call('Previous'); }

    _call(method) {
        if (!this._activeBusName) return;
        const player = this._players.get(this._activeBusName);
        player?.proxy.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    refresh() {
        // Cari semua player yang sudah jalan saat PC dinyalakan
        const dbusProxy = Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SESSION, 0, null, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', null
        );
        const [names] = dbusProxy.call_sync('ListNames', null, 0, -1, null).deep_unpack();
        names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._addPlayer(n));
    }

    destroy() {
        if (this._nameOwnerId) {
            this._bus.signal_unsubscribe(this._nameOwnerId);
            this._nameOwnerId = null;
        }
        for (const player of this._players.values()) {
            player.proxy.disconnect(player.sigId);
        }
        this._players.clear();
        this._onUpdate = null;
    }
}