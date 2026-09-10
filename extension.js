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
import { TimerManager } from './timer.js';
import { ScreenRecordWatcher } from './recorder.js';

export default class DynamicIslandExtension extends Extension {
    enable() {
        console.log('[DynamicIsland] Mengaktifkan Dynamic Island (Dengan Screen Recording iOS)...');

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
        this._compactTimerWidth   = 185;
        this._compactRecordWidth  = 185;
        this._hudWidth            = 225;
        this._chargingWidth       = 235;
        this._bluetoothWidth      = 260;
        this._timerAlertWidth     = 240;

        this._notifWidth          = 370;
        this._notifHeight         = 68;
        this._mediaExpandedWidth  = 385;
        this._mediaExpandedHeight = 168;
        this._timerExpandedWidth  = 385;
        this._timerExpandedHeight = 135;
        this._timerPresetHeight   = 106;
        this._recordExpandedHeight= 135;

        // ======== STATE ========
        this._isExpanded = false;
        this._isChargingBannerActive = false;
        this._isHudActive = false;
        this._isBtBannerActive = false;
        this._isTimerAlertActive = false;
        this._isCountingDown = false;
        this._countdownNumber = 3;
        this._chargingDismissId = null;
        this._hudDismissId = null;
        this._btDismissId = null;
        this._timerAlertDismissId = null;
        this._countdownTickId = null;
        this._clockTickId = null;
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

        // ================= COUNTDOWN 3-2-1 SCREEN RECORDING =================
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

        // ================= COMPACT RECORDING VIEW (DOT MERAH + TIMER) =================
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

        // ================= 0B. COMPACT TIMER =================
        this._compactTimerBox = new St.BoxLayout({
            style_class: 'dynamic-island-compact-timer',
            vertical: false,
            x_expand: true,
            y_expand: true,
            reactive: false,
            visible: false,
        });
        this._compactTimerIconBin = new St.Bin({
            style_class: 'dynamic-island-compact-timer-icon-bin',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'alarm-symbolic',
                icon_size: 13,
                style_class: 'dynamic-island-compact-timer-icon',
            }),
        });
        this._compactTimerLabel = new St.Label({
            style_class: 'dynamic-island-compact-timer-label',
            text: '00:00',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        this._compactTimerLabel.clutter_text.ellipsize = 0;
        this._compactTimerLabel.clutter_text.single_line_mode = true;
        this._compactTimerBox.add_child(this._compactTimerIconBin);
        this._compactTimerBox.add_child(this._compactTimerLabel);
        this._island.add_child(this._compactTimerBox);

        // ================= 0C. TIMER ALERT FINISHED =================
        this._timerAlertBox = new St.BoxLayout({
            style_class: 'dynamic-island-timer-alert-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            reactive: false,
            visible: false,
            opacity: 0,
        });
        this._timerAlertIcon = new St.Icon({
            icon_name: 'alarm-symbolic',
            icon_size: 16,
            style_class: 'dynamic-island-timer-alert-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timerAlertLabel = new St.Label({
            style_class: 'dynamic-island-timer-alert-label',
            text: 'Timer Selesai!',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timerAlertLabel.clutter_text.ellipsize = 0;
        this._timerAlertBox.add_child(this._timerAlertIcon);
        this._timerAlertBox.add_child(this._timerAlertLabel);
        this._island.add_child(this._timerAlertBox);

        // ================= 1. BLUETOOTH / AIRPODS VIEW =================
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
            text: 'AirPods Pro',
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

        // ================= 2. VOLUME & BRIGHTNESS HUD =================
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

        // ================= 3. CHARGING VIEW =================
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

        // ================= 4. COMPACT VIEW (COLLAPSED MUSIC) =================
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

        // ================= 5. NOTIFICATION VIEW =================
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

        // ================= 6. EXPANDED MEDIA VIEW =================
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

        // ================= 7. EXPANDED TIMER =================
        this._timerExpandedBox = new St.BoxLayout({
            style_class: 'dynamic-island-timer-expanded',
            vertical: true,
            x_expand: true,
            y_expand: true,
            visible: false,
            opacity: 0,
            reactive: true,
        });

        this._timerRunningView = new St.BoxLayout({
            style_class: 'dynamic-island-timer-running-view',
            vertical: true,
            x_expand: true,
            visible: false,
        });

        this._timerTopRow = new St.BoxLayout({
            style_class: 'dynamic-island-timer-top-row',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._timerTextCol = new St.BoxLayout({
            style_class: 'dynamic-island-timer-text-col',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timerSubLabel = new St.Label({
            style_class: 'dynamic-island-timer-sub-label',
            text: 'TIMER',
        });
        this._timerBigLabel = new St.Label({
            style_class: 'dynamic-island-timer-big-label',
            text: '00:00',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timerBigLabel.clutter_text.ellipsize = 0;
        this._timerBigLabel.clutter_text.single_line_mode = true;

        this._timerTextCol.add_child(this._timerSubLabel);
        this._timerTextCol.add_child(this._timerBigLabel);

        this._timerActionsCol = new St.BoxLayout({
            style_class: 'dynamic-island-timer-actions-col',
            vertical: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._timerCancelBtn = new St.Button({
            style_class: 'dynamic-island-timer-circle-btn cancel',
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 16 }),
            can_focus: true,
            reactive: true,
        });

        this._timerPauseIcon = new St.Icon({ icon_name: 'media-playback-pause-symbolic', icon_size: 18 });
        this._timerPauseBtn = new St.Button({
            style_class: 'dynamic-island-timer-circle-btn pause',
            child: this._timerPauseIcon,
            can_focus: true,
            reactive: true,
        });

        this._timerActionsCol.add_child(this._timerCancelBtn);
        this._timerActionsCol.add_child(this._timerPauseBtn);

        this._timerTopRow.add_child(this._timerTextCol);
        this._timerTopRow.add_child(this._timerActionsCol);

        this._timerProgressBar = new St.Widget({
            style_class: 'dynamic-island-timer-bar-track',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timerProgressFill = new St.Widget({
            style_class: 'dynamic-island-timer-bar-fill',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._timerProgressBar.add_child(this._timerProgressFill);

        this._timerRunningView.add_child(this._timerTopRow);
        this._timerRunningView.add_child(this._timerProgressBar);

        this._timerPresetView = new St.BoxLayout({
            style_class: 'dynamic-island-timer-preset-view',
            vertical: true,
            x_expand: true,
            visible: false,
        });

        this._timerPresetHeader = new St.BoxLayout({
            style_class: 'dynamic-island-preset-header',
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timerPresetIcon = new St.Icon({
            icon_name: 'alarm-symbolic',
            icon_size: 13,
            style_class: 'dynamic-island-preset-header-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timerPresetTitle = new St.Label({
            style_class: 'dynamic-island-timer-preset-title',
            text: 'QUICK TIMER',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._timerPresetTitle.clutter_text.ellipsize = 0;
        this._timerPresetTitle.clutter_text.single_line_mode = true;

        this._timerPresetHeader.add_child(this._timerPresetIcon);
        this._timerPresetHeader.add_child(this._timerPresetTitle);

        this._timerPresetRow = new St.BoxLayout({
            style_class: 'dynamic-island-preset-row',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._preset5Btn = new St.Button({
            style_class: 'dynamic-island-preset-tile',
            child: new St.Label({ text: '5m' }),
            can_focus: true,
            x_expand: true,
        });
        this._preset15Btn = new St.Button({
            style_class: 'dynamic-island-preset-tile',
            child: new St.Label({ text: '15m' }),
            can_focus: true,
            x_expand: true,
        });
        this._preset25Btn = new St.Button({
            style_class: 'dynamic-island-preset-tile pomodoro',
            child: new St.Label({ text: '25m Pomodoro' }),
            can_focus: true,
            x_expand: true,
        });
        this._timerPresetRow.add_child(this._preset5Btn);
        this._timerPresetRow.add_child(this._preset15Btn);
        this._timerPresetRow.add_child(this._preset25Btn);

        this._timerPresetView.add_child(this._timerPresetHeader);
        this._timerPresetView.add_child(this._timerPresetRow);

        this._timerExpandedBox.add_child(this._timerRunningView);
        this._timerExpandedBox.add_child(this._timerPresetView);
        this._island.add_child(this._timerExpandedBox);

        // ================= 8. EXPANDED SCREEN RECORDING CARD (ALA IOS) =================
        this._recordExpandedBox = new St.BoxLayout({
            style_class: 'dynamic-island-record-expanded',
            vertical: true,
            x_expand: true,
            y_expand: true,
            visible: false,
            opacity: 0,
            reactive: true,
        });

        this._recordTopRow = new St.BoxLayout({
            style_class: 'dynamic-island-record-top-row',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._recordTextCol = new St.BoxLayout({
            style_class: 'dynamic-island-record-text-col',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._recordSubLabel = new St.Label({
            style_class: 'dynamic-island-record-sub-label',
            text: 'SCREEN RECORDING',
        });
        this._recordBigLabel = new St.Label({
            style_class: 'dynamic-island-record-big-label',
            text: '00:00',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._recordBigLabel.clutter_text.ellipsize = 0;
        this._recordBigLabel.clutter_text.single_line_mode = true;
        this._recordTextCol.add_child(this._recordSubLabel);
        this._recordTextCol.add_child(this._recordBigLabel);

        // Tombol Stop Merah Bundar Khas iOS
        this._recordStopBtn = new St.Button({
            style_class: 'dynamic-island-record-stop-btn',
            child: new St.Icon({ icon_name: 'media-playback-stop-symbolic', icon_size: 16 }),
            can_focus: true,
            reactive: true,
        });

        this._recordTopRow.add_child(this._recordTextCol);
        this._recordTopRow.add_child(this._recordStopBtn);

        this._recordPulseBar = new St.Widget({
            style_class: 'dynamic-island-record-pulse-bar',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._recordExpandedBox.add_child(this._recordTopRow);
        this._recordExpandedBox.add_child(this._recordPulseBar);
        this._island.add_child(this._recordExpandedBox);

        Main.uiGroup.add_child(this._island);
        this._reposition(this._idleWidth);

        // Update Jam Standby
        this._updateClock();
        this._clockTickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });

        // Timer Manager
        this._timer = new TimerManager({
            onTick: data => this._onTimerTick(data),
            onFinished: () => this._onTimerFinished(),
            onStateChange: state => this._onTimerStateChange(state),
        });

        this._preset5Btn.connect('clicked', () => this._timer.start(5 * 60));
        this._preset15Btn.connect('clicked', () => this._timer.start(15 * 60));
        this._preset25Btn.connect('clicked', () => this._timer.start(25 * 60));

        this._timerCancelBtn.connect('clicked', () => {
            this._timer.stop();
            this._collapse();
        });
        this._timerPauseBtn.connect('clicked', () => this._timer.togglePause());

        // Screen Recording Watcher
        this._recorder = new ScreenRecordWatcher({
            onRecordingStarted: () => this._onRecordingStarted(),
            onRecordingStopped: () => this._onRecordingStopped(),
            onTick: data => this._onRecordingTick(data),
        });
        this._recordStopBtn.connect('clicked', () => this._recorder.stopRecordingSession());

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

        // Hover Handler
        this._island.connect('notify::hover', () => {
            if (this._isChargingBannerActive || this._isHudActive || this._isBtBannerActive || this._isTimerAlertActive || this._isCountingDown) return;
            const hovering = this._island.hover;

            if (hovering) {
                if (this._unhoverTimeoutId) {
                    GLib.source_remove(this._unhoverTimeoutId);
                    this._unhoverTimeoutId = null;
                }
                if (!this._isExpanded && !this._isProcessingQueue) {
                    if (this._recorder?.isRecording) {
                        this._expandRecord();
                    } else if (this._mediaActive) {
                        this._expandMedia();
                    } else {
                        this._expandTimer();
                    }
                }
            } else {
                if (this._isExpanded && !this._isDraggingSeek) {
                    this._unhoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 240, () => {
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

        // Notifications
        this._sourceConnections = new Map();
        Main.messageTray.getSources().forEach(s => this._connectSource(s));
        this._sourceAddedId = Main.messageTray.connect('source-added', (_t, s) => this._connectSource(s));
        this._sourceRemovedId = Main.messageTray.connect('source-removed', (_t, s) => this._disconnectSource(s));

        // Subsystems
        this._media = new MediaWatcher(state => this._onMediaUpdate(state));
        this._battery = new BatteryWatcher(event => this._onBatteryEvent(event));
        this._bluetooth = new BluetoothWatcher(event => this._onBluetoothConnected(event));
        this._privacy = new PrivacyWatcher(state => this._onPrivacyState(state));

        // Wave Animation
        this._wavePhase = 0;
        this._waveTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 170, () => {
            const playing = this._currentMedia?.status === 'Playing';
            if (this._mediaActive && playing && !this._isChargingBannerActive && !this._isHudActive && !this._isBtBannerActive && !this._isTimerAlertActive && !this._recorder?.isRecording) {
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

        // Progress Bar Media
        this._progressTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (this._mediaActive && this._currentMedia?.status === 'Playing' && this._isExpanded && !this._isDraggingSeek) {
                this._updateProgressUI();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ================= ANIMASI HITUNGAN MUNDUR 3-2-1 RECORDING =================
    _onRecordingStarted() {
        this._isCountingDown = true;
        this._countdownNumber = 3;

        this._idleBox.visible = false;
        this._compactBox.visible = false;
        this._compactTimerBox.visible = false;
        this._compactRecordBox.visible = false;
        this._mediaContent.visible = false;
        this._timerExpandedBox.visible = false;
        this._recordExpandedBox.visible = false;
        this._countdownBox.visible = true;

        this._countdownLabel.set_text('3');
        this._repositionAndResize(85, this._collapsedHeight, 280, Clutter.AnimationMode.EASE_OUT_BACK);
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
        this._collapse();
    }

    _expandRecord() {
        if (this._isExpanded || !this._island) return;
        this._isExpanded = true;

        this._idleBox.visible = false;
        this._compactBox.visible = false;
        this._compactTimerBox.visible = false;
        this._compactRecordBox.visible = false;
        this._mediaContent.visible = false;
        this._timerExpandedBox.visible = false;
        this._recordExpandedBox.visible = true;

        this._repositionAndResize(this._timerExpandedWidth, this._recordExpandedHeight, 320, Clutter.AnimationMode.EASE_OUT_BACK);
        this._recordExpandedBox.ease({
            opacity: 255,
            duration: 190,
            delay: 40,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // ================= TIMER CONTROLLER =================
    _onTimerTick({ formatted, ratio, isPaused }) {
        this._compactTimerLabel.set_text(formatted);
        this._timerBigLabel.set_text(formatted);

        const trackW = 345;
        this._timerProgressFill.width = Math.max(0, Math.floor(trackW * ratio));

        if (isPaused) {
            this._timerPauseIcon.icon_name = 'media-playback-start-symbolic';
        } else {
            this._timerPauseIcon.icon_name = 'media-playback-pause-symbolic';
        }
    }

    _onTimerStateChange({ isRunning }) {
        if (isRunning) {
            this._timerRunningView.visible = true;
            this._timerPresetView.visible = false;
            if (!this._isExpanded && !this._mediaActive && !this._recorder?.isRecording) {
                this._idleBox.visible = false;
                this._compactTimerBox.visible = true;
                this._repositionAndResize(this._compactTimerWidth, this._collapsedHeight);
            }
        } else {
            this._timerRunningView.visible = false;
            this._timerPresetView.visible = true;
            this._compactTimerBox.visible = false;
            if (!this._isExpanded && !this._mediaActive && !this._recorder?.isRecording) {
                this._idleBox.visible = true;
                this._repositionAndResize(this._idleWidth, this._collapsedHeight);
            }
        }
    }

    _onTimerFinished() {
        if (this._timerAlertDismissId) GLib.source_remove(this._timerAlertDismissId);

        try {
            global.display?.get_sound_player?.()?.play_from_theme?.('alarm-clock-elapsed', 'Timer', null);
        } catch (_) {}

        this._isTimerAlertActive = true;
        this._idleBox.visible = false;
        this._compactBox.visible = false;
        this._compactTimerBox.visible = false;
        this._compactRecordBox.visible = false;
        this._mediaContent.visible = false;
        this._timerExpandedBox.visible = false;
        this._recordExpandedBox.visible = false;
        this._timerAlertBox.visible = true;

        this._repositionAndResize(this._timerAlertWidth, this._collapsedHeight, 340, Clutter.AnimationMode.EASE_OUT_BACK);
        this._timerAlertBox.ease({ opacity: 255, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD });

        this._timerAlertDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
            this._timerAlertDismissId = null;
            this._timerAlertBox.ease({
                opacity: 0,
                duration: 140,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    this._timerAlertBox.visible = false;
                    this._isTimerAlertActive = false;
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

    _expandTimer() {
        if (this._isExpanded || !this._island) return;
        this._isExpanded = true;

        this._idleBox.visible = false;
        this._compactBox.visible = false;
        this._compactTimerBox.visible = false;
        this._compactRecordBox.visible = false;
        this._mediaContent.visible = false;
        this._notifBox.visible = false;
        this._recordExpandedBox.visible = false;
        this._timerExpandedBox.visible = true;

        const isRunning = this._timer.isActive;
        this._timerRunningView.visible = isRunning;
        this._timerPresetView.visible = !isRunning;

        const targetHeight = isRunning ? this._timerExpandedHeight : this._timerPresetHeight;

        this._repositionAndResize(this._timerExpandedWidth, targetHeight, 320, Clutter.AnimationMode.EASE_OUT_BACK);
        this._timerExpandedBox.ease({
            opacity: 255,
            duration: 190,
            delay: 40,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
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
        this._compactTimerBox.visible = false;
        this._compactRecordBox.visible = false;
        this._mediaContent.visible = false;
        this._chargingBox.visible = false;
        this._hudBox.visible = false;
        this._notifBox.visible = false;
        this._timerExpandedBox.visible = false;
        this._recordExpandedBox.visible = false;
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
                else if (this._timer?.isActive) this._compactTimerBox.visible = true;
                else this._idleBox.visible = true;

                this._repositionAndResize(targetWidth, this._collapsedHeight, 260, Clutter.AnimationMode.EASE_OUT_QUAD);
            },
        });
    }

    _getCurrentPillWidth() {
        if (this._isTimerAlertActive) return this._timerAlertWidth;
        if (this._isBtBannerActive) return this._bluetoothWidth;
        if (this._isHudActive) return this._hudWidth;
        if (this._isChargingBannerActive) return this._chargingWidth;
        if (this._isCountingDown) return 85;
        if (this._isExpanded) {
            if (this._isProcessingQueue) return this._notifWidth;
            if (this._recorder?.isRecording) return this._timerExpandedWidth;
            if (this._mediaActive) return this._mediaExpandedWidth;
            return this._timerExpandedWidth;
        }
        if (this._recorder?.isRecording) return this._compactRecordWidth;
        if (this._mediaActive) return this._compactMediaWidth;
        if (this._timer?.isActive) return this._compactTimerWidth;
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
        if (this._isProcessingQueue || this._notificationQueue.length === 0 || this._isChargingBannerActive || this._isHudActive || this._isBtBannerActive || this._isTimerAlertActive || this._isCountingDown) return;

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
        this._compactTimerBox.visible = false;
        this._compactRecordBox.visible = false;
        this._mediaContent.visible = false;
        this._bluetoothBox.visible = false;
        this._timerExpandedBox.visible = false;
        this._recordExpandedBox.visible = false;
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
        this._compactTimerBox.visible = false;
        this._compactRecordBox.visible = false;
        this._notifBox.visible = false;
        this._bluetoothBox.visible = false;
        this._timerExpandedBox.visible = false;
        this._recordExpandedBox.visible = false;
        this._mediaContent.visible = true;

        this._repositionAndResize(this._mediaExpandedWidth, this._mediaExpandedHeight, 320, Clutter.AnimationMode.EASE_OUT_BACK);
        this._mediaContent.ease({ opacity: 255, duration: 200, delay: 60, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        this._updateProgressUI();
    }

    _collapse() {
        if (!this._isExpanded && this._island.width === this._getCurrentPillWidth()) return;
        this._isExpanded = false;

        let targetWidth = this._idleWidth;
        if (this._recorder?.isRecording) targetWidth = this._compactRecordWidth;
        else if (this._mediaActive) targetWidth = this._compactMediaWidth;
        else if (this._timer?.isActive) targetWidth = this._compactTimerWidth;

        this._mediaContent.ease({
            opacity: 0,
            duration: 80,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._mediaContent.visible = false;
                this._notifBox.visible = false;
                this._timerExpandedBox.visible = false;
                this._recordExpandedBox.visible = false;

                if (this._recorder?.isRecording) {
                    this._compactRecordBox.visible = true;
                } else if (this._mediaActive && !this._isProcessingQueue && !this._isChargingBannerActive && !this._isHudActive && !this._isBtBannerActive) {
                    this._compactBox.visible = true;
                    this._compactBox.opacity = 0;
                    this._compactBox.ease({ opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                } else if (this._timer?.isActive && !this._isProcessingQueue) {
                    this._compactTimerBox.visible = true;
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
        let targetWidth = this._idleWidth;
        if (this._recorder?.isRecording) targetWidth = this._compactRecordWidth;
        else if (this._mediaActive) targetWidth = this._compactMediaWidth;
        else if (this._timer?.isActive) targetWidth = this._compactTimerWidth;

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
            } else if (this._timer?.isActive) {
                this._compactTimerBox.visible = true;
            } else {
                this._idleBox.visible = true;
                this._idleBox.opacity = 255;
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

            if (!this._isProcessingQueue && !this._isChargingBannerActive && !this._isHudActive && !this._isBtBannerActive) {
                if (this._recorder?.isRecording) {
                    this._compactRecordBox.visible = true;
                } else if (this._timer?.isActive) {
                    this._compactTimerBox.visible = true;
                } else {
                    this._idleBox.visible = true;
                    this._idleBox.opacity = 255;
                }
                this._collapse();
            }
            return;
        }

        this._mediaActive = true;
        this._idleBox.visible = false;
        this._compactTimerBox.visible = false;
        this._titleLabel.set_text(state.title || 'Sedang Diputar');
        this._bodyLabel.set_text(state.artist || 'Tidak Diketahui');
        this._loadCoverArt(state.artUrl);

        const playIcon = state.status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._playBtn.child.icon_name = playIcon;

        if (!this._isExpanded && !this._isProcessingQueue && !this._isChargingBannerActive && !this._isHudActive && !this._isBtBannerActive && !this._recorder?.isRecording) {
            this._compactBox.visible = true;
            this._repositionAndResize(this._compactMediaWidth, this._collapsedHeight, 240, Clutter.AnimationMode.EASE_OUT_QUAD);
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
        const trackW = 330;
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
        this._compactTimerBox.visible = false;
        this._compactRecordBox.visible = false;
        this._mediaContent.visible = false;
        this._notifBox.visible = false;
        this._chargingBox.visible = false;
        this._bluetoothBox.visible = false;
        this._timerExpandedBox.visible = false;
        this._recordExpandedBox.visible = false;
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
                    else if (this._timer?.isActive) this._compactTimerBox.visible = true;
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
        this._compactTimerBox.visible = false;
        this._compactRecordBox.visible = false;
        this._mediaContent.visible = false;
        this._notifBox.visible = false;
        this._hudBox.visible = false;
        this._bluetoothBox.visible = false;
        this._timerExpandedBox.visible = false;
        this._recordExpandedBox.visible = false;
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
                    else if (this._timer?.isActive) this._compactTimerBox.visible = true;
                    else this._idleBox.visible = true;
                    this._repositionAndResize(targetWidth, this._collapsedHeight, 260, Clutter.AnimationMode.EASE_OUT_QUAD);
                },
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
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
        if (this._timerAlertDismissId) {
            GLib.source_remove(this._timerAlertDismissId);
            this._timerAlertDismissId = null;
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
        if (this._chargingDismissId) GLib.source_remove(this._chargingDismissId);
        if (this._hudDismissId) GLib.source_remove(this._hudDismissId);
        if (this._unhoverTimeoutId) GLib.source_remove(this._unhoverTimeoutId);
        if (this._waveTickId) GLib.source_remove(this._waveTickId);
        if (this._progressTickId) GLib.source_remove(this._progressTickId);

        if (this._recorder) this._recorder.destroy();
        if (this._timer) this._timer.destroy();
        if (this._privacy) this._privacy.destroy();
        if (this._bluetooth) this._bluetooth.destroy();
        if (this._battery) this._battery.destroy();
        if (this._media) this._media.destroy();
        if (this._island) this._island.destroy();
    }
}