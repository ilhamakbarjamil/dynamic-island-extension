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
        console.log('[DynamicIsland] Mengaktifkan Dynamic Island (iOS Precise Design)...');

        this._settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
        this._originalShowBanners = this._settings.get_boolean('show-banners');
        this._settings.set_boolean('show-banners', false);

        // ======== DIMENSI PRESISI ALA IPHONE ========
        this._idleWidth           = 124;
        this._collapsedHeight     = 35;
        this._compactMediaWidth   = 195;
        this._hudWidth            = 225;
        this._chargingWidth       = 235;

        // Expanded States (Squircle)
        this._notifWidth          = 370;
        this._notifHeight         = 68;  // Banner notifikasi kompak
        this._mediaExpandedWidth  = 385;
        this._mediaExpandedHeight = 168; // Player musik lega khas iOS

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

        // ================= 1. VOLUME & BRIGHTNESS HUD =================
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

        // ================= 3. COMPACT VIEW (MUSIC KECIL) =================
        this._compactBox = new St.BoxLayout({
            style_class: 'dynamic-island-compact',
            vertical: false,
            x_expand: true,
            y_expand: true,
            reactive: false,
            visible: false,
        });
        this._compactIcon = new St.Icon({
            icon_size: 19,
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

        // ================= 4. NOTIFICATION VIEW (KOMPAK SQUIRCLE) =================
        this._notifBox = new St.BoxLayout({
            style_class: 'dynamic-island-notif-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            visible: false,
            opacity: 0,
            reactive: true,
        });
        this._notifIcon = new St.Icon({
            icon_size: 38,
            icon_name: 'dialog-information-symbolic',
        });
        this._notifIconBin = new St.Bin({
            style_class: 'dynamic-island-notif-art',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: this._notifIcon,
        });
        this._notifTextBox = new St.BoxLayout({
            style_class: 'dynamic-island-notif-text-box',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._notifTitle = new St.Label({
            style_class: 'dynamic-island-notif-title',
            text: '',
        });
        this._notifBody = new St.Label({
            style_class: 'dynamic-island-notif-body',
            text: '',
        });
        this._notifTitle.clutter_text.ellipsize = 3;
        this._notifBody.clutter_text.ellipsize  = 3;
        this._notifTextBox.add_child(this._notifTitle);
        this._notifTextBox.add_child(this._notifBody);
        this._notifBox.add_child(this._notifIconBin);
        this._notifBox.add_child(this._notifTextBox);
        this._island.add_child(this._notifBox);

        // ================= 5. EXPANDED NOW PLAYING (PERSIS IPHONE) =================
        this._mediaContent = new St.BoxLayout({
            style_class: 'dynamic-island-media-content',
            vertical: true,
            opacity: 0,
            visible: false,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });

        // --- ROW 1: HEADER (Cover Art Besar + Teks + Mini Waveform) ---
        this._topRow = new St.BoxLayout({
            style_class: 'dynamic-island-media-top-row',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._mediaIcon = new St.Icon({
            icon_size: 52,
            icon_name: 'audio-x-generic-symbolic',
        });
        this._mediaArtBin = new St.Bin({
            style_class: 'dynamic-island-media-art',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: this._mediaIcon,
        });
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
        this._titleLabel.clutter_text.ellipsize = 3;
        this._bodyLabel.clutter_text.ellipsize  = 3;
        this._textInfo.add_child(this._titleLabel);
        this._textInfo.add_child(this._bodyLabel);

        // Equalizer mini di kanan atas
        this._headerWaveBars = [];
        this._headerWaveBox = new St.BoxLayout({
            style_class: 'dynamic-island-header-wave',
            vertical: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (let i = 0; i < 3; i++) {
            const bar = new St.Widget({
                style_class: 'dynamic-island-wave-bar',
                width: 3,
                height: 8,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._headerWaveBars.push(bar);
            this._headerWaveBox.add_child(bar);
        }

        this._topRow.add_child(this._mediaArtBin);
        this._topRow.add_child(this._textInfo);
        this._topRow.add_child(this._headerWaveBox);
        this._mediaContent.add_child(this._topRow);

        // --- ROW 2: PROGRESS BAR & DURASI WAKTU ---
        this._progressSection = new St.BoxLayout({
            style_class: 'dynamic-island-progress-section',
            vertical: true,
            x_expand: true,
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

        this._timeRow = new St.BoxLayout({
            style_class: 'dynamic-island-time-row',
            vertical: false,
            x_expand: true,
        });
        this._timeLabel = new St.Label({
            style_class: 'dynamic-island-time',
            text: '0:00',
        });
        this._durationLabel = new St.Label({
            style_class: 'dynamic-island-time',
            text: '0:00',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        this._timeRow.add_child(this._timeLabel);
        this._timeRow.add_child(this._durationLabel);

        this._progressSection.add_child(this._progressTrack);
        this._progressSection.add_child(this._timeRow);
        this._mediaContent.add_child(this._progressSection);

        // --- ROW 3: TOMBOL KONTROL DI TENGAH BAWAH (IPHONE STYLE) ---
        this._controlsRow = new St.BoxLayout({
            style_class: 'dynamic-island-controls-row',
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._prevBtn = new St.Button({
            style_class: 'dynamic-island-ctrl-btn',
            child: new St.Icon({ icon_name: 'media-skip-backward-symbolic', icon_size: 18 }),
            can_focus: true,
            reactive: true,
        });
        this._playBtn = new St.Button({
            style_class: 'dynamic-island-ctrl-btn dynamic-island-play-btn',
            child: new St.Icon({ icon_name: 'media-playback-start-symbolic', icon_size: 26 }),
            can_focus: true,
            reactive: true,
        });
        this._nextBtn = new St.Button({
            style_class: 'dynamic-island-ctrl-btn',
            child: new St.Icon({ icon_name: 'media-skip-forward-symbolic', icon_size: 18 }),
            can_focus: true,
            reactive: true,
        });
        this._controlsRow.add_child(this._prevBtn);
        this._controlsRow.add_child(this._playBtn);
        this._controlsRow.add_child(this._nextBtn);
        this._mediaContent.add_child(this._controlsRow);

        this._island.add_child(this._mediaContent);
        Main.uiGroup.add_child(this._island);
        this._reposition(this._idleWidth);

        // Seekbar Event
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

        // OSD Hook
        this._origOsdShow = Main.osdWindowManager.show.bind(Main.osdWindowManager);
        Main.osdWindowManager.show = (monitorIndex, icon, label, level, maxLevel) => {
            let iconName = '';
            if (icon) {
                if (typeof icon.get_names === 'function') iconName = icon.get_names()[0] || '';
                else if (icon.name) iconName = icon.name;
                else if (typeof icon.to_string === 'function') iconName = icon.to_string();
            }
            const isVolume = iconName.startsWith('audio-volume') || iconName.includes('speaker') || iconName.includes('headset');
            const isBrightness = iconName.startsWith('display-brightness');

            if (isVolume || isBrightness || (level !== null && level !== undefined)) {
                this._showOsdInIsland({ icon, iconName, label, level, maxLevel, isVolume, isBrightness });
                return;
            }
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
                if (hasContent && !this._isExpanded && !this._isProcessingQueue) {
                    this._expandMedia();
                }
            } else {
                if (this._isExpanded && !this._isDraggingSeek) {
                    this._unhoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
                        this._unhoverTimeoutId = null;
                        if (this._isProcessingQueue && this._waitingForMouseLeave) {
                            this._waitingForMouseLeave = false;
                            this._collapseAndNext();
                        } else if (!this._isProcessingQueue) {
                            this._collapse();
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }
        });

        // Test Shortcuts
        this._island.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === 3) {
                this._onBatteryEvent({ isCharging: true, percentage: 85 });
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
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

        // Animasi Equalizer
        this._wavePhase = 0;
        this._waveTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 170, () => {
            const playing = this._currentMedia?.status === 'Playing';
            if (this._mediaActive && playing && !this._isChargingBannerActive && !this._isHudActive) {
                const patterns = [8, 16, 22, 11, 19, 7];
                this._wavePhase = (this._wavePhase + 1) % patterns.length;

                // Animasi di mode collapsed
                if (!this._isExpanded) {
                    this._waveBars.forEach((bar, i) => {
                        bar.ease({
                            height: patterns[(this._wavePhase + i) % patterns.length],
                            duration: 150,
                            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                        });
                    });
                } else {
                    // Animasi di header player expanded
                    this._headerWaveBars.forEach((bar, i) => {
                        bar.ease({
                            height: Math.max(4, Math.floor(patterns[(this._wavePhase + i) % patterns.length] * 0.7)),
                            duration: 150,
                            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                        });
                    });
                }
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

    // ================= SQUIRCLE ANIMATION CONTROLLER =================
    _repositionAndResize(width, height, radiusClass, duration = 320, mode = Clutter.AnimationMode.EASE_OUT_BACK) {
        const targetX = this._monitor.x + Math.floor((this._monitor.width - width) / 2);

        // Atur styling radius squircle
        this._island.remove_style_class_name('is-expanded-media');
        this._island.remove_style_class_name('is-expanded-notif');
        if (radiusClass) {
            this._island.add_style_class_name(radiusClass);
        }

        this._island.ease({
            width,
            height,
            x: targetX,
            duration,
            mode,
        });
    }

    _getCurrentPillWidth() {
        if (this._isHudActive) return this._hudWidth;
        if (this._isChargingBannerActive) return this._chargingWidth;
        if (this._isExpanded) return this._isProcessingQueue ? this._notifWidth : this._mediaExpandedWidth;
        if (this._mediaActive) return this._compactMediaWidth;
        return this._idleWidth;
    }

    _reposition(width) {
        if (!this._island || !this._monitor) return;
        const x = this._monitor.x + Math.floor((this._monitor.width - width) / 2);
        this._island.set_position(x, this._monitor.y + 7);
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
        this._notifTitle.set_text(n.title || 'Notifikasi');
        this._notifBody.set_text(n.body || '');

        if (n.gicon)          this._setNotifIcon({ gicon: n.gicon });
        else if (n.icon_name) this._setNotifIcon({ iconName: n.icon_name });
        else                  this._setNotifIcon({ iconName: 'dialog-information-symbolic' });

        this._expandNotification();
    }

    _setNotifIcon({ gicon = null, iconName = null }) {
        this._notifIcon.gicon = null;
        this._notifIcon.icon_name = null;
        if (gicon) this._notifIcon.gicon = gicon;
        else if (iconName) this._notifIcon.icon_name = iconName;
        else this._notifIcon.icon_name = 'dialog-information-symbolic';
    }

    _expandNotification() {
        this._isExpanded = true;
        this._compactBox.visible = false;
        this._mediaContent.visible = false;
        this._notifBox.visible = true;

        this._repositionAndResize(this._notifWidth, this._notifHeight, 'is-expanded-notif', 320, Clutter.AnimationMode.EASE_OUT_BACK);

        this._notifBox.ease({
            opacity: 255,
            duration: 180,
            delay: 50,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        if (this._autoCollapseId) GLib.source_remove(this._autoCollapseId);
        this._autoCollapseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4200, () => {
            this._autoCollapseId = null;
            if (this._island.hover) this._waitingForMouseLeave = true;
            else                    this._collapseAndNext();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ================= MEDIA PLAYER =================
    _expandMedia() {
        if (this._isExpanded || !this._island) return;
        this._isExpanded = true;

        this._compactBox.visible = false;
        this._notifBox.visible = false;
        this._mediaContent.visible = true;

        this._repositionAndResize(this._mediaExpandedWidth, this._mediaExpandedHeight, 'is-expanded-media', 340, Clutter.AnimationMode.EASE_OUT_BACK);

        this._mediaContent.ease({
            opacity: 255,
            duration: 220,
            delay: 70,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._updateProgressUI();
    }

    _collapse() {
        if (!this._isExpanded && this._island.width === this._getCurrentPillWidth()) return;
        this._isExpanded = false;

        const targetWidth = this._mediaActive ? this._compactMediaWidth : this._idleWidth;

        this._mediaContent.ease({
            opacity: 0,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._mediaContent.visible = false;
                this._notifBox.visible = false;
                if (this._mediaActive && !this._isProcessingQueue && !this._isChargingBannerActive && !this._isHudActive) {
                    this._compactBox.visible = true;
                }
            },
        });

        this._repositionAndResize(targetWidth, this._collapsedHeight, null, 300, Clutter.AnimationMode.EASE_OUT_QUAD);
    }

    _collapseAndNext() {
        this._notifBox.ease({
            opacity: 0,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._notifBox.visible = false;
            },
        });

        this._isExpanded = false;
        const targetWidth = this._mediaActive ? this._compactMediaWidth : this._idleWidth;
        this._repositionAndResize(targetWidth, this._collapsedHeight, null, 300, Clutter.AnimationMode.EASE_OUT_QUAD);

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 320, () => {
            this._isProcessingQueue = false;
            this._waitingForMouseLeave = false;
            this._currentNotification = null;

            if (this._notificationQueue.length > 0) {
                this._processQueue();
            } else if (this._mediaActive) {
                this._compactBox.visible = true;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _onMediaUpdate(state) {
        this._currentMedia = state;

        if (!state || state.status === 'Stopped') {
            this._mediaActive = false;
            this._compactBox.visible = false;
            this._mediaContent.visible = false;

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
            this._repositionAndResize(this._compactMediaWidth, this._collapsedHeight, null);
        }

        if (this._isExpanded) {
            this._updateProgressUI();
        }
    }

    _loadCoverArt(url) {
        if (!url) {
            this._setMediaIcon({ iconName: 'audio-x-generic-symbolic' });
            return;
        }
        if (url.startsWith('file://')) {
            try {
                const path = Gio.File.new_for_uri(url).get_path();
                const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 128, 128, false);
                this._setMediaIcon({ pixbuf: pb });
            } catch (_) {
                this._setMediaIcon({ iconName: 'audio-x-generic-symbolic' });
            }
            return;
        }

        if (this._coverCache.has(url)) {
            this._setMediaIcon({ pixbuf: this._coverCache.get(url) });
            return;
        }

        this._setMediaIcon({ iconName: 'audio-x-generic-symbolic' });
        const file = Gio.File.new_for_uri(url);
        file.load_contents_async(null, (f, res) => {
            try {
                const [, contents] = f.load_contents_finish(res);
                const stream = Gio.MemoryInputStream.new_from_bytes(contents);
                const pb = GdkPixbuf.Pixbuf.new_from_stream_at_scale(stream, 128, 128, false, null);
                this._coverCache.set(url, pb);
                if (this._currentMedia?.artUrl === url) {
                    this._setMediaIcon({ pixbuf: pb });
                }
            } catch (_) {}
        });
    }

    _setMediaIcon({ iconName = null, pixbuf = null }) {
        this._mediaIcon.gicon = null;
        this._compactIcon.gicon = null;
        if (pixbuf) {
            try {
                const [ok, buffer] = pixbuf.save_to_bufferv('png', [], []);
                if (ok) {
                    const bytesIcon = Gio.BytesIcon.new(GLib.Bytes.new(buffer));
                    this._mediaIcon.gicon = bytesIcon;
                    this._compactIcon.gicon = bytesIcon;
                    return;
                }
            } catch (_) {}
        }
        this._mediaIcon.icon_name = iconName || 'audio-x-generic-symbolic';
        this._compactIcon.icon_name = iconName || 'audio-x-generic-symbolic';
    }

    // ================= SEEKBAR & DURASI =================
    _formatTime(micros) {
        const sec = Math.max(0, Math.floor(micros / 1_000_000));
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    _updateProgressUI() {
        if (!this._currentMedia) return;
        const duration = this._currentMedia.length || 0;
        if (duration <= 0) return;

        const pos = this._media?.getPosition() ?? 0;
        const ratio = Math.max(0, Math.min(1, pos / duration));
        const trackW = this._progressTrack.width || 330;
        const fillW = Math.floor(trackW * ratio);

        this._progressFill.width = Math.max(0, fillW);
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
        this._timeLabel.set_text(this._formatTime(target));
        this._media?.seek(target);
    }

    // ================= HUD & CHARGING =================
    _showOsdInIsland({ icon, iconName, level, maxLevel, isVolume }) {
        if (this._hudDismissId) GLib.source_remove(this._hudDismissId);

        this._isHudActive = true;
        let ratio = 0;
        if (level !== null && level !== undefined) {
            const max = (maxLevel && maxLevel > 0) ? maxLevel : 1;
            ratio = Math.max(0, Math.min(1, level / max));
        }

        const isMuted = iconName.includes('muted') || (isVolume && ratio === 0);
        if (icon) this._hudIcon.gicon = icon;
        else if (iconName) this._hudIcon.icon_name = iconName;
        else this._hudIcon.icon_name = isVolume ? 'audio-volume-high-symbolic' : 'display-brightness-symbolic';

        if (isMuted) this._hudIcon.add_style_class_name('dynamic-island-hud-icon-muted');
        else this._hudIcon.remove_style_class_name('dynamic-island-hud-icon-muted');

        const trackW = 140;
        this._hudSliderFill.width = isMuted ? 0 : Math.round(trackW * ratio);

        this._compactBox.visible = false;
        this._mediaContent.visible = false;
        this._notifBox.visible = false;
        this._chargingBox.visible = false;
        this._hudBox.visible = true;

        this._repositionAndResize(this._hudWidth, this._collapsedHeight, null, 280, Clutter.AnimationMode.EASE_OUT_BACK);
        this._hudBox.ease({ opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD });

        this._hudDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => {
            this._hudDismissId = null;
            this._hudBox.ease({
                opacity: 0,
                duration: 140,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    this._hudBox.visible = false;
                    this._isHudActive = false;
                    const targetWidth = this._mediaActive ? this._compactMediaWidth : this._idleWidth;
                    if (this._mediaActive) this._compactBox.visible = true;
                    this._repositionAndResize(targetWidth, this._collapsedHeight, null, 280, Clutter.AnimationMode.EASE_OUT_QUAD);
                },
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _onBatteryEvent({ isCharging, percentage }) {
        if (!isCharging) return;
        if (this._chargingDismissId) GLib.source_remove(this._chargingDismissId);

        this._isChargingBannerActive = true;
        this._chargingLabel.set_text('Charging');
        this._chargingPercentLabel.set_text(`${percentage}%`);
        this._batteryFill.width = Math.max(2, Math.floor((percentage / 100) * 20));

        this._compactBox.visible = false;
        this._mediaContent.visible = false;
        this._notifBox.visible = false;
        this._hudBox.visible = false;
        this._chargingBox.visible = true;

        this._repositionAndResize(this._chargingWidth, this._collapsedHeight, null, 340, Clutter.AnimationMode.EASE_OUT_BACK);
        this._chargingBox.ease({ opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });

        this._chargingDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._chargingDismissId = null;
            this._chargingBox.ease({
                opacity: 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    this._chargingBox.visible = false;
                    this._isChargingBannerActive = false;
                    const targetWidth = this._mediaActive ? this._compactMediaWidth : this._idleWidth;
                    if (this._mediaActive) this._compactBox.visible = true;
                    this._repositionAndResize(targetWidth, this._collapsedHeight, null, 300, Clutter.AnimationMode.EASE_OUT_QUAD);
                },
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._origOsdShow) {
            Main.osdWindowManager.show = this._origOsdShow;
            this._origOsdShow = null;
        }
        if (this._settings) {
            this._settings.set_boolean('show-banners', this._originalShowBanners);
            this._settings = null;
        }
        if (this._monitorsChangedId) Main.layoutManager.disconnect(this._monitorsChangedId);
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

        if (this._battery) this._battery.destroy();
        if (this._media) this._media.destroy();
        if (this._island) this._island.destroy();
    }
}