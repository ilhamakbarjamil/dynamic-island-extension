import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class Preferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        const page = new Adw.PreferencesPage({title: 'Dynamic Island', icon_name: 'preferences-system-symbolic'});
        window.add(page);
        const appearance = new Adw.PreferencesGroup({title: 'Tampilan', description: 'Perubahan diterapkan langsung.'});
        page.add(appearance);
        for (const [key, title, lower, upper, step, digits] of [
            ['popup-duration', 'Durasi popup (ms)', 1000, 10000, 100, 0],
            ['island-scale', 'Skala island', 0.8, 1.5, 0.05, 2],
            ['top-offset', 'Jarak dari atas (px)', 0, 150, 1, 0],
            ['horizontal-offset', 'Geser horizontal (px)', -600, 600, 10, 0],
        ]) {
            const row = new Adw.SpinRow({title, digits, adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5})});
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            appearance.add(row);
        }
        const features = new Adw.PreferencesGroup({title: 'Fitur'});
        page.add(features);
        for (const [key, title] of Object.entries({notifications:'Notifikasi', media:'Musik', download:'Download', bluetooth:'Bluetooth', vpn:'VPN', workspace:'Workspace', mount:'Drive', privacy:'Indikator kamera & mikrofon', battery:'Pengisian baterai', hud:'Volume & kecerahan', recording:'Perekaman layar'})) {
            const row = new Adw.SwitchRow({title});
            settings.bind(`enable-${key}`, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            features.add(row);
        }
        const test = new Adw.PreferencesGroup({title: 'Pengujian', description: 'Simulasi lokal melalui tools/island-test. Tidak mengubah perangkat.'});
        page.add(test);
        const row = new Adw.SwitchRow({title: 'Aktifkan mode tes CLI'});
        settings.bind('test-mode', row, 'active', Gio.SettingsBindFlags.DEFAULT);
        test.add(row);
    }
}
