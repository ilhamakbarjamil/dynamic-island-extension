import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { MediaWatcher } from './mpris.js';
import { BatteryWatcher } from './battery.js';

export default class DynamicIslandExtension extends Extension {
    enable() {
        console.log('[DynamicIsland] Mengaktifkan Dynamic Island...');

        this._settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
        this._originalShowBanners = this._settings.get_boolean('show-banners');
        this._settings.set_boolean('show-banners', false);

        // ======== UKURAN PILL ========
        this._idleWidth       = 124;
        this._compactWidth    = 190;
        this._hudWidth        = 225; // Ukuran khusus Volume & Brightness HUD
        this._chargingWidth   = 235;
        this._collapsedHeight = 35;
        this._expandedWidth   = 380;
        this._expandedHeight  = 112;

        // ======== STATE ========
        this._isExpanded = false;
        this._isChargingBannerActive = false;
        this._isHudActive = false;
        this._chargingDismissId = null;
        this._hudDismissId = null;
        this._notificationQueue = [];
        this._isProcessingQueue = false;
        this._currentNotification = null;
        this._waitingForMouseLeave = false;
        this._autoCollapseId = null;
        this._unhoverTimeoutId = null;
        this._currentMedia = null;
        this._mediaActive = false;
        this._isDraggingSeek = false;
        this._coverCache = new Map();

        // Monitor reposition
        this._monitor = Main.layoutManager.primaryMonitor;
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._monitor = Main.layoutManager.primaryMonitor;
            this._reposition(this._getCurrentPillWidth());
        });

        // Pill Utama
        this._island = new St.BoxLayout({
            style_class: 'dynamic-island-pill',
            reactive: true,
            track_hover: true,
            visible: true,
            opacity: 255,
            width: this._idleWidth,
            height: this._collapsedHeight,
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // ================= 1. VOLUME & BRIGHTNESS HUD VIEW =================
        this._hudBox = new St.BoxLayout({
            style_class: 'dynamic-island-hud-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            reactive: false,
            visible: false,
            opacity: 0,
        });

        this._hudIcon = new St.Icon({
            style_class: 'dynamic-island-hud-icon',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._hudSliderTrack = new St.Widget({
            style_class: 'dynamic-island-hud-track',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._hudSliderFill = new St.Widget({
            style_class: 'dynamic-island-hud-fill',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._hudSliderTrack.add_child(this._hudSliderFill);

        this._hudBox.add_child(this._hudIcon);
        this._hudBox.add_child(this._hudSliderTrack);
        this._island.add_child(this._hudBox);

        // ================= 2. CHARGING VIEW =================
        this._chargingBox = new St.BoxLayout({
            style_class: 'dynamic-island-charging-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            reactive: false,
            visible: false,
            opacity: 0,
        });

        this._chargingLabel = new St.Label({
            style_class: 'dynamic-island-charging-label',
            text: 'Charging',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._chargingRightBox = new St.BoxLayout({
            style_class: 'dynamic-island-charging-right',
            vertical: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        this._chargingPercentLabel = new St.Label({
            style_class: 'dynamic-island-charging-percent',
            text: '100%',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._batteryShell = new St.Widget({
            style_class: 'dynamic-island-battery-shell',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._batteryFill = new St.Widget({
            style_class: 'dynamic-island-battery-fill',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._batteryCap = new St.Widget({
            style_class: 'dynamic-island-battery-cap',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._batteryShell.add_child(this._batteryFill);

        this._chargingBolt = new St.Label({
            style_class: 'dynamic-island-charging-bolt',
            text: '⚡',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._chargingRightBox.add_child(this._chargingPercentLabel);
        this._chargingRightBox.add_child(this._chargingBolt);
        this._chargingRightBox.add_child(this._batteryShell);
        this._chargingRightBox.add_child(this._batteryCap);

        this._chargingBox.add_child(this._chargingLabel);
        this._chargingBox.add_child(this._chargingRightBox);
        this._island.add_child(this._chargingBox);

        // ================= 3. COMPACT VIEW (MUSIC) =================
        this._compactBox = new St.BoxLayout({
            style_class: 'dynamic-island-compact',
            vertical: false,
            x_expand: true,
            y_expand: true,
            reactive: false,
            visible: false,
        });

        this._compactIcon = new St.Icon({
            icon_size: 18,
            icon_name: 'audio-x-generic-symbolic',
        });
        this._compactArtBin = new St.Bin({
            style_class: 'dynamic-island-compact-art',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            child: this._compactIcon,
        });

        this._waveBars = [];
        this._waveBox = new St.BoxLayout({
            style_class: 'dynamic-island-wave',
            vertical: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        for (let i = 0; i < 4; i++) {
            const bar = new St.Widget({
                style_class: 'dynamic-island-wave-bar',
                width: 3,
                height: 6,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._waveBars.push(bar);
            this._waveBox.add_child(bar);
        }

        this._compactBox.add_child(this._compactArtBin);
        this._compactBox.add_child(this._waveBox);
        this._island.add_child(this._compactBox);

        // ================= 4. EXPANDED VIEW =================
        this._content = new St.BoxLayout({
            style_class: 'dynamic-island-content',
            vertical: true,
            opacity: 0,
            visible: false,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });

        this._topRow = new St.BoxLayout({
            style_class: 'dynamic-island-top-row',
            vertical: false,
            x_expand: true,
            reactive: true,
        });

        this._icon = new St.Icon({
            icon_size: 42,
            icon_name: 'dialog-information-symbolic',
        });
        this._iconBin = new St.Bin({
            style_class: 'dynamic-island-cover-art',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: this._icon,
        });
        this._topRow.add_child(this._iconBin);

        this._textInfo = new St.BoxLayout({
            style_class: 'dynamic-island-track-info',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
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
        this._topRow.add_child(this._textInfo);

        this._actionBox = new St.BoxLayout({
            style_class: 'dynamic-island-actions',
            vertical: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        this._prevBtn = new St.Button({
            style_class: 'dynamic-island-btn',
            child: new St.Icon({ icon_name: 'media-skip-backward-symbolic', icon_size: 13 }),
            can_focus: true,
            reactive: true,
        });
        this._playBtn = new St.Button({
            style_class: 'dynamic-island-btn dynamic-island-btn-play',
            child: new St.Icon({ icon_name: 'media-playback-start-symbolic', icon_size: 15 }),
            can_focus: true,
            reactive: true,
        });
        this._nextBtn = new St.Button({
            style_class: 'dynamic-island-btn',
            child: new St.Icon({ icon_name: 'media-skip-forward-symbolic', icon_size: 13 }),
            can_focus: true,
            reactive: true,
        });

        this._actionBox.add_child(this._prevBtn);
        this._actionBox.add_child(this._playBtn);
        this._actionBox.add_child(this._nextBtn);
        this._topRow.add_child(this._actionBox);
        this._content.add_child(this._topRow);

        this._progressRow = new St.BoxLayout({
            style_class: 'dynamic-island-progress-row',
            vertical: false,
            x_expand: true,
            reactive: true,
        });

        this._timeLabel = new St.Label({
            style_class: 'dynamic-island-time',
            text: '0:00',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._progressTrack = new St.Widget({
            style_class: 'dynamic-island-progress-track',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            track_hover: true,
        });
        this._progressFill = new St.Widget({
            style_class: 'dynamic-island-progress-fill',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.FILL,
            reactive: false,
        });
        this._progressTrack.add_child(this._progressFill);

        this._progressHandle = new St.Widget({
            style_class: 'dynamic-island-progress-handle',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
        });
        this._progressTrack.add_child(this._progressHandle);

        this._durationLabel = new St.Label({
            style_class: 'dynamic-island-time',
            text: '0:00',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._progressRow.add_child(this._timeLabel);
        this._progressRow.add_child(this._progressTrack);
        this._progressRow.add_child(this._durationLabel);
        this._content.add_child(this._progressRow);

        this._progressTrack.connect('button-press-event', (_a, event) => {
            if (!this._currentMedia?.canSeek) return Clutter.EVENT_STOP;
            this._isDraggingSeek = true;
            this._seekFromEvent(event);
            return Clutter.EVENT_STOP;
        });
        this._progressTrack.connect('motion-event', (_a, event) => {
            if (!this._isDraggingSeek) return Clutter.EVENT_PROPAGATE;
            this._seekFromEvent(event);
            return Clutter.EVENT_STOP;
        });
        this._progressTrack.connect('button-release-event', () => {
            this._isDraggingSeek = false;
            return Clutter.EVENT_STOP;
        });

        this._island.add_child(this._content);
        Main.uiGroup.add_child(this._island);
        this._reposition(this._idleWidth);

        // ================= HOOK GNOME OSD (VOLUME & BRIGHTNESS) =================
        this._origOsdShow = Main.osdWindowManager.show.bind(Main.osdWindowManager);
        Main.osdWindowManager.show = (monitorIndex, icon, label, level, maxLevel) => {
            let iconName = '';
            if (icon) {
                if (typeof icon.get_names === 'function') {
                    const names = icon.get_names();
                    iconName = names[0] || '';
                } else if (icon.name) {
                    iconName = icon.name;
                } else if (typeof icon.to_string === 'function') {
                    iconName = icon.to_string();
                }
            }

            const isVolume = iconName.startsWith('audio-volume') || iconName.includes('speaker') || iconName.includes('headset');
            const isBrightness = iconName.startsWith('display-brightness');

            if (isVolume || isBrightness || (level !== null && level !== undefined)) {
                // Tampilkan di Dynamic Island dan matikan OSD kotak default GNOME!
                this._showOsdInIsland({ icon, iconName, label, level, maxLevel, isVolume, isBrightness });
                return;
            }

            // OSD lain diteruskan secara normal
            this._origOsdShow(monitorIndex, icon, label, level, maxLevel);
        };

        // Hover
        this._island.connect('notify::hover', () => {
            if (this._isChargingBannerActive || this._isHudActive) return;

            const hovering = this._island.hover;
            const hasContent = this._notificationQueue.length > 0 || this._isProcessingQueue || this._mediaActive;

            if (hovering) {
                if (this._unhoverTimeoutId) {
                    GLib.source_remove(this._unhoverTimeoutId);
                    this._unhoverTimeoutId = null;
                }
                if (hasContent && !this._isExpanded) {
                    this._expand();
                }
            } else {
                if (this._isExpanded && !this._isDraggingSeek) {
                    this._unhoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                        this._unhoverTimeoutId = null;
                        if (this._isProcessingQueue && this._waitingForMouseLeave) {
                            this._waitingForMouseLeave = false;
                            this._collapseAndNext();
                        } else {
                            this._collapse();
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }
        });

        this._prevBtn.connect('clicked', () => this._media?.previous());
        this._playBtn.connect('clicked', () => this._media?.togglePlayPause());
        this._nextBtn.connect('clicked', () => this._media?.next());

        // Notifications
        this._sourceConnections = new Map();
        Main.messageTray.getSources().forEach(s => this._connectSource(s));
        this._sourceAddedId = Main.messageTray.connect('source-added', (_t, s) => this._connectSource(s));
        this._sourceRemovedId = Main.messageTray.connect('source-removed', (_t, s) => this._disconnectSource(s));

        // MPRIS
        this._media = new MediaWatcher(state => this._onMediaUpdate(state));

        // Battery
        this._battery = new BatteryWatcher(event => this._onBatteryEvent(event));

        // Wave Animation
        this._wavePhase = 0;
        this._waveTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
            const playing = this._currentMedia?.status === 'Playing';
            if (!this._isExpanded && !this._isChargingBannerActive && !this._isHudActive && this._mediaActive && playing) {
                const patterns = [8, 16, 22, 12, 19, 6];
                this._wavePhase = (this._wavePhase + 1) % patterns.length;
                this._waveBars.forEach((bar, i) => {
                    bar.ease({
                        height: patterns[(this._wavePhase + i) % patterns.length],
                        duration: 160,
                        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                    });
                });
            }
            return GLib.SOURCE_CONTINUE;
        });

        // Progress Bar
        this._progressTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (this._mediaActive && this._currentMedia?.status === 'Playing' && this._isExpanded && !this._isDraggingSeek) {
                this._updateProgressUI();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ================= VOLUME & BRIGHTNESS HUD =================
    _showOsdInIsland({ icon, iconName, level, maxLevel, isVolume }) {
        if (this._hudDismissId) {
            GLib.source_remove(this._hudDismissId);
            this._hudDismissId = null;
        }

        this._isHudActive = true;

        // Hitung persentase ratio (0.0 - 1.0)
        let ratio = 0;
        if (level !== null && level !== undefined) {
            const max = (maxLevel && maxLevel > 0) ? maxLevel : 1;
            ratio = Math.max(0, Math.min(1, level / max));
        }

        const isMuted = iconName.includes('muted') || (isVolume && ratio === 0);

        // Pasang icon
        if (icon) {
            this._hudIcon.gicon = icon;
        } else if (iconName) {
            this._hudIcon.icon_name = iconName;
        } else {
            this._hudIcon.icon_name = isVolume ? 'audio-volume-high-symbolic' : 'display-brightness-symbolic';
        }

        if (isMuted) {
            this._hudIcon.add_style_class_name('dynamic-island-hud-icon-muted');
        } else {
            this._hudIcon.remove_style_class_name('dynamic-island-hud-icon-muted');
        }

        // Lebar slider track di CSS adalah 140px
        const trackW = 140;
        const fillW = isMuted ? 0 : Math.round(trackW * ratio);
        this._hudSliderFill.width = fillW;

        // Tampilkan HUD Box, sembunyikan yang lain
        this._compactBox.visible = false;
        this._content.visible = false;
        this._chargingBox.visible = false;
        this._hudBox.visible = true;

        // Animasikan meregang cepat
        this._repositionAndResize(this._hudWidth, this._collapsedHeight, 280, Clutter.AnimationMode.EASE_OUT_BACK);

        this._hudBox.ease({
            opacity: 255,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Auto-dismiss setelah 1.8 detik
        this._hudDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => {
            this._hudDismissId = null;
            this._dismissHud();
            return GLib.SOURCE_REMOVE;
        });
    }

    _dismissHud() {
        this._hudBox.ease({
            opacity: 0,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._hudBox.visible = false;
                this._isHudActive = false;

                // Kembalikan ke state sebelumnya
                if (this._isChargingBannerActive) {
                    this._chargingBox.visible = true;
                    this._repositionAndResize(this._chargingWidth, this._collapsedHeight, 280, Clutter.AnimationMode.EASE_OUT_QUAD);
                } else if (this._mediaActive) {
                    this._compactBox.visible = true;
                    this._repositionAndResize(this._compactWidth, this._collapsedHeight, 280, Clutter.AnimationMode.EASE_OUT_QUAD);
                } else {
                    this._repositionAndResize(this._idleWidth, this._collapsedHeight, 280, Clutter.AnimationMode.EASE_OUT_QUAD);
                }
            },
        });
    }

    // ================= CHARGING =================
    _onBatteryEvent({ isCharging, percentage }) {
        if (!isCharging) return;

        if (this._chargingDismissId) {
            GLib.source_remove(this._chargingDismissId);
            this._chargingDismissId = null;
        }

        this._isChargingBannerActive = true;
        this._chargingLabel.set_text('Charging');
        this._chargingPercentLabel.set_text(`${percentage}%`);

        const fillWidth = Math.max(2, Math.floor((percentage / 100) * 20));
        this._batteryFill.width = fillWidth;

        this._compactBox.visible = false;
        this._content.visible = false;
        this._hudBox.visible = false;
        this._chargingBox.visible = true;

        this._repositionAndResize(this._chargingWidth, this._collapsedHeight, 340, Clutter.AnimationMode.EASE_OUT_BACK);

        this._chargingBox.ease({
            opacity: 255,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._chargingDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._chargingDismissId = null;
            this._dismissChargingBanner();
            return GLib.SOURCE_REMOVE;
        });
    }

    _dismissChargingBanner() {
        this._chargingBox.ease({
            opacity: 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._chargingBox.visible = false;
                this._isChargingBannerActive = false;

                if (this._mediaActive) {
                    this._compactBox.visible = true;
                    this._repositionAndResize(this._compactWidth, this._collapsedHeight, 300, Clutter.AnimationMode.EASE_OUT_QUAD);
                } else {
                    this._repositionAndResize(this._idleWidth, this._collapsedHeight, 300, Clutter.AnimationMode.EASE_OUT_QUAD);
                }
            },
        });
    }

    _getCurrentPillWidth() {
        if (this._isHudActive) return this._hudWidth;
        if (this._isChargingBannerActive) return this._chargingWidth;
        if (this._isExpanded) return this._expandedWidth;
        if (this._mediaActive) return this._compactWidth;
        return this._idleWidth;
    }

    _reposition(width) {
        if (!this._island || !this._monitor) return;
        const x = this._monitor.x + Math.floor((this._monitor.width - width) / 2);
        const y = this._monitor.y + 7;
        this._island.set_position(x, y);
    }

    _repositionAndResize(targetWidth, targetHeight, duration = 300, mode = Clutter.AnimationMode.EASE_OUT_BACK) {
        const targetX = this._monitor.x + Math.floor((this._monitor.width - targetWidth) / 2);
        this._island.ease({
            width: targetWidth,
            height: targetHeight,
            x: targetX,
            duration,
            mode,
        });
    }

    // ================= MEDIA =================
    _onMediaUpdate(state) {
        this._currentMedia = state;

        if (!state || state.status === 'Stopped') {
            this._mediaActive = false;
            this._compactBox.visible = false;
            this._actionBox.visible = false;
            this._progressRow.visible = false;

            if (!this._isProcessingQueue && !this._isChargingBannerActive && !this._isHudActive) {
                this._collapse();
            }
            return;
        }

        this._mediaActive = true;
        this._titleLabel.set_text(state.title || 'Sedang Diputar');
        this._bodyLabel.set_text(state.artist || 'Tidak Diketahui');
        this._loadCoverArt(state.artUrl);

        const playIcon = state.status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._playBtn.child.icon_name = playIcon;

        if (!this._isExpanded && !this._isProcessingQueue && !this._isChargingBannerActive && !this._isHudActive) {
            this._compactBox.visible = true;
            this._repositionAndResize(this._compactWidth, this._collapsedHeight);
        }

        if (this._isExpanded) {
            this._actionBox.visible = !this._isProcessingQueue;
            this._progressRow.visible = (state.length > 0) && !this._isProcessingQueue;
            this._updateProgressUI();
        }
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
    }

    _setIcon({ gicon = null, iconName = null, pixbuf = null }) {
        this._icon.gicon = null;
        this._icon.icon_name = null;
        this._compactIcon.gicon = null;
        this._compactIcon.icon_name = null;

        if (gicon) {
            this._icon.gicon = gicon;
            this._compactIcon.gicon = gicon;
        } else if (pixbuf) {
            try {
                const [ok, buffer] = pixbuf.save_to_bufferv('png', [], []);
                if (ok) {
                    const bytesIcon = Gio.BytesIcon.new(GLib.Bytes.new(buffer));
                    this._icon.gicon = bytesIcon;
                    this._compactIcon.gicon = bytesIcon;
                }
            } catch (_) {
                this._icon.icon_name = 'audio-x-generic-symbolic';
                this._compactIcon.icon_name = 'audio-x-generic-symbolic';
            }
        } else if (iconName) {
            this._icon.icon_name = iconName;
            this._compactIcon.icon_name = iconName;
        }
    }

    _formatTime(micros) {
        const sec = Math.max(0, Math.floor(micros / 1_000_000));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    _updateProgressUI() {
        if (!this._currentMedia) return;
        const duration = this._currentMedia.length || 0;
        if (duration <= 0) {
            this._progressRow.visible = false;
            return;
        }
        this._progressRow.visible = true;

        const pos = this._media?.getPosition() ?? 0;
        const ratio = Math.max(0, Math.min(1, pos / duration));
        const trackW = this._progressTrack.width || 210;
        const fillW = Math.floor(trackW * ratio);

        this._progressFill.width = Math.max(0, fillW);
        this._progressHandle.set_position(Math.max(0, fillW - 4), 0);
        this._timeLabel.set_text(this._formatTime(pos));
        this._durationLabel.set_text(this._formatTime(duration));
    }

    _seekFromEvent(event) {
        const duration = this._currentMedia?.length || 0;
        if (duration <= 0) return;

        const coords = event.get_coords();
        const x = coords[0] !== undefined ? coords[0] : 0;
        const [trackX] = this._progressTrack.get_transformed_position();
        const trackW = this._progressTrack.width || 1;

        const ratio = Math.max(0, Math.min(1, (x - trackX) / trackW));
        const target = ratio * duration;

        const fillW = Math.floor(trackW * ratio);
        this._progressFill.width = Math.max(0, fillW);
        this._progressHandle.set_position(Math.max(0, fillW - 4), 0);
        this._timeLabel.set_text(this._formatTime(target));
        this._media?.seek(target);
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
        if (this._isProcessingQueue || this._notificationQueue.length === 0 || this._isChargingBannerActive || this._isHudActive) return;

        this._isProcessingQueue = true;
        this._currentNotification = this._notificationQueue.shift();
        this._waitingForMouseLeave = false;

        const n = this._currentNotification;
        this._titleLabel.set_text(n.title || 'Notifikasi');
        this._bodyLabel.set_text(n.body || '');

        if (n.gicon)          this._setIcon({ gicon: n.gicon });
        else if (n.icon_name) this._setIcon({ iconName: n.icon_name });
        else                  this._setIcon({ iconName: 'dialog-information-symbolic' });

        this._actionBox.visible = false;
        this._progressRow.visible = false;
        this._triggerAutoExpand();
    }

    _triggerAutoExpand() {
        if (this._autoCollapseId) {
            GLib.source_remove(this._autoCollapseId);
            this._autoCollapseId = null;
        }
        this._expand();
        this._autoCollapseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4200, () => {
            this._autoCollapseId = null;
            if (this._island.hover) this._waitingForMouseLeave = true;
            else                    this._collapseAndNext();
            return GLib.SOURCE_REMOVE;
        });
    }

    _expand() {
        if (this._isExpanded || !this._island) return;
        this._isExpanded = true;

        this._compactBox.visible = false;
        this._repositionAndResize(this._expandedWidth, this._expandedHeight, 320, Clutter.AnimationMode.EASE_OUT_BACK);

        this._content.visible = true;
        this._content.ease({
            opacity: 255,
            duration: 200,
            delay: 70,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        if (this._mediaActive && !this._isProcessingQueue) {
            this._actionBox.visible = true;
            this._progressRow.visible = this._currentMedia?.length > 0;
            this._updateProgressUI();
        }
    }

    _collapse() {
        if (!this._isExpanded && this._island.width === this._getCurrentPillWidth()) return;
        this._isExpanded = false;

        const targetWidth = this._mediaActive ? this._compactWidth : this._idleWidth;

        this._content.ease({
            opacity: 0,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._content.visible = false;
                this._actionBox.visible = false;
                this._progressRow.visible = false;
                if (this._mediaActive && !this._isProcessingQueue && !this._isChargingBannerActive && !this._isHudActive) {
                    this._compactBox.visible = true;
                }
            },
        });

        this._repositionAndResize(targetWidth, this._collapsedHeight, 300, Clutter.AnimationMode.EASE_OUT_QUAD);
    }

    _collapseAndNext() {
        this._collapse();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 320, () => {
            this._isProcessingQueue = false;
            this._waitingForMouseLeave = false;
            this._currentNotification = null;

            if (this._notificationQueue.length > 0) {
                this._processQueue();
            } else if (this._mediaActive) {
                this._onMediaUpdate(this._currentMedia);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // ================= DISABLE =================
    disable() {
        // Kembalikan OSD Asli GNOME
        if (this._origOsdShow) {
            Main.osdWindowManager.show = this._origOsdShow;
            this._origOsdShow = null;
        }

        if (this._settings) {
            this._settings.set_boolean('show-banners', this._originalShowBanners);
            this._settings = null;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        if (this._sourceAddedId) Main.messageTray.disconnect(this._sourceAddedId);
        if (this._sourceRemovedId) Main.messageTray.disconnect(this._sourceRemovedId);

        for (const [source, id] of this._sourceConnections) {
            try { source.disconnect(id); } catch (_) {}
        }
        this._sourceConnections.clear();

        if (this._autoCollapseId) GLib.source_remove(this._autoCollapseId);
        if (this._chargingDismissId) GLib.source_remove(this._chargingDismissId);
        if (this._hudDismissId) GLib.source_remove(this._hudDismissId);
        if (this._unhoverTimeoutId) GLib.source_remove(this._unhoverTimeoutId);
        if (this._waveTickId) GLib.source_remove(this._waveTickId);
        if (this._progressTickId) GLib.source_remove(this._progressTickId);

        if (this._battery) {
            this._battery.destroy();
            this._battery = null;
        }
        if (this._media) {
            this._media.destroy();
            this._media = null;
        }
        if (this._island) {
            this._island.destroy();
            this._island = null;
        }
    }
}