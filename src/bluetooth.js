import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const unwrap = value => value?.deep_unpack ? value.deep_unpack() : value;

export class BluetoothWatcher {
    constructor(onConnected) {
        this._onConnected = onConnected;
        this._bus = Gio.DBus.system;
        this._states = new Map();
        this._devices = new Map();
        this._generation = new Map();
        this._cancellable = new Gio.Cancellable();
        this._signalId = this._bus.signal_subscribe('org.bluez',
            'org.freedesktop.DBus.Properties', 'PropertiesChanged', null, null,
            Gio.DBusSignalFlags.NONE, (_c, _s, path, _i, _sig, params) =>
                this._handlePropertiesChanged(path, params));
    }

    _handlePropertiesChanged(path, params) {
        if (!path?.startsWith('/org/bluez/')) return;
        const [iface, props] = params.deep_unpack();
        if (iface === 'org.bluez.Adapter1' && 'Powered' in props) {
            const powered = unwrap(props.Powered);
            if (this._states.get(path) === powered) return;
            this._states.set(path, powered);
            this._onConnected?.({kind: 'adapter', name: 'Bluetooth', connected: powered});
        } else if (iface === 'org.bluez.Device1' && 'Connected' in props) {
            const connected = unwrap(props.Connected);
            if (this._states.get(path) === connected) return;
            this._states.set(path, connected);
            const generation = (this._generation.get(path) ?? 0) + 1;
            this._generation.set(path, generation);
            this._queryDevice(path, connected, generation);
        }
    }

    async _getAll(path, iface) {
        return new Promise(resolve => {
            this._bus.call('org.bluez', path, 'org.freedesktop.DBus.Properties',
                'GetAll', new GLib.Variant('(s)', [iface]), null,
                Gio.DBusCallFlags.NONE, 1000, this._cancellable, (bus, result) => {
                    try { resolve(bus.call_finish(result).deep_unpack()[0]); }
                    catch (_) { resolve({}); }
                });
        });
    }

    async _queryDevice(path, connected, generation) {
        const [props, batteryProps] = await Promise.all([
            this._getAll(path, 'org.bluez.Device1'),
            connected ? this._getAll(path, 'org.bluez.Battery1') : Promise.resolve({}),
        ]);
        if (!this._onConnected || this._generation.get(path) !== generation) return;
        const name = unwrap(props.Alias) || unwrap(props.Name) || this._devices.get(path)?.name || 'Perangkat';
        const icon = unwrap(props.Icon) || this._devices.get(path)?.icon || 'bluetooth';
        this._devices.set(path, {name, icon});
        // Adapter-off takes precedence over the resulting device disconnections.
        const adapter = path.slice(0, path.lastIndexOf('/'));
        if (this._states.get(adapter) === false) return;
        const battery = unwrap(batteryProps.Percentage);
        this._onConnected({kind: 'device', name, icon, connected,
            battery: Number.isFinite(battery) ? Math.max(0, Math.min(100, battery)) : null});
    }

    destroy() {
        this._onConnected = null;
        this._cancellable.cancel();
        if (this._signalId) this._bus.signal_unsubscribe(this._signalId);
        this._signalId = null;
        this._states.clear();
        this._devices.clear();
        this._generation.clear();
    }
}
