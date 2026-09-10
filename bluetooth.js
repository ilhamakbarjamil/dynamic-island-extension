import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class BluetoothWatcher {
    constructor(onConnected) {
        this._onConnected = onConnected;
        this._bus = Gio.DBus.system;
        this._signalId = null;
        
        // Anti-spam tracker
        this._lastDevicePath = null;
        this._lastConnectTime = 0;

        try {
            this._signalId = this._bus.signal_subscribe(
                null,
                'org.freedesktop.DBus.Properties',
                'PropertiesChanged',
                null,
                null,
                Gio.DBusSignalFlags.NONE,
                (_conn, sender, path, _iface, _sig, params) => {
                    this._handlePropertiesChanged(path, params);
                }
            );
            console.log('[DynamicIsland] BluetoothWatcher aktif (dengan Debounce & Smart Icons).');
        } catch (e) {
            console.log('[DynamicIsland] Gagal inisialisasi Bluetooth listener:', e.message);
        }
    }

    _handlePropertiesChanged(path, params) {
        if (!path || !path.startsWith('/org/bluez')) return;

        try {
            const [interfaceName, changedProps] = params.deep_unpack();
            if (interfaceName !== 'org.bluez.Device1') return;

            const unwrap = v => (v && typeof v.deep_unpack === 'function') ? v.deep_unpack() : v;

            if ('Connected' in changedProps) {
                const isConnected = unwrap(changedProps['Connected']);
                if (isConnected === true) {
                    const now = GLib.get_monotonic_time();
                    // Cegah pop-up berulang jika perangkat yang sama memicu sinyal dalam 5 detik
                    if (this._lastDevicePath === path && (now - this._lastConnectTime) < 5_000_000) {
                        return;
                    }
                    this._lastDevicePath = path;
                    this._lastConnectTime = now;

                    // Beri jeda 500ms agar metadata profil audio dan baterai selesai dimuat
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                        this._queryDevice(path);
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }
        } catch (_) {}
    }

    _queryDevice(path) {
        try {
            const res = this._bus.call_sync(
                'org.bluez',
                path,
                'org.freedesktop.DBus.Properties',
                'GetAll',
                new GLib.Variant('(s)', ['org.bluez.Device1']),
                null,
                Gio.DBusCallFlags.NONE,
                1000,
                null
            );

            const [dict] = res.deep_unpack();
            const unwrap = v => (v && typeof v.deep_unpack === 'function') ? v.deep_unpack() : v;

            const alias = unwrap(dict['Alias']) || unwrap(dict['Name']) || 'Bluetooth Device';
            const rawIcon = String(unwrap(dict['Icon']) || '').toLowerCase();

            // Pemilihan ikon cerdas sesuai jenis perangkat
            let icon = 'audio-headphones-symbolic';
            if (rawIcon.includes('mouse') || rawIcon.includes('pointing')) {
                icon = 'input-mouse-symbolic';
            } else if (rawIcon.includes('keyboard')) {
                icon = 'input-keyboard-symbolic';
            } else if (rawIcon.includes('gaming') || rawIcon.includes('gamepad') || rawIcon.includes('joystick')) {
                icon = 'input-gaming-symbolic';
            } else if (rawIcon.includes('speaker') || rawIcon.includes('audio-card')) {
                icon = 'audio-speakers-symbolic';
            } else if (rawIcon.includes('phone')) {
                icon = 'phone-symbolic';
            }

            // Ambil persentase baterai jika tersedia
            let battery = null;
            try {
                const bRes = this._bus.call_sync(
                    'org.bluez',
                    path,
                    'org.freedesktop.DBus.Properties',
                    'Get',
                    new GLib.Variant('(ss)', ['org.bluez.Battery1', 'Percentage']),
                    null,
                    Gio.DBusCallFlags.NONE,
                    500,
                    null
                );
                const [bVal] = bRes.deep_unpack();
                const pct = unwrap(bVal);
                if (pct !== undefined && pct !== null) {
                    battery = Number(pct);
                }
            } catch (_) {}

            this._onConnected?.({
                name: String(alias),
                icon,
                battery,
            });
        } catch (e) {
            console.log('[DynamicIsland] Gagal query detail perangkat BlueZ:', e.message);
        }
    }

    destroy() {
        if (this._signalId) {
            this._bus.signal_unsubscribe(this._signalId);
            this._signalId = null;
        }
        this._onConnected = null;
        this._bus = null;
    }
}