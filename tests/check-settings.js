import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
const source = Gio.SettingsSchemaSource.new_from_directory(
    GLib.build_filenamev([GLib.get_current_dir(), 'schemas']), Gio.SettingsSchemaSource.get_default(), false);
const schema = source.lookup('org.gnome.shell.extensions.dynamic-island', false);
if (!schema) throw new Error('Missing schema');
for (const key of ['popup-duration', 'island-scale', 'top-offset', 'horizontal-offset', 'test-mode', 'enable-privacy'])
    if (!schema.has_key(key)) throw new Error(`Missing ${key}`);
if (schema.get_key('test-mode').get_default_value().get_boolean()) throw new Error('Test mode must default off');
print('PASS: compiled settings schema and defaults');
