import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class VpnWatcher {
    constructor(onChange) {
        this._onChange = onChange;
        this._pollId = null;
        this._nmSig = null;
        this._lastConnected = null;
        this._lastName = 'VPN';

        this._setup();
    }

    _setup() {
        // Ambil status awal tanpa memicu pop-up saat sistem booting/reload
        const initial = this._getVpnStatus();
        this._lastConnected = initial.isConnected;
        this._lastName = initial.name;

        // Monitor NetworkManager bawaan GNOME (jika ada VPN GUI/Settings)
        try {
            const client = Main.panel?.statusArea?.quickSettings?._network?._client;
            if (client) {
                this._nmClient = client;
                this._nmSig = client.connect('notify::active-connections', () => this._checkStatus());
            }
        } catch (_) {}

        // Polling cepat setiap 600ms (mendeteksi Cloudflare WARP CLI / WireGuard / Tun)
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            this._checkStatus();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _isInterfaceUp(ifacePath) {
        try {
            // Periksa operstate (up / unknown)
            const operFile = Gio.File.new_for_path(`${ifacePath}/operstate`);
            if (operFile.query_exists(null)) {
                const [ok, bytes] = operFile.load_contents(null);
                if (ok) {
                    const state = new TextDecoder().decode(bytes).trim().toLowerCase();
                    if (state === 'down') return false;
                }
            }

            // Periksa flags kernel Linux (Bit 0 = IFF_UP)
            const flagsFile = Gio.File.new_for_path(`${ifacePath}/flags`);
            if (flagsFile.query_exists(null)) {
                const [ok, bytes] = flagsFile.load_contents(null);
                if (ok) {
                    const flagsStr = new TextDecoder().decode(bytes).trim();
                    const flags = parseInt(flagsStr, 16);
                    if (!isNaN(flags)) {
                        return (flags & 0x1) !== 0;
                    }
                }
            }
            return false;
        } catch (_) {
            return false;
        }
    }

    _checkSysNet() {
        let enumerator;
        try {
            const netDir = Gio.File.new_for_path('/sys/class/net');
            if (!netDir.query_exists(null)) return null;

            enumerator = netDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;

            while ((info = enumerator.next_file(null)) !== null) {
                const iface = info.get_name();
                const lower = iface.toLowerCase();

                // 1. Deteksi Cloudflare WARP (nama interface di Linux: "CloudflareWARP")
                if (lower.includes('cloudflare') || lower.includes('warp')) {
                    if (this._isInterfaceUp(`/sys/class/net/${iface}`)) {
                        return { isConnected: true, name: 'WARP' };
                    }
                }

                // 2. Deteksi WireGuard, Tailscale, OpenVPN, Proton, Mullvad
                if (lower.startsWith('wg') || lower.startsWith('tailscale') || lower.startsWith('tun') || lower.startsWith('proton') || lower.startsWith('mullvad')) {
                    if (this._isInterfaceUp(`/sys/class/net/${iface}`)) {
                        let name = 'VPN';
                        if (lower.startsWith('wg')) name = 'WireGuard';
                        else if (lower.startsWith('tailscale')) name = 'Tailscale';
                        else if (lower.startsWith('proton')) name = 'Proton VPN';
                        return { isConnected: true, name };
                    }
                }
            }
        } catch (_) {}
        finally { enumerator?.close(null); }
        return null;
    }

    _checkNetworkManager() {
        try {
            const client = Main.panel?.statusArea?.quickSettings?._network?._client;
            const activeConnections = client?.active_connections || [];

            for (const conn of activeConnections) {
                const isVpn = Boolean(conn.vpn);
                const type = String(conn.get_connection_type?.() || conn.type || '').toLowerCase();
                const state = conn.get_state?.() ?? conn.state;

                if ((isVpn || type === 'vpn' || type === 'wireguard' || type === 'tun') && state === 2) {
                    const id = conn.get_id?.() || conn.id || 'VPN';
                    let name = id;
                    if (id.toLowerCase().includes('warp')) name = 'WARP';
                    return { isConnected: true, name };
                }
            }
        } catch (_) {}
        return null;
    }

    _getVpnStatus() {
        // Cek kernel interface CloudflareWARP & tunnel
        const sys = this._checkSysNet();
        if (sys && sys.isConnected) return sys;

        // Cek NetworkManager GNOME
        const nm = this._checkNetworkManager();
        if (nm && nm.isConnected) return nm;

        return { isConnected: false, name: 'VPN' };
    }

    _checkStatus() {
        const current = this._getVpnStatus();

        if (this._lastConnected === null) {
            this._lastConnected = current.isConnected;
            this._lastName = current.name;
            return;
        }

        // HANYA picu animasi saat status benar-benar BERUBAH (ON -> OFF atau OFF -> ON)
        if (current.isConnected !== this._lastConnected ||
            (current.isConnected && current.name !== this._lastName)) {
            const isNowConnected = current.isConnected;
            const displayName = isNowConnected ? current.name : (this._lastName || 'VPN');

            this._lastConnected = isNowConnected;
            if (isNowConnected) {
                this._lastName = current.name;
            }

            this._onChange?.({
                name: displayName,
                isConnected: isNowConnected,
            });
        }
    }

    destroy() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = null;
        }
        if (this._nmSig) {
            try {
                this._nmClient?.disconnect(this._nmSig);
            } catch (_) {}
            this._nmSig = null;
        }
        this._onChange = null;
    }
}