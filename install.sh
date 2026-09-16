#!/usr/bin/env bash
# Install only runtime files; never copy .git or development artifacts.
set -euo pipefail

usage() {
    printf '%s\n' 'Usage: ./install.sh [--enable]' \
        'Installs for the current user. --enable asks GNOME Shell to enable the extension.'
}
enable=false
case "${1:-}" in
    '') ;;
    --enable) enable=true ;;
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
    if command -v gnome-extensions >/dev/null && gnome-extensions enable "$uuid"; then
        echo 'Extension enabled.'
    else
        echo 'GNOME Shell could not enable it yet. Log out/in, then enable it in Extensions.' >&2
    fi
fi
printf '%s\n' 'For new JavaScript code on Wayland, log out and log back in.' \
    "Preferences: gnome-extensions prefs $uuid"
