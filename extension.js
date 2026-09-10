import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { MediaWatcher } from './mpris.js';

export default class DynamicIslandExtension extends Extension {
    enable() {
        console.log('[DynamicIsland] ===== ENABLE =====');

        // ==== SETTINGS ====
        this._settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
        this._originalShowBanners = this._settings.get_boolean('show-banners');
        this._settings.set_boolean('show-banners', false);

        // ==== DIMENSI ====
        this._collapsedWidth  = 140;
        this._collapsedHeight = 34;
        this._expandedWidth   = 400;
        this._expandedHeight  = 88;

        // ==== STATE ====
        this._isExpanded = false;
        this._isVisible = false;
        this._mediaActive = false;
        this._currentMedia = null;
        this._currentNotification = null;
        this._notificationQueue = [];
        this._isProcessingQueue = false;
        this._waitingForMouseLeave = false;
        this._autoCollapseId = null;
        this._waveTickId = null;
        this._wavePhase = 0;
        this._coverCache = new Map();

        this._monitor = Main.layoutManager.primaryMonitor;
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._monitor = Main.layoutManager.primaryMonitor;
            this._reposition(this._isExpanded ? this._expandedWidth : this._collapsedWidth);
        });

        // ============ PILL UTAMA ============
        this._island = new St.BoxLayout({
            style_class: 'dynamic-island-pill',
            reactive: true,
            track_hover: true,
            visible: false,
            opacity: 0,
            width: this._collapsedWidth,
            height: this._collapsedHeight,
            vertical: false,
        });

        // ============ KONTEN ============
        this._content = new St.BoxLayout({
            style_class: 'dynamic-island-content',
            vertical: false,
            opacity: 0,
            visible: false,
            reactive: false,
            x_expand: true,
            y_expand: true,
        });

        this._icon = new St.Icon({
            icon_size: 40,
            icon_name: 'dialog-information-symbolic',
        });

        this._iconBin = new St.Bin({
            style_class: 'dynamic-island-cover-art',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
            child: this._icon,
        });
        this._content.add_child(this._iconBin);

        this._textInfo = new St.BoxLayout({
            style_class: 'dynamic-island-track-info',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
        });
        this._titleLabel = new St.Label({
            style_class: 'dynamic-island-title',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._bodyLabel = new St.Label({
            style_class: 'dynamic-island-artist',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._titleLabel.clutter_text.ellipsize = 2;
        this._bodyLabel.clutter_text.ellipsize  = 2;
        this._textInfo.add_child(this._titleLabel);
        this._textInfo.add_child(this._bodyLabel);
        this._content.add_child(this._textInfo);

        // ============ TOMBOL AKSI ============
        this._actionBox = new St.BoxLayout({
            style_class: 'dynamic-island-actions',
            vertical: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
        });
        this._playBtn = new St.Button({
            style_class: 'dynamic-island-btn',
            child: new St.Icon({ icon_name: 'media-playback-pause-symbolic', icon_size: 14 }),
            can_focus: false,
        });
        this._nextBtn = new St.Button({
            style_class: 'dynamic-island-btn',
            child: new St.Icon({ icon_name: 'media-skip-forward-symbolic', icon_size: 14 }),
            can_focus: false,
        });
        this._actionBox.add_child(this._playBtn);
        this._actionBox.add_child(this._nextBtn);
        this._content.add_child(this._actionBox);

        this._island.add_child(this._content);

        // ============ WAVE ============
        this._waveBars = [];
        this._waveBox = new St.BoxLayout({
            style_class: 'dynamic-island-wave',
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
            reactive: false,
        });
        for (let i = 0; i < 4; i++) {
            const bar = new St.Widget({
                style_class: 'dynamic-island-wave-bar',
                width: 3,
                height: 6,
                y_align: Clutter.ActorAlign.CENTER,
                reactive: false,
            });
            this._waveBars.push(bar);
            this._waveBox.add_child(bar);
        }
        this._island.add_child(this._waveBox);

        Main.uiGroup.add_child(this._island);
        this._reposition(this._collapsedWidth);
        this._island.queue_relayout();

        // ============ INTERAKSI HOVER ============
        this._island.connect('notify::hover', () => {
            const hovering = this._island.hover;
            const hasContent = this._isProcessingQueue || this._mediaActive;
            if (hovering && hasContent) {
                this._expand();
            } else if (!hovering) {
                if (this._isProcessingQueue && this._waitingForMouseLeave) {
                    this._waitingForMouseLeave = false;
                    this._collapseAndNext();
                } else if (!this._isProcessingQueue) {
                    this._collapse();
                }
            }
        });

        this._island.connect('button-release-event', () => {
            if (this._currentNotification) this._onIslandClicked();
            return Clutter.EVENT_STOP;
        });

        this._playBtn.connect('clicked', () => this._media?.togglePlayPause());
        this._nextBtn.connect('clicked', () => this._media?.next());

        // ============ NOTIFIKASI ============
        this._sourceConnections = new Map();
        Main.messageTray.getSources().forEach(s => this._connectSource(s));
        this._sourceAddedId = Main.messageTray.connect('source-added', (_t, s) => {
            this._connectSource(s);
        });
        this._sourceRemovedId = Main.messageTray.connect('source-removed', (_t, s) => {
            this._disconnectSource(s);
        });

        // ============ MPRIS ============
        console.log('[DynamicIsland] Init MPRIS...');
        this._media = new MediaWatcher(state => this._onMediaUpdate(state));

        // ============ WAVE TIMER ============
        this._waveTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
            const playing = this._currentMedia?.status === 'Playing';
            if (!this._isExpanded && this._mediaActive && playing && this._isVisible) {
                const patterns = [10, 18, 26, 14, 22, 8];
                this._wavePhase = (this._wavePhase + 1) % patterns.length;
                this._waveBars.forEach((bar, i) => {
                    bar.ease({
                        height: patterns[(this._wavePhase + i) % patterns.length],
                        duration: 200,
                        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    });
                });
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ================= VISIBILITY =================
    _showIsland() {
        if (!this._island || this._isVisible) return;
        this._isVisible = true;
        this._island.visible = true;
        this._island.queue_relayout();
        this._island.opacity = 255;
    }

    _hideIsland() {
        if (!this._island || !this._isVisible) return;
        this._isVisible = false;
        // State untuk progress bar
        this._progressTickId = null;
        this._isDraggingSeek = false;
        this._cachedPosition = 0;
        this._island.opacity = 0;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 220, () => {
            if (!this._isVisible && this._island) this._island.visible = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    // ================= POSISI =================
    _reposition(currentWidth) {
        if (!this._island || !this._monitor) return;
        const x = this._monitor.x + Math.floor((this._monitor.width - currentWidth) / 2);
        const y = this._monitor.y + 6;
        this._island.set_position(x, y);
        this._island.queue_relayout();
    }

    // ================= NOTIFIKASI =================
    _connectSource(source) {
        if (this._sourceConnections.has(source)) return;
        const id = source.connect('notification-added', (_s, n) => this._onNotification(n));
        this._sourceConnections.set(source, id);
    }

    _disconnectSource(source) {
        if (this._sourceConnections.has(source)) {
            try { source.disconnect(this._sourceConnections.get(source)); } catch (_) {}
            this._sourceConnections.delete(source);
        }
    }

    _onNotification(notification) {
        this._notificationQueue.push(notification);
        this._processQueue();
    }

    _processQueue() {
        if (this._isProcessingQueue || this._notificationQueue.length === 0) return;

        this._isProcessingQueue = true;
        this._currentNotification = this._notificationQueue.shift();
        this._waitingForMouseLeave = false;

        const n = this._currentNotification;
        this._titleLabel.set_text(n.title || 'Pesan Baru');
        this._bodyLabel.set_text(n.body || '');

        if (n.gicon)          this._setIcon({ gicon: n.gicon });
        else if (n.icon_name) this._setIcon({ iconName: n.icon_name });
        else                  this._setIcon({ iconName: 'dialog-information-symbolic' });

        this._showIsland();
        this._actionBox.visible = false;

        this._triggerAutoExpand();
    }

    _setIcon({ gicon = null, iconName = null, pixbuf = null }) {
        this._icon.gicon = null;
        this._icon.icon_name = null;

        if (gicon) {
            this._icon.gicon = gicon;
        } else if (pixbuf) {
            try {
                const [ok, buffer] = pixbuf.save_to_bufferv('png', [], []);
                if (ok) {
                    const bytes = GLib.Bytes.new(buffer);
                    this._icon.gicon = Gio.BytesIcon.new(bytes);
                } else {
                    this._icon.icon_name = 'audio-x-generic-symbolic';
                }
            } catch (_) {
                this._icon.icon_name = 'audio-x-generic-symbolic';
            }
        } else if (iconName) {
            this._icon.icon_name = iconName;
        } else {
            this._icon.icon_name = 'dialog-information-symbolic';
        }
    }

    // ================= MEDIA =================
    _onMediaUpdate(state) {
        console.log('[DynamicIsland] Media:', JSON.stringify(state));
        this._currentMedia = state;

        if (!state || state.status === 'Stopped') {
            this._mediaActive = false;
            this._waveBox.visible = false;
            this._actionBox.visible = false;
            if (!this._isProcessingQueue) {
                this._hideIsland();
                this._collapse();
            }
            return;
        }

        this._mediaActive = true;
        this._showIsland();

        this._titleLabel.set_text(state.title || 'Sedang diputar');
        this._bodyLabel.set_text(state.artist || '');
        this._loadCoverArt(state.artUrl);

        this._playBtn.child.icon_name = state.status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        this._waveBox.visible = !this._isExpanded && !this._isProcessingQueue;
        this._actionBox.visible = this._isExpanded && !this._isProcessingQueue;
    }

    _loadCoverArt(url) {
        if (!url) {
            this._setIcon({ iconName: 'audio-x-generic-symbolic' });
            return;
        }

        if (url.startsWith('file://')) {
            try {
                const path = Gio.File.new_for_uri(url).get_path();
                const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 96, 96, true);
                this._setIcon({ pixbuf: pb });
            } catch (_) {
                this._setIcon({ iconName: 'audio-x-generic-symbolic' });
            }
            return;
        }

        if (this._coverCache.has(url)) {
            this._setIcon({ pixbuf: this._coverCache.get(url) });
            return;
        }

        this._setIcon({ iconName: 'audio-x-generic-symbolic' });

        try {
            const file = Gio.File.new_for_uri(url);
            file.load_contents_async(null, (f, res) => {
                try {
                    const [, contents] = f.load_contents_finish(res);
                    const stream = Gio.MemoryInputStream.new_from_bytes(contents);
                    const pb = GdkPixbuf.Pixbuf.new_from_stream_at_scale(stream, 96, 96, true, null);
                    this._coverCache.set(url, pb);
                    if (this._currentMedia?.artUrl === url) {
                        this._setIcon({ pixbuf: pb });
                    }
                } catch (_) {}
            });
        } catch (_) {}
    }

    // ================= EXPAND / COLLAPSE =================
    _triggerAutoExpand() {
        if (this._autoCollapseId) {
            GLib.source_remove(this._autoCollapseId);
            this._autoCollapseId = null;
        }
        this._expand();
        this._autoCollapseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
            this._autoCollapseId = null;
            if (this._island?.hover) this._waitingForMouseLeave = true;
            else                     this._collapseAndNext();
            return GLib.SOURCE_REMOVE;
        });
    }

    _expand() {
        if (this._isExpanded || !this._island) return;
        this._isExpanded = true;

        const newX = this._monitor.x + Math.floor((this._monitor.width - this._expandedWidth) / 2);

        this._island.ease({
            width: this._expandedWidth,
            height: this._expandedHeight,
            x: newX,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });

        this._content.visible = true;
        this._content.ease({
            opacity: 255,
            duration: 200,
            delay: 60,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._waveBox.visible = false;
        if (this._mediaActive && !this._isProcessingQueue) this._actionBox.visible = true;
    }

    _collapse() {
        if (!this._isExpanded || !this._island) return;
        this._isExpanded = false;

        const newX = this._monitor.x + Math.floor((this._monitor.width - this._collapsedWidth) / 2);

        this._island.ease({
            width: this._collapsedWidth,
            height: this._collapsedHeight,
            x: newX,
            duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._content.ease({
            opacity: 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => { this._content.visible = false; },
        });

        this._actionBox.visible = false;
        if (this._mediaActive && !this._isProcessingQueue) this._waveBox.visible = true;
    }

    _collapseAndNext() {
        this._collapse();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 380, () => {
            this._isProcessingQueue = false;
            this._waitingForMouseLeave = false;
            this._currentNotification = null;
            this._processQueue();
            if (!this._isProcessingQueue && this._mediaActive) {
                this._waveBox.visible = !this._isExpanded;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _onIslandClicked() {
        if (!this._currentNotification) return;
        this._currentNotification.activate();
        if (this._autoCollapseId) {
            GLib.source_remove(this._autoCollapseId);
            this._autoCollapseId = null;
        }
        this._collapseAndNext();
    }

    // ================= DISABLE =================
    disable() {
        if (this._settings) {
            this._settings.set_boolean('show-banners', this._originalShowBanners);
            this._settings = null;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        if (this._sourceAddedId) {
            Main.messageTray.disconnect(this._sourceAddedId);
            this._sourceAddedId = null;
        }
        if (this._sourceRemovedId) {
            Main.messageTray.disconnect(this._sourceRemovedId);
            this._sourceRemovedId = null;
        }
        for (const [source, id] of this._sourceConnections)
            try { source.disconnect(id); } catch (_) {}
        this._sourceConnections.clear();

        if (this._autoCollapseId) {
            GLib.source_remove(this._autoCollapseId);
            this._autoCollapseId = null;
        }
        if (this._waveTickId) {
            GLib.source_remove(this._waveTickId);
            this._waveTickId = null;
        }
        if (this._media) {
            this._media.destroy();
            this._media = null;
        }

        this._notificationQueue = [];
        this._isProcessingQueue = false;
        this._waitingForMouseLeave = false;
        this._currentNotification = null;
        this._coverCache.clear();

        if (this._island) {
            this._island.destroy();
            this._island = null;
        }
    }
}