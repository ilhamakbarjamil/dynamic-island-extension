#!/usr/bin/env bash
# Install only runtime files; never copy .git or development artifacts.
set -euo pipefail

usage() {
    printf '%s\n' 'Usage: bash install.sh [--no-enable | --enable]'  \
        'Default: install and enable automatically. --no-enable only copies files.'
}
enable=true
case "${1:-}" in
    '') ;;
    --enable) enable=true ;;
    --no-enable) enable=false ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { usage >&2; exit 2; }
for command in python3 glib-compile-schemas; do
    command -v "$command" >/dev/null || { printf 'Required command missing: %s\n' "$command" >&2; exit 1; }
done
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
uuid="$(python3 - "$source_dir/metadata.json" <<'PY'
import json, re, sys
value = json.load(open(sys.argv[1]))['uuid']
if not re.fullmatch(r'[A-Za-z0-9_.@+-]+', value):
    raise SystemExit('Invalid extension UUID')
print(value)
PY
)"
if "$enable"; then
    if [[ "$(id -u)" == 0 ]]; then
        echo 'Jalankan installer sebagai pengguna desktop biasa, tanpa sudo.' >&2
        exit 1
    fi
    for command in gnome-shell gnome-extensions gjs; do
        command -v "$command" >/dev/null || { echo "Perintah belum tersedia: $command. Lihat bagian persyaratan di README.md." >&2; exit 1; }
    done
    shell_version="$(gnome-shell --version)"
    python3 - "$source_dir/metadata.json" "$shell_version" <<'PYVERSION'
import json, re, sys
supported = json.load(open(sys.argv[1]))['shell-version']
match = re.search(r'\b(\d+)\.', sys.argv[2])
if not match or match[1] not in supported:
    raise SystemExit('Versi GNOME tidak didukung: ' + sys.argv[2] + '. Diperlukan GNOME ' + ', '.join(supported))
PYVERSION
fi
existing=false
data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
[[ "$data_dir" = /* ]] || { echo 'XDG_DATA_HOME must be an absolute path.' >&2; exit 1; }
target="$data_dir/gnome-shell/extensions/$uuid"
stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT
for file in extension.js prefs.js stylesheet.css metadata.json; do
    cp -- "$source_dir/$file" "$stage/"
done
cp -R -- "$source_dir/src" "$stage/src"
mkdir -p "$stage/schemas" "$stage/tools"
cp -- "$source_dir"/schemas/*.gschema.xml "$stage/schemas/"
cp -- "$source_dir/tools/island-test" "$stage/tools/"
glib-compile-schemas --strict "$stage/schemas"

# Keep a complete backup before replacing an existing installation.
if [[ -d "$target" ]]; then
    existing=true
    backup_root="$data_dir/gnome-shell/extension-backups"
    mkdir -p "$backup_root"
    backup="$(mktemp -d "$backup_root/$uuid.XXXXXXXX")"
    cp -a -- "$target/." "$backup/"
    printf 'Backup: %s\n' "$backup"
fi
mkdir -p "$target"
cp -R -- "$stage/." "$target/"
chmod +x "$target/tools/island-test"
printf 'Installed: %s\n' "$target"
if "$enable"; then
    cat > "$stage/activate.js" <<'JSACTIVATE'
const Gio = imports.gi.Gio;
const uuid = ARGV[0];
const settings = new Gio.Settings({schema_id: 'org.gnome.shell'});
const enabled = settings.get_strv('enabled-extensions');
if (!enabled.includes(uuid) && !settings.set_strv('enabled-extensions', [...enabled, uuid]))
    throw new Error('Tidak dapat menyimpan aktivasi ekstensi');
if (settings.settings_schema.has_key('disabled-extensions')) {
    const disabled = settings.get_strv('disabled-extensions');
    if (disabled.includes(uuid) && !settings.set_strv('disabled-extensions', disabled.filter(id => id !== uuid)))
        throw new Error('Tidak dapat mengaktifkan ekstensi');
}
Gio.Settings.sync();
if (settings.get_boolean('disable-user-extensions')) {
    printerr('Ekstensi pengguna dinonaktifkan secara global. Aktifkan dengan: gsettings set org.gnome.shell disable-user-extensions false');
}
JSACTIVATE
    gjs "$stage/activate.js" "$uuid"
    if gnome-extensions enable "$uuid"; then
        echo 'Aktivasi telah diminta. Periksa apakah Dynamic Island muncul di bagian atas layar.'
    else
        echo 'File terpasang dan aktivasi tersimpan. Logout lalu login agar GNOME mengenali ekstensi baru.'
    fi
    if "$existing"; then
        echo 'Instalasi lama diperbarui: logout/login diperlukan untuk memuat kode terbaru.'
    fi
else
    echo 'File terpasang; aktivasi dilewati (--no-enable).'
fi
printf '%s\n' "Pengaturan: gnome-extensions prefs $uuid" \
    'Installer tidak melakukan logout atau restart desktop secara otomatis.'
