import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { MediaWatcher } from './mpris.js';
import { BatteryWatcher } from './battery.js';
import { BluetoothWatcher } from './bluetooth.js';
import { PrivacyWatcher } from './privacy.js';
import { ScreenRecordWatcher } from './recorder.js';
import { ControlCenterManager } from './controlCenter.js';

export default class DynamicIslandExtension extends Extension {
    enable() {
        console.log('[DynamicIsland] Mengaktifkan VisionOS Glass Control Center...');

        this._settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
        this._originalShowBanners = this._settings.get_boolean('show-banners');
        this._settings.set_boolean('show-banners', false);

        if (Main.messageTray._bannerBin) {
            Main.messageTray._bannerBin.hide();
        }

        // ======== DIMENSI ========
        this._idleWidth           = 175;
        this._collapsedHeight     = 35;
        this._compactMediaWidth   = 195;
        this._compactRecordWidth  = 185;
        this._hudWidth            = 225;
        this._chargingWidth       = 235;
        this._bluetoothWidth      = 260;

        this._notifWidth          = 370;
        this._notifHeight         = 68;
        this._mediaExpandedWidth  = 390; 
        this._mediaExpandedHeight = 168;
        this._recordExpandedHeight= 96;
        this._countdownWidth      = this._idleWidth;
        
        // Dimensi Khusus Glass Control Center ala VisionOS
        this._ccExpandedWidth     = 430;
        this._ccExpandedHeight    = 370; // <-- Diperpanjang agar tidak mepet bawah

        // ======== STATE ========
        this._isExpanded = false;
        this._isControlCenterOpen = false;
        this._isChargingBannerActive = false;
        this._isHudActive = false;
        this._isBtBannerActive = false;
        this._isCountingDown = false;
        this._countdownNumber = 3;
        this._chargingDismissId = null;
        this._hudDismissId = null;
        this._btDismissId = null;
        this._countdownTickId = null;
        this._clockTickId = null;
        this._notificationQueue = [];
        this._isProcessingQueue = false;
        this._currentNotification = null;
        this._waitingForMouseLeave = false;
        this._autoCollapseId = null;
        this._unhoverTimeoutId = null;
        this._recordPulseId = null;
        this._currentMedia = null;
        this._mediaActive = false;
        this._pauseTimeoutId = null;
        this._isDraggingSeek = false;
        this._coverCache = new Map();

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
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // ================= PRIVACY INDICATOR DOTS =================
        this._privacyBox = new St.BoxLayout({
            style_class: 'dynamic-island-privacy-box',
            vertical: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._cameraDot = new St.Widget({
            style_class: 'dynamic-island-privacy-dot dot-camera',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._micDot = new St.Widget({
            style_class: 'dynamic-island-privacy-dot dot-mic',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._privacyBox.add_child(this._cameraDot);
        this._privacyBox.add_child(this._micDot);

        // ================= 0. JAM DIGITAL IDLE =================
        this._idleClockLabel = new St.Label({
            style_class: 'dynamic-island-idle-clock',
            text: this._getFormattedTime(),
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._idleClockLabel.clutter_text.ellipsize = 0;

        this._idleLeftSpacer = new St.Widget({
            style_class: 'dynamic-island-idle-spacer',
        });

        this._idleBox = new St.BoxLayout({
            style_class: 'dynamic-island-idle-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            visible: true,
            opacity: 255,
        });
        this._idleBox.add_child(this._idleLeftSpacer);
        this._idleBox.add_child(new St.Bin({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: this._idleClockLabel,
        }));
        this._idleBox.add_child(this._privacyBox);
        this._island.add_child(this._idleBox);

        // ================= COUNTDOWN SCREEN RECORDING =================
        this._countdownBox = new St.Bin({
            style_class: 'dynamic-island-countdown-box',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
            opacity: 0,
        });
        this._countdownLabel = new St.Label({
            style_class: 'dynamic-island-countdown-label',
            text: '3',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._countdownLabel.clutter_text.ellipsize = 0;
        this._countdownBox.set_child(this._countdownLabel);
        this._island.add_child(this._countdownBox);

        // ================= COMPACT RECORDING VIEW =================
        this._compactRecordBox = new St.BoxLayout({
            style_class: 'dynamic-island-compact-record',
            vertical: false,
            x_expand: true,
            y_expand: true,
            reactive: false,
            visible: false,
        });
        this._recordDot = new St.Widget({
            style_class: 'dynamic-island-record-dot pulse',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._compactRecordLabel = new St.Label({
            style_class: 'dynamic-island-compact-record-label',
            text: '00:00',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        this._compactRecordLabel.clutter_text.ellipsize = 0;
        this._compactRecordLabel.clutter_text.single_line_mode = true;
        this._compactRecordBox.add_child(this._recordDot);
        this._compactRecordBox.add_child(this._compactRecordLabel);
        this._island.add_child(this._compactRecordBox);

        // ================= BLUETOOTH VIEW =================
        this._bluetoothBox = new St.BoxLayout({
            style_class: 'dynamic-island-bt-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            reactive: false,
            visible: false,
            opacity: 0,
        });
        this._btIcon = new St.Icon({
            icon_size: 16,
            icon_name: 'audio-headphones-symbolic',
            style_class: 'dynamic-island-bt-icon',
        });
        this._btIconBin = new St.Bin({
            style_class: 'dynamic-island-bt-icon-bin',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: this._btIcon,
        });
        this._btNameLabel = new St.Label({
            style_class: 'dynamic-island-bt-name',
            text: 'Bluetooth Device',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._btNameLabel.clutter_text.ellipsize = 3;

        this._btRightBox = new St.BoxLayout({
            style_class: 'dynamic-island-bt-right',
            vertical: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._btPercentLabel = new St.Label({
            style_class: 'dynamic-island-bt-percent',
            text: '100%',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._btBatteryShell = new St.Widget({
            style_class: 'dynamic-island-battery-shell',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._btBatteryFill = new St.Widget({
            style_class: 'dynamic-island-battery-fill',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._btBatteryCap = new St.Widget({
            style_class: 'dynamic-island-battery-cap',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._btBatteryShell.add_child(this._btBatteryFill);

        this._btStatusLabel = new St.Label({
            style_class: 'dynamic-island-bt-status',
            text: 'Connected',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._btRightBox.add_child(this._btStatusLabel);
        this._btRightBox.add_child(this._btPercentLabel);
        this._btRightBox.add_child(this._btBatteryShell);
        this._btRightBox.add_child(this._btBatteryCap);
        this._bluetoothBox.add_child(this._btIconBin);
        this._bluetoothBox.add_child(this._btNameLabel);
        this._bluetoothBox.add_child(this._btRightBox);
        this._island.add_child(this._bluetoothBox);

        // ================= VOLUME & BRIGHTNESS HUD =================
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

        // ================= CHARGING VIEW =================
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

        // ================= COMPACT VIEW (COLLAPSED MUSIC) =================
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

        // ================= NOTIFICATION VIEW =================
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

        // ================= EXPANDED MEDIA VIEW =================
        this._mediaContent = new St.BoxLayout({
            style_class: 'dynamic-island-media-content',
            vertical: true,
            opacity: 0,
            visible: false,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });

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

        // ================= EXPANDED SCREEN RECORDING =================
        this._recordExpandedBox = new St.BoxLayout({
            style_class: 'dynamic-island-record-expanded',
            vertical: false,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
            opacity: 0,
            reactive: true,
        });
        this._recordTextCol = new St.BoxLayout({
            style_class: 'dynamic-island-record-text-col',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._recordSubLabelRow = new St.BoxLayout({
            style_class: 'dynamic-island-record-sub-label-row',
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._recordExpandedDot = new St.Widget({
            style_class: 'dynamic-island-record-dot dynamic-island-record-dot-mini',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._recordSubLabel = new St.Label({
            style_class: 'dynamic-island-record-sub-label',
            text: 'RECORDING',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._recordSubLabelRow.add_child(this._recordExpandedDot);
        this._recordSubLabelRow.add_child(this._recordSubLabel);

        this._recordBigLabel = new St.Label({
            style_class: 'dynamic-island-record-big-label',
            text: '00:00',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._recordBigLabel.clutter_text.ellipsize = 0;
        this._recordBigLabel.clutter_text.single_line_mode = true;
        this._recordTextCol.add_child(this._recordSubLabelRow);
        this._recordTextCol.add_child(this._recordBigLabel);

        this._recordStopBtn = new St.Button({
            style_class: 'dynamic-island-record-stop-btn',
            child: new St.Icon({ icon_name: 'media-playback-stop-symbolic', icon_size: 15 }),
            can_focus: true,
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._recordExpandedBox.add_child(this._recordTextCol);
        this._recordExpandedBox.add_child(this._recordStopBtn);
        this._island.add_child(this._recordExpandedBox);

        // =========================================================================
        // REDESAIN: CONTROL CENTER VISIONOS GLASS STYLE
        // =========================================================================
        this._controlCenterBox = new St.BoxLayout({
            style_class: 'dynamic-island-cc-box',
            vertical: true,
            x_expand: true,
            y_expand: true,
            visible: false,
            opacity: 0,
            reactive: true,
        });

        // 1. Header: Tombol Close [X] di kiri & Judul Tengah
        this._ccHeaderRow = new St.BoxLayout({
            style_class: 'dynamic-island-cc-header',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._ccBtnClose = new St.Button({
            style_class: 'dynamic-island-cc-close',
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 13 }),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._ccBtnClose.connect('clicked', () => this._collapse());

        this._ccTitle = new St.Label({
            style_class: 'dynamic-island-cc-title',
            text: 'Control Center',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        
        // Spacer kanan penyeimbang agar judul persis di tengah
        const ccHeaderRightSpacer = new St.Widget({ width: 34, height: 34 });

        this._ccHeaderRow.add_child(this._ccBtnClose);
        this._ccHeaderRow.add_child(this._ccTitle);
        this._ccHeaderRow.add_child(ccHeaderRightSpacer);
        this._controlCenterBox.add_child(this._ccHeaderRow);

        // 2. Baris Atas: Cluster 2x2 Lingkaran & Kartu Now Playing
        this._ccTopRow = new St.BoxLayout({
            style_class: 'dynamic-island-cc-top-row',
            vertical: false,
            x_expand: true,
        });

        // 2A. Cluster 2x2 Tombol Lingkaran
        this._ccClusterLayout = new Clutter.GridLayout({
            column_spacing: 8,
            row_spacing: 8,
            column_homogeneous: true,
            row_homogeneous: true,
        });
        this._ccCluster = new St.Widget({
            style_class: 'dynamic-island-cc-cluster',
            layout_manager: this._ccClusterLayout,
            y_align: Clutter.ActorAlign.FILL,
        });

        // Tombol Wi-Fi
        this._ccBtnWifi = new St.Button({
            style_class: 'dynamic-island-cc-circle-btn',
            child: new St.Icon({ icon_name: 'network-wireless-signal-excellent-symbolic', icon_size: 20 }),
            can_focus: true,
        });
        this._ccBtnWifi.connect('clicked', () => {
            this._cc.toggleWifi();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                this._syncControlCenterUI();
                return GLib.SOURCE_REMOVE;
            });
        });

        // Tombol Bluetooth
        this._ccBtnBt = new St.Button({
            style_class: 'dynamic-island-cc-circle-btn',
            child: new St.Icon({ icon_name: 'bluetooth-active-symbolic', icon_size: 20 }),
            can_focus: true,
        });
        this._ccBtnBt.connect('clicked', () => {
            this._cc.toggleBluetooth();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                this._syncControlCenterUI();
                return GLib.SOURCE_REMOVE;
            });
        });

        // Tombol Mode Daya / Performa
        this._ccBtnPower = new St.Button({
            style_class: 'dynamic-island-cc-circle-btn',
            child: new St.Icon({ icon_name: 'power-profile-balanced-symbolic', icon_size: 20 }),
            can_focus: true,
        });
        this._ccBtnPower.connect('clicked', () => {
            this._cc.togglePowerMode();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._syncControlCenterUI();
                return GLib.SOURCE_REMOVE;
            });
        });

        // Tombol Airplane Mode
        this._ccBtnAirplane = new St.Button({
            style_class: 'dynamic-island-cc-circle-btn',
            child: new St.Icon({ icon_name: 'airplane-mode-symbolic', icon_size: 20 }),
            can_focus: true,
        });
        this._ccBtnAirplane.connect('clicked', () => {
            this._cc.toggleAirplaneMode();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                this._syncControlCenterUI();
                return GLib.SOURCE_REMOVE;
            });
        });

        this._ccClusterLayout.attach(this._ccBtnWifi,     0, 0, 1, 1);
        this._ccClusterLayout.attach(this._ccBtnBt,       1, 0, 1, 1);
        this._ccClusterLayout.attach(this._ccBtnPower,    0, 1, 1, 1);
        this._ccClusterLayout.attach(this._ccBtnAirplane, 1, 1, 1, 1);
        this._ccTopRow.add_child(this._ccCluster);

        // 2B. Kartu Now Playing Kanan
        this._ccMediaBox = new St.BoxLayout({
            style_class: 'dynamic-island-cc-media',
            vertical: true,
            x_expand: true,
        });

        this._ccMediaTopRow = new St.BoxLayout({
            style_class: 'dynamic-island-cc-media-row',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._ccMediaArt = new St.Icon({
            icon_size: 48,
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'dynamic-island-cc-media-art',
        });
        this._ccMediaInfo = new St.BoxLayout({
            style_class: 'dynamic-island-cc-media-info',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._ccMediaTitle = new St.Label({
            style_class: 'dynamic-island-cc-media-title',
            text: 'Tidak Ada Media',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._ccMediaTitle.clutter_text.ellipsize = 3;

        this._ccMediaArtist = new St.Label({
            style_class: 'dynamic-island-cc-media-artist',
            text: 'Siap memutar musik',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._ccMediaArtist.clutter_text.ellipsize = 3;
        this._ccMediaInfo.add_child(this._ccMediaTitle);
        this._ccMediaInfo.add_child(this._ccMediaArtist);

        this._ccPlayBtn = new St.Button({
            style_class: 'dynamic-island-cc-play-btn',
            child: new St.Icon({ icon_name: 'media-playback-start-symbolic', icon_size: 16 }),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._ccPlayBtn.connect('clicked', () => this._media?.togglePlayPause());

        this._ccMediaTopRow.add_child(this._ccMediaArt);
        this._ccMediaTopRow.add_child(this._ccMediaInfo);
        this._ccMediaTopRow.add_child(this._ccPlayBtn);

        // Kapsul Tebal Scrubber / Progress Bar
        this._ccScrubTrack = new St.Widget({
            style_class: 'dynamic-island-cc-scrub',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        this._ccScrubFill = new St.Widget({
            style_class: 'dynamic-island-cc-scrub-fill',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.FILL,
            width: 80,
        });
        this._ccScrubTrack.add_child(this._ccScrubFill);

        // Klik Scrubber untuk seek lagu
        this._ccScrubTrack.connect('button-press-event', (_a, event) => {
            if (!this._currentMedia?.canSeek) return Clutter.EVENT_STOP;
            const duration = this._currentMedia?.length || 0;
            if (duration <= 0) return Clutter.EVENT_STOP;

            const coords = event.get_coords();
            const x = coords[0] !== undefined ? coords[0] : 0;
            const [trackX] = this._ccScrubTrack.get_transformed_position();
            const trackW = this._ccScrubTrack.width || 1;
            const ratio = Math.max(0, Math.min(1, (x - trackX) / trackW));
            const target = ratio * duration;

            this._ccScrubFill.width = Math.floor(trackW * ratio);
            this._media?.seek(target);
            return Clutter.EVENT_STOP;
        });

        this._ccMediaBox.add_child(this._ccMediaTopRow);
        this._ccMediaBox.add_child(this._ccScrubTrack);
        this._ccTopRow.add_child(this._ccMediaBox);
        this._controlCenterBox.add_child(this._ccTopRow);

        // 3. Grid Tombol Kotak Bawah (Ubin 20px Radius)
        this._ccBottomGrid = new Clutter.GridLayout({
            column_spacing: 10,
            row_spacing: 10,
            column_homogeneous: true,
            row_homogeneous: true,
        });
        this._ccGridContainer = new St.Widget({
            layout_manager: this._ccBottomGrid,
            x_expand: true,
        });

        // Helper pembuat tombol kotak
        const makeSqBtn = (iconName, onClick) => {
            const btn = new St.Button({
                style_class: 'dynamic-island-cc-sq-btn',
                child: new St.Icon({ icon_name: iconName, icon_size: 20 }),
                can_focus: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (onClick) btn.connect('clicked', onClick);
            return btn;
        };

        // Baris 1 Ubin (6 Ikon)
        this._sqBtnNight = makeSqBtn('night-light-symbolic', () => {
            this._cc.toggleNightLight();
            this._syncControlCenterUI();
        });
        this._sqBtnDark = makeSqBtn('weather-clear-night-symbolic', () => {
            this._cc.toggleDarkMode();
            this._syncControlCenterUI();
        });
        this._sqBtnRecord = makeSqBtn('media-record-symbolic', () => {
            this._collapse();
            this._cc.openScreenshot(); // Mode rekam / screenshot bawaan GNOME
        });
        this._sqBtnScreenshot = makeSqBtn('camera-photo-symbolic', () => {
            this._collapse();
            this._cc.openScreenshot();
        });
        this._sqBtnLock = makeSqBtn('system-lock-screen-symbolic', () => {
            this._collapse();
            this._cc.lockScreen();
        });
        this._sqBtnSearch = makeSqBtn('system-search-symbolic', () => {
            this._collapse();
            Main.overview.show();
        });

        // Baris 2 Ubin (Aksi Sistem)
        this._sqBtnSettings = makeSqBtn('preferences-system-symbolic', () => {
            this._collapse();
            this._cc.openSettings();
        });
        this._sqBtnShutdown = makeSqBtn('system-shutdown-symbolic', () => {
            this._collapse();
            this._cc.openPowerMenu();
        });

        // Pasang ke Clutter Grid (Kolom, Baris, SpanKolom, SpanBaris)
        this._ccBottomGrid.attach(this._sqBtnNight,      0, 0, 1, 1);
        this._ccBottomGrid.attach(this._sqBtnDark,       1, 0, 1, 1);
        this._ccBottomGrid.attach(this._sqBtnRecord,     2, 0, 1, 1);
        this._ccBottomGrid.attach(this._sqBtnScreenshot, 3, 0, 1, 1);
        this._ccBottomGrid.attach(this._sqBtnLock,       4, 0, 1, 1);
        this._ccBottomGrid.attach(this._sqBtnSearch,     5, 0, 1, 1);

        this._ccBottomGrid.attach(this._sqBtnSettings,   0, 1, 1, 1);
        this._ccBottomGrid.attach(this._sqBtnShutdown,   1, 1, 1, 1);

        this._controlCenterBox.add_child(this._ccGridContainer);
        this._island.add_child(this._controlCenterBox);

        Main.uiGroup.add_child(this._island);
        this._reposition(this._idleWidth);

        this._cc = new ControlCenterManager(() => this._syncControlCenterUI());

        // Update Jam Standby
        this._updateClock();
        this._clockTickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });

        // Watcher Screen Recording
        this._recorder = new ScreenRecordWatcher({
            onRecordingStarted: () => this._onRecordingStarted(),
            onRecordingStopped: () => this._onRecordingStopped(),
            onTick: data => this._onRecordingTick(data),
        });
        this._recordStopBtn.connect('clicked', () => this._recorder.stopRecordingSession());

        // Progress Track Seekbar (Media View Utama)
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

        // ================= KLIK KANAN: BUKA CONTROL CENTER KAPAN SAJA =================
        this._island.connect('button-press-event', (_actor, event) => {
            const button = event.get_button();
            if (button === 3) { // Klik Kanan Mouse
                if (this._isControlCenterOpen) {
                    this._collapse();
                } else {
                    this._expandControlCenter();
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Hover Handler
        this._island.connect('notify::hover', () => {
            if (this._isChargingBannerActive || this._isHudActive || this._isBtBannerActive || this._isCountingDown) return;
            const hovering = this._island.hover;

            if (hovering) {
                if (this._unhoverTimeoutId) {
                    GLib.source_remove(this._unhoverTimeoutId);
                    this._unhoverTimeoutId = null;
                }
                if (this._isControlCenterOpen) return;

                if (!this._isExpanded && !this._isProcessingQueue) {
                    if (this._recorder?.isRecording) {
                        this._expandRecord();
                    } else if (this._mediaActive) {
                        this._expandMedia();
                    } else {
                        this._expandControlCenter();
                    }
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

        this._prevBtn.connect('clicked', () => this._media?.previous());
        this._playBtn.connect('clicked', () => this._media?.togglePlayPause());
        this._nextBtn.connect('clicked', () => this._media?.next());

        // Notifikasi GNOME
        this._sourceConnections = new Map();
        Main.messageTray.getSources().forEach(s => this._connectSource(s));
        this._sourceAddedId = Main.messageTray.connect('source-added', (_t, s) => this._connectSource(s));
        this._sourceRemovedId = Main.messageTray.connect('source-removed', (_t, s) => this._disconnectSource(s));

        // Subsystems
        this._media = new MediaWatcher(state => this._onMediaUpdate(state));
        this._battery = new BatteryWatcher(event => this._onBatteryEvent(event));
        this._bluetooth = new BluetoothWatcher(event => this._onBluetoothConnected(event));
        this._privacy = new PrivacyWatcher(state => this._onPrivacyState(state));

        // Animasi Gelombang Suara (Wave)
        this._wavePhase = 0;
        this._waveTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 170, () => {
            const playing = this._currentMedia?.status === 'Playing';
            if (this._mediaActive && playing && !this._isChargingBannerActive && !this._isHudActive && !this._isBtBannerActive && !this._recorder?.isRecording && !this._isControlCenterOpen) {
                const patterns = [8, 16, 22, 11, 19, 7];
                this._wavePhase = (this._wavePhase + 1) % patterns.length;

                if (!this._isExpanded) {
                    this._waveBars.forEach((bar, i) => {
                        bar.ease({
                            height: patterns[(this._wavePhase + i) % patterns.length],
                            duration: 150,
                            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                        });
                    });
                } else {
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

        // Progress Bar Media Tick
        this._progressTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (this._mediaActive && this._currentMedia?.status === 'Playing' && this._isExpanded && !this._isDraggingSeek) {
                this._updateProgressUI();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ================= CONTROL CENTER CONTROLLER =================
    _expandControlCenter() {
        if (!this._island) return;
        this._isExpanded = true;
        this._isControlCenterOpen = true;

        // MENAMBAHKAN KELAS KHUSUS AGAR BACKGROUND PILL MENJADI KACA
        this._island.add_style_class_name('dynamic-island-cc-expanded');

        this._idleBox.visible = false;
        this._compactBox.visible = false;
        this._compactRecordBox.visible = false;
        this._mediaContent.visible = false;
        this._mediaContent.opacity = 0;
        this._recordExpandedBox.visible = false;
        this._recordExpandedBox.opacity = 0;
        this._notifBox.visible = false;
        this._controlCenterBox.visible = true;

        this._syncControlCenterUI();

        this._repositionAndResize(this._ccExpandedWidth, this._ccExpandedHeight, 320, Clutter.AnimationMode.EASE_OUT_BACK);
        this._controlCenterBox.ease({
            opacity: 255,
            duration: 200,
            delay: 40,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _syncControlCenterUI() {
        if (!this._cc) return;

        // Dark Mode
        if (this._cc.isDarkMode()) this._sqBtnDark.add_style_class_name('on');
        else this._sqBtnDark.remove_style_class_name('on');

        // Night Light
        if (this._cc.isNightLight()) this._sqBtnNight.add_style_class_name('on');
        else this._sqBtnNight.remove_style_class_name('on');

        // Wi-Fi
        if (this._cc.isWifiEnabled()) this._ccBtnWifi.add_style_class_name('on');
        else this._ccBtnWifi.remove_style_class_name('on');

        // Bluetooth
        if (this._cc.isBluetoothEnabled()) this._ccBtnBt.add_style_class_name('on');
        else this._ccBtnBt.remove_style_class_name('on');

        // Airplane Mode
        if (this._cc.isAirplaneMode()) this._ccBtnAirplane.add_style_class_name('on');
        else this._ccBtnAirplane.remove_style_class_name('on');

        // Power Mode
        const pMode = this._cc.getPowerProfile();
        if (pMode === 'Performance' || pMode === 'Power Saver') {
            this._ccBtnPower.add_style_class_name('on');
        } else {
            this._ccBtnPower.remove_style_class_name('on');
        }

        // Sinkronisasi Now Playing di dalam Control Center
        if (this._currentMedia && this._currentMedia.status !== 'Stopped') {
            this._ccMediaTitle.set_text(this._currentMedia.title || 'Sedang Diputar');
            this._ccMediaArtist.set_text(this._currentMedia.artist || 'Tidak Diketahui');
            this._ccPlayBtn.child.icon_name = (this._currentMedia.status === 'Playing')
                ? 'media-playback-pause-symbolic'
                : 'media-playback-start-symbolic';

            const duration = this._currentMedia.length || 0;
            if (duration > 0) {
                const pos = this._media?.getPosition() ?? 0;
                const ratio = Math.max(0, Math.min(1, pos / duration));
                const trackW = this._ccScrubTrack.width || 210;
                this._ccScrubFill.width = Math.max(16, Math.floor(trackW * ratio));
            }
        } else {
            this._ccMediaTitle.set_text('Tidak Ada Media');
            this._ccMediaArtist.set_text('Siap memutar musik');
            this._ccPlayBtn.child.icon_name = 'media-playback-start-symbolic';
            this._ccScrubFill.width = 40;
        }
    }

    // ================= SCREEN RECORDING =================
    _onRecordingStarted() {
        this._isCountingDown = true;
        this._countdownNumber = 3;

        this._idleBox.visible = false;
        this._compactBox.visible = false;
        this._compactRecordBox.visible = false;
        this._mediaContent.visible = false;
        this._recordExpandedBox.visible = false;
        this._controlCenterBox.visible = false;
        this._countdownBox.visible = true;

        this._countdownLabel.set_text('3');
        this._repositionAndResize(this._countdownWidth, this._collapsedHeight, 280, Clutter.AnimationMode.EASE_OUT_BACK);
        this._countdownBox.ease({ opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });

        this._countdownTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
            this._countdownNumber--;
            if (this._countdownNumber > 0) {
                this._countdownLabel.set_text(String(this._countdownNumber));
                return GLib.SOURCE_CONTINUE;
            } else {
                this._isCountingDown = false;
                this._countdownBox.visible = false;
                this._compactRecordBox.visible = true;
                this._repositionAndResize(this._compactRecordWidth, this._collapsedHeight, 280, Clutter.AnimationMode.EASE_OUT_QUAD);
                this._startRecordPulse();
                return GLib.SOURCE_REMOVE;
            }
        });
    }

    _onRecordingTick({ formatted }) {
        this._compactRecordLabel.set_text(formatted);
        this._recordBigLabel.set_text(formatted);
    }

    _onRecordingStopped() {
        if (this._countdownTickId) {
            GLib.source_remove(this._countdownTickId);
            this._countdownTickId = null;
        }
        this._isCountingDown = false;
        this._compactRecordBox.visible = false;
        this._recordExpandedBox.visible = false;
        this._stopRecordPulse();
        this._collapse();
    }

    _startRecordPulse() {
        this._stopRecordPulse();
        let dim = false;
        this._recordPulseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            dim = !dim;
            const targetOpacity = dim ? 90 : 255;
            this._recordDot?.ease({ opacity: targetOpacity, duration: 550, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE });
            this._recordExpandedDot?.ease({ opacity: targetOpacity, duration: 550, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE });
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopRecordPulse() {
        if (this._recordPulseId) {
            GLib.source_remove(this._recordPulseId);
            this._recordPulseId = null;
        }
        this._recordDot?.ease({ opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        this._recordExpandedDot?.ease({ opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    _expandRecord() {
        if (this._isExpanded || !this._island) return;
        this._isExpanded = true;

        this._idleBox.visible = false;
        this._compactBox.visible = false;
        this._compactRecordBox.visible = false;
        this._mediaContent.visible = false;
        this._controlCenterBox.visible = false;
        this._recordExpandedBox.visible = true;

        this._repositionAndResize(this._mediaExpandedWidth, this._recordExpandedHeight, 320, Clutter.AnimationMode.EASE_OUT_BACK);
        this._recordExpandedBox.ease({ opacity: 255, duration: 190, delay: 40, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    _onPrivacyState({ camera, mic }) {
        this._cameraDot.visible = camera;
        this._micDot.visible = mic;
        this._privacyBox.visible = (camera || mic);
        this._idleLeftSpacer.visible = (camera || mic);
    }

    _getFormattedTime() {
        return GLib.DateTime.new_now_local().format('%H:%M');
    }

    _updateClock() {
        if (this._idleClockLabel) {
            this._idleClockLabel.set_text(this._getFormattedTime());
        }
    }

    _onBluetoothConnected({ name, icon, battery }) {
        if (this._btDismissId) {
            GLib.source_remove(this._btDismissId);
            this._btDismissId = null;
        }

        this._isBtBannerActive = true;
        this._btNameLabel.set_text(name || 'Bluetooth Device');
        this._btIcon.icon_name = icon || 'audio-headphones-symbolic';

        if (battery !== null && battery !== undefined && battery >= 0) {
            this._btStatusLabel.visible = false;
            this._btPercentLabel.set_text(`${battery}%`);
            this._btPercentLabel.visible = true;

            const fillWidth = Math.max(2, Math.floor((battery / 100) * 20));
            this._btBatteryFill.width = fillWidth;
            this._btBatteryShell.visible = true;
            this._btBatteryCap.visible = true;
        } else {
            this._btPercentLabel.visible = false;
            this._btBatteryShell.visible = false;
            this._btBatteryCap.visible = false;
            this._btStatusLabel.visible = true;
        }

        this._idleBox.visible = false;
        this._compactBox.visible = false;
        this._compactRecordBox.visible = false;
        this._mediaContent.visible = false;
        this._chargingBox.visible = false;
        this._hudBox.visible = false;
        this._notifBox.visible = false;
        this._recordExpandedBox.visible = false;
        this._controlCenterBox.visible = false;
        this._bluetoothBox.visible = true;

        this._repositionAndResize(this._bluetoothWidth, this._collapsedHeight, 320, Clutter.AnimationMode.EASE_OUT_BACK);
        this._bluetoothBox.ease({ opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });

        this._btDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2800, () => {
            this._btDismissId = null;
            this._dismissBluetoothBanner();
            return GLib.SOURCE_REMOVE;
        });
    }

    _dismissBluetoothBanner() {
        this._bluetoothBox.ease({
            opacity: 0,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._bluetoothBox.visible = false;
                this._isBtBannerActive = false;

                const targetWidth = this._getCurrentPillWidth();
                if (this._recorder?.isRecording) this._compactRecordBox.visible = true;
                else if (this._mediaActive) this._compactBox.visible = true;
                else this._idleBox.visible = true;

                this._repositionAndResize(targetWidth, this._collapsedHeight, 260, Clutter.AnimationMode.EASE_OUT_QUAD);
            },
        });
    }

    _getCurrentPillWidth() {
        if (this._isBtBannerActive) return this._bluetoothWidth;
        if (this._isHudActive) return this._hudWidth;
        if (this._isChargingBannerActive) return this._chargingWidth;
        if (this._isCountingDown) return this._countdownWidth;
        if (this._isExpanded) {
            if (this._isProcessingQueue) return this._notifWidth;
            if (this._isControlCenterOpen) return this._ccExpandedWidth;
            if (this._recorder?.isRecording) return this._mediaExpandedWidth;
            if (this._mediaActive) return this._mediaExpandedWidth;
            return this._mediaExpandedWidth;
        }
        if (this._recorder?.isRecording) return this._compactRecordWidth;
        if (this._mediaActive) return this._compactMediaWidth;
        return this._idleWidth;
    }

    _reposition(width) {
        if (!this._island || !this._monitor) return;
        const x = this._monitor.x + Math.floor((this._monitor.width - width) / 2);
        this._island.set_position(x, this._monitor.y + 7);
    }

    _repositionAndResize(width, height, duration = 280, mode = Clutter.AnimationMode.EASE_OUT_QUAD) {
        const targetX = this._monitor.x + Math.floor((this._monitor.width - width) / 2);
        this._island.ease({
            width,
            height,
            x: targetX,
            duration,
            mode,
        });
    }

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
        if (this._isProcessingQueue || this._notificationQueue.length === 0 || this._isChargingBannerActive || this._isHudActive || this._isBtBannerActive || this._isCountingDown || this._isControlCenterOpen) return;

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
        this._idleBox.visible = false;
        this._compactBox.visible = false;
        this._compactRecordBox.visible = false;
        this._mediaContent.visible = false;
        this._bluetoothBox.visible = false;
        this._recordExpandedBox.visible = false;
        this._controlCenterBox.visible = false;
        this._notifBox.visible = true;

        this._repositionAndResize(this._notifWidth, this._notifHeight, 320, Clutter.AnimationMode.EASE_OUT_BACK);
        this._notifBox.ease({ opacity: 255, duration: 180, delay: 40, mode: Clutter.AnimationMode.EASE_OUT_QUAD });

        if (this._autoCollapseId) GLib.source_remove(this._autoCollapseId);
        this._autoCollapseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4200, () => {
            this._autoCollapseId = null;
            if (this._island.hover) this._waitingForMouseLeave = true;
            else                    this._collapseAndNext();
            return GLib.SOURCE_REMOVE;
        });
    }

    _expandMedia() {
        if (this._isExpanded || !this._island) return;
        this._isExpanded = true;

        this._idleBox.visible = false;
        this._compactBox.visible = false;
        this._compactRecordBox.visible = false;
        this._notifBox.visible = false;
        this._bluetoothBox.visible = false;
        this._recordExpandedBox.visible = false;
        this._controlCenterBox.visible = false;
        this._mediaContent.visible = true;

        this._repositionAndResize(this._mediaExpandedWidth, this._mediaExpandedHeight, 320, Clutter.AnimationMode.EASE_OUT_BACK);
        this._mediaContent.ease({ opacity: 255, duration: 200, delay: 60, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        this._updateProgressUI();
    }

    _collapse() {
        if (!this._isExpanded && this._island.width === this._getCurrentPillWidth()) return;
        this._isExpanded = false;
        this._isControlCenterOpen = false;

        // MENGHAPUS KELAS KACA KETIKA MENUTUP CC
        this._island.remove_style_class_name('dynamic-island-cc-expanded');

        let targetWidth = this._idleWidth;
        if (this._recorder?.isRecording) targetWidth = this._compactRecordWidth;
        else if (this._mediaActive) targetWidth = this._compactMediaWidth;

        this._mediaContent.ease({
            opacity: 0,
            duration: 80,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._controlCenterBox.ease({
            opacity: 0,
            duration: 80,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._mediaContent.visible = false;
                this._notifBox.visible = false;
                this._recordExpandedBox.visible = false;
                this._controlCenterBox.visible = false;

                if (this._recorder?.isRecording) {
                    this._compactRecordBox.visible = true;
                } else if (this._mediaActive && !this._isProcessingQueue && !this._isChargingBannerActive && !this._isHudActive && !this._isBtBannerActive) {
                    this._compactBox.visible = true;
                    this._compactBox.opacity = 0;
                    this._compactBox.ease({ opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                } else if (!this._mediaActive && !this._isProcessingQueue) {
                    this._idleBox.visible = true;
                    this._idleBox.opacity = 0;
                    this._idleBox.ease({ opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                }
            },
        });

        this._repositionAndResize(targetWidth, this._collapsedHeight, 260, Clutter.AnimationMode.EASE_OUT_QUAD);
    }

    _collapseAndNext() {
        this._notifBox.ease({
            opacity: 0,
            duration: 80,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._notifBox.visible = false;
            },
        });

        this._isExpanded = false;
        this._isControlCenterOpen = false;
        this._island.remove_style_class_name('dynamic-island-cc-expanded');

        let targetWidth = this._idleWidth;
        if (this._recorder?.isRecording) targetWidth = this._compactRecordWidth;
        else if (this._mediaActive) targetWidth = this._compactMediaWidth;

        this._repositionAndResize(targetWidth, this._collapsedHeight, 260, Clutter.AnimationMode.EASE_OUT_QUAD);

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 280, () => {
            this._isProcessingQueue = false;
            this._waitingForMouseLeave = false;
            this._currentNotification = null;

            if (this._notificationQueue.length > 0) {
                this._processQueue();
            } else if (this._recorder?.isRecording) {
                this._compactRecordBox.visible = true;
            } else if (this._mediaActive) {
                this._compactBox.visible = true;
            } else {
                this._idleBox.visible = true;
                this._idleBox.opacity = 255;
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // ================= MPRIS UPDATE & SYNC NOW PLAYING =================
    _onMediaUpdate(state) {
        this._currentMedia = state;

        if (this._pauseTimeoutId) {
            GLib.source_remove(this._pauseTimeoutId);
            this._pauseTimeoutId = null;
        }

        if (!state || state.status === 'Stopped') {
            this._mediaActive = false;
            this._compactBox.visible = false;
            this._mediaContent.visible = false;

            if (!this._isProcessingQueue && !this._isChargingBannerActive && !this._isHudActive && !this._isBtBannerActive && !this._isControlCenterOpen) {
                if (this._recorder?.isRecording) {
                    this._compactRecordBox.visible = true;
                } else {
                    this._idleBox.visible = true;
                    this._idleBox.opacity = 255;
                }
                this._collapse();
            }
            this._syncControlCenterUI();
            return;
        }

        if (state.status === 'Playing') {
            this._mediaActive = true;
        } else if (state.status === 'Paused') {
            if (this._mediaActive) {
                this._pauseTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8, () => {
                    this._pauseTimeoutId = null;
                    this._mediaActive = false;

                    if (!this._isExpanded && !this._recorder?.isRecording && !this._isChargingBannerActive && !this._isHudActive && !this._isBtBannerActive) {
                        this._compactBox.ease({
                            opacity: 0,
                            duration: 140,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            onComplete: () => {
                                this._compactBox.visible = false;
                                this._idleBox.visible = true;
                                this._idleBox.opacity = 0;
                                this._idleBox.ease({ opacity: 255, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                            },
                        });
                        this._repositionAndResize(this._idleWidth, this._collapsedHeight, 260, Clutter.AnimationMode.EASE_OUT_QUAD);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        }

        this._titleLabel.set_text(state.title || 'Sedang Diputar');
        this._bodyLabel.set_text(state.artist || 'Tidak Diketahui');
        this._loadCoverArt(state.artUrl);

        const playIcon = state.status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._playBtn.child.icon_name = playIcon;

        if (this._mediaActive) {
            this._idleBox.visible = false;
            if (!this._isExpanded && !this._isProcessingQueue && !this._isChargingBannerActive && !this._isHudActive && !this._isBtBannerActive && !this._recorder?.isRecording && !this._isControlCenterOpen) {
                this._compactBox.visible = true;
                this._compactBox.opacity = 255;
                this._repositionAndResize(this._compactMediaWidth, this._collapsedHeight, 240, Clutter.AnimationMode.EASE_OUT_QUAD);
            }
        }

        if (this._isExpanded) {
            this._updateProgressUI();
        }

        // Sinkronisasi otomatis ke tampilan Control Center jika sedang terbuka
        this._syncControlCenterUI();
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
        this._ccMediaArt.gicon = null;

        if (pixbuf) {
            try {
                const [ok, buffer] = pixbuf.save_to_bufferv('png', [], []);
                if (ok) {
                    const bytesIcon = Gio.BytesIcon.new(GLib.Bytes.new(buffer));
                    this._mediaIcon.gicon = bytesIcon;
                    this._compactIcon.gicon = bytesIcon;
                    this._ccMediaArt.gicon = bytesIcon;
                    return;
                }
            } catch (_) {}
        }
        this._mediaIcon.icon_name = iconName || 'audio-x-generic-symbolic';
        this._compactIcon.icon_name = iconName || 'audio-x-generic-symbolic';
        this._ccMediaArt.icon_name = iconName || 'audio-x-generic-symbolic';
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
        if (duration <= 0) return;

        const pos = this._media?.getPosition() ?? 0;
        const ratio = Math.max(0, Math.min(1, pos / duration));
        
        // Update bar expanded media utama
        const trackW = 330;
        const fillW = Math.floor(trackW * ratio);
        this._progressFill.width = Math.max(0, fillW);
        this._timeLabel.set_text(this._formatTime(pos));
        this._durationLabel.set_text(this._formatTime(duration));

        // Update bar scrub kartu Now Playing di Control Center
        const ccTrackW = this._ccScrubTrack.width || 210;
        this._ccScrubFill.width = Math.max(16, Math.floor(ccTrackW * ratio));
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

        this._idleBox.visible = false;
        this._compactBox.visible = false;
        this._compactRecordBox.visible = false;
        this._mediaContent.visible = false;
        this._notifBox.visible = false;
        this._chargingBox.visible = false;
        this._bluetoothBox.visible = false;
        this._recordExpandedBox.visible = false;
        this._controlCenterBox.visible = false;
        this._hudBox.visible = true;

        this._repositionAndResize(this._hudWidth, this._collapsedHeight, 280, Clutter.AnimationMode.EASE_OUT_BACK);
        this._hudBox.ease({ opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD });

        this._hudDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => {
            this._hudDismissId = null;
            this._hudBox.ease({
                opacity: 0,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    this._hudBox.visible = false;
                    this._isHudActive = false;
                    const targetWidth = this._getCurrentPillWidth();
                    if (this._recorder?.isRecording) this._compactRecordBox.visible = true;
                    else if (this._mediaActive) this._compactBox.visible = true;
                    else this._idleBox.visible = true;
                    this._repositionAndResize(targetWidth, this._collapsedHeight, 260, Clutter.AnimationMode.EASE_OUT_QUAD);
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

        this._idleBox.visible = false;
        this._compactBox.visible = false;
        this._compactRecordBox.visible = false;
        this._mediaContent.visible = false;
        this._notifBox.visible = false;
        this._hudBox.visible = false;
        this._bluetoothBox.visible = false;
        this._recordExpandedBox.visible = false;
        this._controlCenterBox.visible = false;
        this._chargingBox.visible = true;

        this._repositionAndResize(this._chargingWidth, this._collapsedHeight, 340, Clutter.AnimationMode.EASE_OUT_BACK);
        this._chargingBox.ease({ opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });

        this._chargingDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._chargingDismissId = null;
            this._chargingBox.ease({
                opacity: 0,
                duration: 130,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    this._chargingBox.visible = false;
                    this._isChargingBannerActive = false;
                    const targetWidth = this._getCurrentPillWidth();
                    if (this._recorder?.isRecording) this._compactRecordBox.visible = true;
                    else if (this._mediaActive) this._compactBox.visible = true;
                    else this._idleBox.visible = true;
                    this._repositionAndResize(targetWidth, this._collapsedHeight, 260, Clutter.AnimationMode.EASE_OUT_QUAD);
                },
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._pauseTimeoutId) {
            GLib.source_remove(this._pauseTimeoutId);
            this._pauseTimeoutId = null;
        }
        if (this._clockTickId) {
            GLib.source_remove(this._clockTickId);
            this._clockTickId = null;
        }
        if (this._countdownTickId) {
            GLib.source_remove(this._countdownTickId);
            this._countdownTickId = null;
        }
        if (this._btDismissId) {
            GLib.source_remove(this._btDismissId);
            this._btDismissId = null;
        }

        if (this._origOsdShow) {
            Main.osdWindowManager.show = this._origOsdShow;
            this._origOsdShow = null;
        }
        if (this._settings) {
            this._settings.set_boolean('show-banners', this._originalShowBanners);
            this._settings = null;
        }
        if (Main.messageTray._bannerBin) {
            Main.messageTray._bannerBin.show();
        }

        if (this._monitorsChangedId) Main.layoutManager.disconnect(this._monitorsChangedId);
        if (this._sourceAddedId) Main.messageTray.disconnect(this._sourceAddedId);
        if (this._sourceRemovedId) Main.messageTray.disconnect(this._sourceRemovedId);

        for (const [source, id] of this._sourceConnections) {
            try { source.disconnect(id); } catch (_) {}
        }
        this._sourceConnections.clear();

        if (this._autoCollapseId) GLib.source_remove(this._autoCollapseId);
        if (this._recordPulseId) GLib.source_remove(this._recordPulseId);
        if (this._chargingDismissId) GLib.source_remove(this._chargingDismissId);
        if (this._hudDismissId) GLib.source_remove(this._hudDismissId);
        if (this._unhoverTimeoutId) GLib.source_remove(this._unhoverTimeoutId);
        if (this._waveTickId) GLib.source_remove(this._waveTickId);
        if (this._progressTickId) GLib.source_remove(this._progressTickId);

        if (this._cc) this._cc.destroy();
        if (this._recorder) this._recorder.destroy();
        if (this._privacy) this._privacy.destroy();
        if (this._bluetooth) this._bluetooth.destroy();
        if (this._battery) this._battery.destroy();
        if (this._media) this._media.destroy();
        if (this._island) this._island.destroy();
    }
}