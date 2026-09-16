import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

export class ControlCenterManager {
    constructor(onUpdate) {
        this._onUpdate = onUpdate;

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

        try {
            const res = Gio.DBus.system.call_sync(
                'org.bluez',
                '/org/bluez/hci0',
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.bluez.Adapter1', 'Powered']),
                null,
                Gio.DBusCallFlags.NONE,
                150,
                null
            );
            const [val] = res.deep_unpack();
            return Boolean(val?.deep_unpack?.() ?? val);
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

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._notify();
            return GLib.SOURCE_REMOVE;
        });

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
        try {
            const res = Gio.DBus.session.call_sync(
                'org.gnome.SettingsDaemon.Rfkill',
                '/org/gnome/SettingsDaemon/Rfkill',
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.gnome.SettingsDaemon.Rfkill', 'AirplaneMode']),
                null,
                Gio.DBusCallFlags.NONE,
                150,
                null
            );
            const [val] = res.deep_unpack();
            return Boolean(val?.deep_unpack?.() ?? val);
        } catch (_) {}

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

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._notify();
            return GLib.SOURCE_REMOVE;
        });

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
            return nm ? nm.wireless_enabled : true;
        } catch (_) {
            return true;
        }
    }

    getWifiSsid() {
        try {
            const activeConn = Main.panel.statusArea.quickSettings?._network?._client?.active_connections;
            if (activeConn) {
                for (let conn of activeConn) {
                    if (conn.type === '802-11-wireless') return conn.id || 'Wi-Fi';
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
                GLib.spawn_command_line_async('nmcli radio wifi toggle');
            }
        } catch (_) {
            GLib.spawn_command_line_async('nmcli radio wifi toggle');
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._notify();
            return GLib.SOURCE_REMOVE;
        });
    }

    openWifiSettings() {
        GLib.spawn_command_line_async('gnome-control-center wifi');
    }

    // ================= 6. POWER PROFILE =================
    getPowerProfile() {
        try {
            const res = Gio.DBus.system.call_sync(
                'net.hadess.PowerProfiles',
                '/net/hadess/PowerProfiles',
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['net.hadess.PowerProfiles', 'ActiveProfile']),
                null,
                Gio.DBusCallFlags.NONE,
                200,
                null
            );
            const [val] = res.deep_unpack();
            const profile = String(val?.deep_unpack?.() ?? val);
            if (profile.includes('performance')) return 'Performance';
            if (profile.includes('power-saver')) return 'Power Saver';
            return 'Balanced';
        } catch (_) {
            return 'Balanced';
        }
    }

    togglePowerMode() {
        const current = this.getPowerProfile();
        const next = current === 'Balanced' ? 'performance' : (current === 'Performance' ? 'power-saver' : 'balanced');
        try {
            Gio.DBus.system.call_sync(
                'net.hadess.PowerProfiles',
                '/net/hadess/PowerProfiles',
                'org.freedesktop.DBus.Properties',
                'Set',
                new GLib.Variant('(ssv)', ['net.hadess.PowerProfiles', 'ActiveProfile', new GLib.Variant('s', next)]),
                null,
                Gio.DBusCallFlags.NONE,
                300,
                null
            );
        } catch (_) {}

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._notify();
            return GLib.SOURCE_REMOVE;
        });
        return next;
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

    _notify() {
        try {
            this._onUpdate?.();
        } catch (_) {}
    }

    destroy() {
        if (this._darkSig) this._interfaceSettings.disconnect(this._darkSig);
        if (this._nightSig) this._colorSettings.disconnect(this._nightSig);

        try {
            const qs = Main.panel.statusArea.quickSettings;
            const btToggle = qs?._bluetooth?._toggle || qs?._bluetooth?.quickSettingsItems?.[0];
            if (btToggle && this._btSig) btToggle.disconnect(this._btSig);

            const netClient = qs?._network?._client;
            if (netClient && this._wifiSig) netClient.disconnect(this._wifiSig);

            const rfkillToggle = qs?._rfkill?._toggle || qs?._rfkill?.quickSettingsItems?.[0];
            if (rfkillToggle && this._rfkillSig) rfkillToggle.disconnect(this._rfkillSig);
        } catch (_) {}

        this._onUpdate = null;
    }
}