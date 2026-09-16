import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

export class ControlCenterManager {
    constructor(onUpdate) {
        this._onUpdate = onUpdate;
        this._timers = new Set();
        this._powerState = {profile: null, profiles: []};
        this._powerPending = false;
        this._cancellable = new Gio.Cancellable();
        this._refreshPowerProfiles();
        this._powerSignal = Gio.DBus.system.signal_subscribe(null,
            'org.freedesktop.DBus.Properties', 'PropertiesChanged', null, null,
            Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
                const [iface] = params.deep_unpack();
                if (iface === 'net.hadess.PowerProfiles' || iface === 'org.freedesktop.UPower.PowerProfiles')
                    this._refreshPowerProfiles();
            });

        // Settings Schema
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._colorSettings = new Gio.Settings({ schema_id: 'org.gnome.settings-daemon.plugins.color' });

        // Listener perubahan sistem (real-time 2 arah)
        this._darkSig = this._interfaceSettings.connect('changed::color-scheme', () => this._notify());
        this._nightSig = this._colorSettings.connect('changed::night-light-enabled', () => this._notify());

        // Listener Hardware Sistem (Bluetooth, Wi-Fi, & Airplane Mode)
        this._setupSystemListeners();
    }

    _setupSystemListeners() {
        try {
            const qs = Main.panel.statusArea.quickSettings;

            // Pantau status Bluetooth bawaan GNOME
            const btToggle = qs?._bluetooth?._toggle || qs?._bluetooth?.quickSettingsItems?.[0];
            if (btToggle) {
                this._btSig = btToggle.connect('notify::checked', () => this._notify());
            }

            // Pantau status Wi-Fi bawaan GNOME
            const netClient = qs?._network?._client;
            if (netClient) {
                this._wifiSig = netClient.connect('notify::wireless-enabled', () => this._notify());
                this._wifiConnectionSig = netClient.connect('notify::active-connections', () => this._notify());
            }

            // Pantau status Airplane Mode bawaan GNOME Rfkill
            const rfkillToggle = qs?._rfkill?._toggle || qs?._rfkill?.quickSettingsItems?.[0];
            if (rfkillToggle) {
                this._rfkillSig = rfkillToggle.connect('notify::checked', () => this._notify());
            }
        } catch (_) {}
    }

    // ================= 1. BLUETOOTH =================
    isBluetoothEnabled() {
        try {
            const qs = Main.panel.statusArea.quickSettings;
            const btToggle = qs?._bluetooth?._toggle || qs?._bluetooth?.quickSettingsItems?.[0];
            if (btToggle && typeof btToggle.checked === 'boolean') {
                return btToggle.checked;
            }
        } catch (_) {}

        return false;
    }

    toggleBluetooth() {
        const currentlyOn = this.isBluetoothEnabled();
        const targetState = !currentlyOn;

        try {
            const qs = Main.panel.statusArea.quickSettings;
            const btToggle = qs?._bluetooth?._toggle || qs?._bluetooth?.quickSettingsItems?.[0];
            if (btToggle && typeof btToggle.set_checked === 'function') {
                btToggle.set_checked(targetState);
            }
        } catch (_) {}

        if (targetState) {
            GLib.spawn_command_line_async('rfkill unblock bluetooth');
            GLib.spawn_command_line_async('bluetoothctl power on');
        } else {
            GLib.spawn_command_line_async('bluetoothctl power off');
        }

        this._refreshSoon();

        return targetState;
    }

    // ================= 2. AIRPLANE MODE (FIXED: GNOME RFKILL DAEMON) =================
    isAirplaneMode() {
        // 1. Cek langsung dari toggle rfkill bawaan GNOME Shell
        try {
            const qs = Main.panel.statusArea.quickSettings;
            const rfkillToggle = qs?._rfkill?._toggle || qs?._rfkill?.quickSettingsItems?.[0];
            if (rfkillToggle && typeof rfkillToggle.checked === 'boolean') {
                return rfkillToggle.checked;
            }
        } catch (_) {}

        // 2. Cek via D-Bus org.gnome.SettingsDaemon.Rfkill
        return false;
    }

    toggleAirplaneMode() {
        const current = this.isAirplaneMode();
        const targetState = !current;

        // 1. Eksekusi langsung ke QuickSettings rfkill bawaan GNOME
        try {
            const qs = Main.panel.statusArea.quickSettings;
            const rfkillToggle = qs?._rfkill?._toggle || qs?._rfkill?.quickSettingsItems?.[0];
            if (rfkillToggle && typeof rfkillToggle.set_checked === 'function') {
                rfkillToggle.set_checked(targetState);
            }
        } catch (_) {}

        // 2. Eksekusi ke D-Bus daemon sistem GNOME Rfkill
        try {
            Gio.DBus.session.call_sync(
                'org.gnome.SettingsDaemon.Rfkill',
                '/org/gnome/SettingsDaemon/Rfkill',
                'org.freedesktop.DBus.Properties',
                'Set',
                new GLib.Variant('(ssv)', [
                    'org.gnome.SettingsDaemon.Rfkill',
                    'AirplaneMode',
                    new GLib.Variant('b', targetState),
                ]),
                null,
                Gio.DBusCallFlags.NONE,
                300,
                null
            );
        } catch (_) {
            // 3. Cadangan level kernel Linux murni
            GLib.spawn_command_line_async(`rfkill ${targetState ? 'block' : 'unblock'} all`);
        }

        this._refreshSoon();

        return targetState;
    }

    // ================= 3. NIGHT LIGHT =================
    isNightLight() {
        try {
            return this._colorSettings.get_boolean('night-light-enabled');
        } catch (_) {
            return false;
        }
    }

    toggleNightLight() {
        try {
            const current = this.isNightLight();
            const target = !current;
            this._colorSettings.set_boolean('night-light-enabled', target);
            this._notify();
            return target;
        } catch (_) {
            return false;
        }
    }

    // ================= 4. DARK MODE =================
    isDarkMode() {
        try {
            return this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
        } catch (_) {
            return true;
        }
    }

    toggleDarkMode() {
        const isDark = this.isDarkMode();
        const target = isDark ? 'default' : 'prefer-dark';
        this._interfaceSettings.set_string('color-scheme', target);
        this._notify();
        return !isDark;
    }

    // ================= 5. WI-FI =================
    isWifiEnabled() {
        try {
            const nm = Main.panel.statusArea.quickSettings?._network?._client;
            return Boolean(nm?.wireless_enabled);
        } catch (_) {
            return true;
        }
    }

    getWifiSsid() {
        try {
            const activeConn = Main.panel.statusArea.quickSettings?._network?._client?.active_connections;
            if (activeConn) {
                for (let conn of activeConn) {
                    if ((conn.get_connection_type?.() || conn.type) === '802-11-wireless') return conn.get_id?.() || conn.id || 'Wi-Fi';
                }
            }
        } catch (_) {}
        return this.isWifiEnabled() ? 'Wi-Fi' : 'Off';
    }

    toggleWifi() {
        try {
            const nm = Main.panel.statusArea.quickSettings?._network?._client;
            if (nm) {
                nm.wireless_enabled = !nm.wireless_enabled;
            } else {
                GLib.spawn_command_line_async(`nmcli radio wifi ${this.isWifiEnabled() ? 'off' : 'on'}`);
            }
        } catch (_) {
            GLib.spawn_command_line_async(`nmcli radio wifi ${this.isWifiEnabled() ? 'off' : 'on'}`);
        }

        this._refreshSoon();
    }

    openWifiSettings() {
        GLib.spawn_command_line_async('gnome-control-center wifi');
    }

    // ================= 6. POWER PROFILE =================
    _refreshPowerProfiles(index = 0) {
        const services = [
            ['org.freedesktop.UPower.PowerProfiles', '/org/freedesktop/UPower/PowerProfiles'],
            ['net.hadess.PowerProfiles', '/net/hadess/PowerProfiles'],
        ];
        const [name, path] = services[index];
        Gio.DBus.system.call(name, path, 'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', [name]), null, Gio.DBusCallFlags.NONE, 1000,
            this._cancellable, (bus, result) => {
                try {
                    const [props] = bus.call_finish(result).deep_unpack();
                    if (this._cancellable.is_cancelled()) return;
                    const unpack = v => v?.deep_unpack ? v.deep_unpack() : v;
                    const profile = unpack(props.ActiveProfile);
                    if (!profile) throw new Error('Missing power profile');
                    this._powerService = {name, path};
                    this._powerState = {profile,
                        profiles: (unpack(props.Profiles) || []).map(p => unpack(p.Profile))};
                    this._powerError = null;
                    this._notify();
                } catch (_) {
                    if (this._cancellable.is_cancelled()) return;
                    if (index === 0) this._refreshPowerProfiles(1);
                    else {
                        this._powerState = {profile: null, profiles: []};
                        this._notify();
                    }
                }
            });
    }

    getPowerProfile() {
        return {'performance': 'Performance', 'balanced': 'Balanced', 'power-saver': 'Power Saver'}[this._powerState.profile] || 'Tidak tersedia';
    }

    getPowerProfiles() { return this._powerState.profiles; }
    getPowerError() { return this._powerError; }
    isPowerPending() { return this._powerPending; }

    setPowerProfile(profile) {
        if (this._powerPending || !this._powerService || !this._powerState.profiles.includes(profile)) return;
        this._powerPending = true;
        this._powerError = null;
        this._notify();
        const {name, path} = this._powerService;
        Gio.DBus.system.call(name, path, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [name, 'ActiveProfile', new GLib.Variant('s', profile)]),
            null, Gio.DBusCallFlags.NONE, 2000, this._cancellable, (bus, result) => {
                try { bus.call_finish(result); }
                catch (_) { this._powerError = 'Gagal mengganti mode daya'; }
                if (this._cancellable.is_cancelled()) return;
                this._powerPending = false;
                this._notify();
                if (!this._powerError) this._refreshPowerProfiles();
            });
    }

    // ================= 7. SHORTCUT SISTEM =================
    openScreenshot() {
        try {
            Main.screenshotUI?.open?.();
        } catch (_) {}
    }

    openSettings() {
        GLib.spawn_command_line_async('gnome-control-center');
    }

    lockScreen() {
        try {
            Main.screenShield?.lock?.(true);
        } catch (_) {}
    }

    openPowerMenu() {
        try {
            SystemActions.getDefault().activateAction('power-off');
        } catch (_) {}
    }

    _refreshSoon() {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._timers.delete(id);
            this._notify();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    _notify() {
        try {
            this._onUpdate?.();
        } catch (_) {}
    }

    destroy() {
        for (const id of this._timers) GLib.source_remove(id);
        this._timers.clear();
        this._cancellable.cancel();
        if (this._powerSignal) Gio.DBus.system.signal_unsubscribe(this._powerSignal);
        if (this._darkSig) this._interfaceSettings.disconnect(this._darkSig);
        if (this._nightSig) this._colorSettings.disconnect(this._nightSig);

        try {
            const qs = Main.panel.statusArea.quickSettings;
            const btToggle = qs?._bluetooth?._toggle || qs?._bluetooth?.quickSettingsItems?.[0];
            if (btToggle && this._btSig) btToggle.disconnect(this._btSig);

            const netClient = qs?._network?._client;
            if (netClient && this._wifiSig) netClient.disconnect(this._wifiSig);
            if (netClient && this._wifiConnectionSig) netClient.disconnect(this._wifiConnectionSig);

            const rfkillToggle = qs?._rfkill?._toggle || qs?._rfkill?.quickSettingsItems?.[0];
            if (rfkillToggle && this._rfkillSig) rfkillToggle.disconnect(this._rfkillSig);
        } catch (_) {}

        this._onUpdate = null;
    }
}