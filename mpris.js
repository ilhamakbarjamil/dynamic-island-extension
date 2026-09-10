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
        this._busName = null;
        this._propsProxy = null;
        this._signalId = null;

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
                
                if (!oldOwner && newOwner && !this._busName) {
                    this._connect(name);
                } else if (oldOwner && !newOwner && this._busName === name) {
                    this._disconnect();
                    // Cari player cadangan jika ada
                    this.refresh();
                }
            }
        );

        this.refresh();
    }

    _connect(busName) {
        if (this._busName === busName && this._propsProxy) return;
        this._disconnect(false);
        this._busName = busName;

        try {
            this._propsProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
                busName, MPRIS_PATH, PROPS_IFACE, null
            );
        } catch (e) {
            this._busName = null;
            return;
        }

        this._signalId = this._bus.signal_subscribe(
            busName, PROPS_IFACE, 'PropertiesChanged', MPRIS_PATH,
            null, Gio.DBusSignalFlags.NONE,
            () => this._readAll()
        );

        this._readAll();
    }

    _disconnect(notify = true) {
        if (this._signalId) {
            this._bus.signal_unsubscribe(this._signalId);
            this._signalId = null;
        }
        this._propsProxy = null;
        this._busName = null;
        if (notify) {
            try { this._onUpdate?.(null); } catch (_) {}
        }
    }

    _readAll() {
        if (!this._propsProxy) return;
        try {
            const res = this._propsProxy.call_sync(
                'GetAll',
                new GLib.Variant('(s)', [MPRIS_IFACE]),
                Gio.DBusCallFlags.NONE,
                1500, // Hindari hanging
                null
            );
            const [dict] = res.deep_unpack();
            this._emit(dict);
        } catch (_) {}
    }

    _emit(props) {
        try {
            const unwrap = v => (v && typeof v.deep_unpack === 'function') ? v.deep_unpack() : v;

            const status = unwrap(props['PlaybackStatus']) ?? 'Stopped';
            const meta   = unwrap(props['Metadata']) ?? {};

            let title  = unwrap(meta['xesam:title'])  ?? '';
            let artist = unwrap(meta['xesam:artist']) ?? '';
            if (Array.isArray(artist)) artist = artist.map(a => unwrap(a)).join(', ');

            let artUrl = unwrap(meta['mpris:artUrl']);
            if (artUrl && typeof artUrl !== 'string') artUrl = null;

            let length = unwrap(meta['mpris:length']) ?? 0;
            length = Number(length) || 0;

            this._onUpdate?.({
                status:  String(status),
                title:   String(title),
                artist:  String(artist),
                artUrl:  artUrl ? String(artUrl) : null,
                length,
                canPlay: unwrap(props['CanPlay'])   ?? false,
                canNext: unwrap(props['CanGoNext']) ?? false,
                canSeek: unwrap(props['CanSeek'])   ?? false,
            });
        } catch (_) {}
    }

    getPosition() {
        if (!this._propsProxy) return 0;
        try {
            const res = this._propsProxy.call_sync(
                'Get',
                new GLib.Variant('(ss)', [MPRIS_IFACE, 'Position']),
                Gio.DBusCallFlags.NONE,
                500,
                null
            );
            const [variant] = res.deep_unpack();
            return Number(variant?.deep_unpack?.() ?? variant) || 0;
        } catch (_) {
            return 0;
        }
    }

    seek(targetMicros) {
        if (!this._busName) return;
        try {
            const current = this.getPosition();
            const offset = Math.round(targetMicros - current);
            this._bus.call_sync(
                this._busName, MPRIS_PATH, MPRIS_IFACE, 'Seek',
                new GLib.Variant('(x)', [offset]),
                null, Gio.DBusCallFlags.NONE, 500, null
            );
        } catch (_) {}
    }

    _callPlayer(method) {
        if (!this._busName) return;
        try {
            this._bus.call_sync(
                this._busName, MPRIS_PATH, MPRIS_IFACE, method,
                null, null, Gio.DBusCallFlags.NONE, 500, null
            );
        } catch (_) {}
    }

    togglePlayPause() { this._callPlayer('PlayPause'); }
    next()            { this._callPlayer('Next'); }
    previous()        { this._callPlayer('Previous'); }

    refresh() {
        try {
            const dbusProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
                'org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', null
            );
            const res = dbusProxy.call_sync('ListNames', null, Gio.DBusCallFlags.NONE, 1000, null);
            const [namesArr] = res.deep_unpack();
            const found = namesArr.find(n => n.startsWith(MPRIS_PREFIX));
            if (found) this._connect(found);
            else this._disconnect(true);
        } catch (_) {}
    }

    destroy() {
        if (this._nameOwnerId) {
            this._bus.signal_unsubscribe(this._nameOwnerId);
            this._nameOwnerId = null;
        }
        this._disconnect(false);
        this._onUpdate = null;
        this._bus = null;
    }
}