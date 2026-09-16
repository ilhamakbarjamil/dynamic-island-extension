# Dynamic Island for GNOME

Ekstensi GNOME Shell yang menampilkan aktivitas sistem dalam pil ringkas,
terinspirasi Dynamic Island. Proyek komunitas, tidak berafiliasi dengan Apple.

## Fitur

- Kontrol musik MPRIS, artwork, dan progres pemutaran.
- Notifikasi dengan pratinjau teks dan antrean berdasarkan prioritas.
- Pemantauan download, Bluetooth, VPN, workspace, dan mount drive.
- Indikator kamera dan mikrofon yang tetap terlihat di samping island.
- Status pengisian baterai, perekaman layar, volume, dan kecerahan.
- Pengaturan ukuran, posisi, durasi popup, dan toggle tiap fitur.
- Mode simulasi CLI tanpa memasang drive atau mengubah perangkat.

## Persyaratan

- **GNOME Shell 46**, sesuai `metadata.json`. Versi lain belum dinyatakan didukung.
- Bash, Python 3, dan `glib-compile-schemas` untuk instalasi.
- GJS dan libadwaita untuk preferensi GNOME.
- `fuser` untuk deteksi tambahan aplikasi yang membuka perangkat kamera langsung.
- `gsettings` dan `gdbus` untuk mode tes CLI; Node.js hanya untuk tes pengembangan.

## Instalasi

Unduh atau clone repositori ini, buka terminal di folder proyek, lalu jalankan:

```bash
./install.sh
```

Installer memasang file runtime ke
`$XDG_DATA_HOME/gnome-shell/extensions/dynamic-island@ilhamakbarjamil.github.com`
(default: `~/.local/share/gnome-shell/extensions/…`) dan mengompilasi schema.
Instalasi lama dicadangkan di direktori `gnome-shell/extension-backups`.
Jalankan sebagai pengguna biasa, tanpa `sudo`.

Logout lalu login kembali, kemudian aktifkan lewat aplikasi Extensions atau:

```bash
gnome-extensions enable dynamic-island@ilhamakbarjamil.github.com
```

`./install.sh --enable` juga mencoba mengaktifkannya langsung. Perubahan JavaScript
pada sesi Wayland tetap memerlukan logout/login agar dimuat ulang.

## Pengaturan

```bash
gnome-extensions prefs dynamic-island@ilhamakbarjamil.github.com
```

Perubahan preferensi diterapkan langsung. Menonaktifkan notifikasi kustom
mengembalikan pengaturan banner sistem sebelumnya.

## Tes tanpa perangkat

Dari folder proyek atau folder instalasi:

```bash
./tools/island-test enable
./tools/island-test mount
./tools/island-test reset
./tools/island-test disable
```

Skenario lain: `bluetooth`, `notification`, `download`, `privacy`, `vpn`, dan
`workspace`. Mode tes nonaktif secara default.
Lihat [panduan pengujian](docs/TESTING.md) untuk detail dan tes otomatis.

## Struktur proyek

```text
extension.js       Entry point dan integrasi UI GNOME Shell
prefs.js           Jendela pengaturan
metadata.json      Identitas dan kompatibilitas ekstensi
stylesheet.css     Tampilan GNOME St
src/               Watcher dan modul fitur
schemas/           Schema GSettings; hasil kompilasi tidak perlu di-commit
tools/island-test  CLI simulasi
install.sh         Installer untuk pengguna saat ini
tests/             Tes otomatis
docs/TESTING.md    Panduan pengujian
```

## Batasan

- Persentase download tidak dapat diketahui hanya dari ukuran file sementara;
  persentase simulasi bukan progres unduhan nyata.
- Deteksi kamera tambahan membaca perangkat video yang sedang dibuka, bukan
  bukti bahwa frame sedang direkam. Mikrofon mengikuti status penggunaan dan mute.
- Deteksi VPN berbasis NetworkManager dan interface merupakan indikator status,
  bukan verifikasi koneksi terenkripsi atau akses internet.
- Kehalusan animasi, scaling, dan dukungan perangkat perlu diuji pada sesi GNOME nyata.

## Persiapan publikasi

Sesuaikan URL repositori pada `metadata.json` sebelum publikasi. Tambahkan screenshot
hasil pengujian dan file `LICENSE` setelah menentukan lisensi yang diinginkan.
Repositori ini belum menetapkan lisensi penggunaan ulang.
