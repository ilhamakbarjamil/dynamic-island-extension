import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class VpnWatcher {
    constructor(onChange) {
        this._onChange = onChange;
        this._bus = Gio.DBus.system;
        this._watchId = null;
        this._timerId = null;

        this._poll();
        this._install();
    }

    _install() {
        if (!this._bus) return;

        try {
            this._watchId = this._bus.signal_subscribe(
                'org.freedesktop.NetworkManager',
                'org.freedesktop.NetworkManager',
                'PropertiesChanged',
                '/org/freedesktop/NetworkManager',
                null,
                Gio.DBusSignalFlags.NONE,
                () => this._poll()
            );
        } catch (_) {
            this._watchId = null;
        }
    }

    _poll() {
        if (!this._onChange) return;

        try {
            const proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.freedesktop.NetworkManager',
                '/org/freedesktop/NetworkManager',
                'org.freedesktop.NetworkManager',
                null
            );

            const connection = proxy?.get_connection?.();
            if (!connection) {
                this._onChange({ name: 'VPN', isConnected: false, isWarp: false });
                return;
            }

            const info = connection.call_sync(
                'GetAll',
                new GLib.Variant('(s)', ['org.freedesktop.NetworkManager']),
                Gio.DBusCallFlags.NONE,
                2000,
                null
            );

            const [props] = info.deep_unpack();
            const activeConnections = props?.ActiveConnections ?? [];
            const isConnected = Array.isArray(activeConnections) && activeConnections.length > 0;

            this._onChange({
                name: isConnected ? 'WARP' : 'VPN',
                isConnected,
                isWarp: isConnected,
            });
        } catch (_) {
            this._onChange({ name: 'VPN', isConnected: false, isWarp: false });
        }
    }

    destroy() {
        if (this._watchId && this._bus) {
            try { this._bus.signal_unsubscribe(this._watchId); } catch (_) {}
            this._watchId = null;
        }

        if (this._timerId) {
            try { GLib.source_remove(this._timerId); } catch (_) {}
            this._timerId = null;
        }

        this._onChange = null;
        this._bus = null;
    }
}
