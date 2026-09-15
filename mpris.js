import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH   = '/org/mpris/MediaPlayer2';
const MPRIS_IFACE  = 'org.mpris.MediaPlayer2.Player';

export class MediaWatcher {
    constructor(onUpdate) {
        this._onUpdate = onUpdate;
        this._bus = Gio.DBus.session;
        this._players = new Map();
        this._activeBusName = null;

        // Mendeteksi aplikasi musik yang baru dibuka atau ditutup
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

    async _addPlayer(busName) {
        if (this._players.has(busName)) return;

        try {
            // Kita buat proxy untuk memantau status player
            const proxy = await Gio.DBusProxy.new_for_bus(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                busName,
                MPRIS_PATH,
                MPRIS_IFACE,
                null
            );

            // Pasang pendeteksi perubahan status secara instan
            const sigId = proxy.connect('g-properties-changed', (p, changed) => {
                const changedProps = changed.unpack();
                
                // Jika statusnya berubah jadi 'Playing', jadikan dia prioritas utama
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

            // Langsung cek setelah ditambahkan
            this._checkPriority();
        } catch (e) {
            console.log(`[DynamicIsland] Gagal connect ke ${busName}`);
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
        let latestTime = 0;

        // Cari player yang sedang PLAYING dengan waktu terbaru
        for (const [busName, player] of this._players) {
            const status = player.proxy.get_cached_property('PlaybackStatus')?.unpack();
            if (status === 'Playing') {
                if (player.lastUpdate >= latestTime) {
                    latestTime = player.lastUpdate;
                    bestBusName = busName;
                }
            }
        }

        // Jika tidak ada yang playing, cari yang PAUSED terakhir kali
        if (!bestBusName) {
            for (const [busName, player] of this._players) {
                if (player.lastUpdate >= latestTime) {
                    latestTime = player.lastUpdate;
                    bestBusName = busName;
                }
            }
        }

        if (bestBusName) {
            this._activeBusName = bestBusName;
            this._emit();
        } else {
            this._activeBusName = null;
            this._onUpdate?.(null);
        }
    }

    _emit() {
        if (!this._activeBusName) return;
        const player = this._players.get(this._activeBusName);
        if (!player) return;

        try {
            const proxy = player.proxy;
            const status = proxy.get_cached_property('PlaybackStatus')?.unpack() || 'Stopped';
            const metadata = proxy.get_cached_property('Metadata')?.unpack() || {};

            // Parsing Metadata dengan aman
            let title = metadata['xesam:title']?.unpack() || 'Unknown Title';
            let artist = metadata['xesam:artist']?.unpack() || 'Unknown Artist';
            if (Array.isArray(artist)) artist = artist.join(', ');

            let artUrl = metadata['mpris:artUrl']?.unpack() || null;
            let length = metadata['mpris:length']?.unpack() || 0;

            this._onUpdate?.({
                status: String(status),
                title: String(title),
                artist: String(artist),
                artUrl: artUrl ? String(artUrl) : null,
                length: Number(length),
                canPlay: proxy.get_cached_property('CanPlay')?.unpack() ?? false,
                canNext: proxy.get_cached_property('CanGoNext')?.unpack() ?? false,
                canPrev: proxy.get_cached_property('CanGoPrevious')?.unpack() ?? false,
            });
        } catch (e) {
            // Abaikan error sementara jika metadata sedang loading
        }
    }

    getPosition() {
        if (!this._activeBusName) return 0;
        try {
            const player = this._players.get(this._activeBusName);
            if (!player) return 0;
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
        // Cari aplikasi musik yang sudah terbuka sebelumnya
        try {
            const dbusProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION, 0, null, 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', null
            );
            const [names] = dbusProxy.call_sync('ListNames', null, 0, -1, null).deep_unpack();
            names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._addPlayer(n));
        } catch (_) {}
    }

    destroy() {
        if (this._ownerChangedId) this._bus.signal_unsubscribe(this._ownerChangedId);
        for (const player of this._players.values()) {
            player.proxy.disconnect(player.sigId);
        }
        this._players.clear();
        this._onUpdate = null;
    }
}