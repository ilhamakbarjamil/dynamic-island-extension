import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class BluetoothWatcher {
    constructor(onConnected) {
        this._onConnected = onConnected;
        this._bus = Gio.DBus.system;
        this._signalId = null;

        try {
            // Berlangganan sinyal PropertiesChanged tanpa membatasi sender/arg0 secara kaku
            // agar sinyal dari daemon BlueZ (:1.xx) tidak terblokir oleh filter D-Bus
            this._signalId = this._bus.signal_subscribe(
                null, // Tangkap dari semua sender di system bus
                'org.freedesktop.DBus.Properties',
                'PropertiesChanged',
                null,
                null,
                Gio.DBusSignalFlags.NONE,
                (_conn, sender, path, _iface, _sig, params) => {
                    this._handlePropertiesChanged(path, params);
                }
            );
            console.log('[DynamicIsland] BluetoothWatcher aktif memantau D-Bus.');
        } catch (e) {
            console.log('[DynamicIsland] Gagal inisialisasi Bluetooth listener:', e.message);
        }
    }

    _handlePropertiesChanged(path, params) {
        // Hanya proses sinyal yang berasal dari path perangkat Bluetooth BlueZ
        if (!path || !path.startsWith('/org/bluez')) return;

        try {
            const [interfaceName, changedProps] = params.deep_unpack();
            if (interfaceName !== 'org.bluez.Device1') return;

            const unwrap = v => (v && typeof v.deep_unpack === 'function') ? v.deep_unpack() : v;

            if ('Connected' in changedProps) {
                const isConnected = unwrap(changedProps['Connected']);
                if (isConnected === true) {
                    console.log('[DynamicIsland] Perangkat Bluetooth terdeteksi tersambung di:', path);
                    // Beri jeda 350ms agar BlueZ selesai membaca metadata & profil audio
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                        this._queryDevice(path);
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }
        } catch (e) {
            console.log('[DynamicIsland] Error membaca properti Bluetooth:', e.message);
        }
    }

    _queryDevice(path) {
        try {
            // Panggil GetAll secara langsung melalui D-Bus agar tidak tergantung pada cache proxy
            const res = this._bus.call_sync(
                'org.bluez',
                path,
                'org.freedesktop.DBus.Properties',
                'GetAll',
                new GLib.Variant('(s)', ['org.bluez.Device1']),
                null,
                Gio.DBusCallFlags.NONE,
                1500,
                null
            );

            const [dict] = res.deep_unpack();
            const unwrap = v => (v && typeof v.deep_unpack === 'function') ? v.deep_unpack() : v;

            const alias = unwrap(dict['Alias']) || unwrap(dict['Name']) || 'Bluetooth Device';
            const rawIcon = String(unwrap(dict['Icon']) || '');

            let icon = 'audio-headphones-symbolic';
            if (rawIcon.includes('mouse') || rawIcon.includes('pointing')) {
                icon = 'input-mouse-symbolic';
            } else if (rawIcon.includes('keyboard')) {
                icon = 'input-keyboard-symbolic';
            }

            // Coba ambil persentase baterai jika perangkat menyediakannya
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
                    600,
                    null
                );
                const [bVal] = bRes.deep_unpack();
                const pct = unwrap(bVal);
                if (pct !== undefined && pct !== null) {
                    battery = Number(pct);
                }
            } catch (_) {
                // Sebagian perangkat Bluetooth tidak mengekspos org.bluez.Battery1 (normal)
            }

            console.log(`[DynamicIsland] Menampilkan pop-up: ${alias} (Baterai: ${battery})`);

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