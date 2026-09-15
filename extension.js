import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
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
import { WorkspaceWatcher } from './workspace.js';
import { MountWatcher } from './mount.js';
import { DownloadWatcher } from './download.js';
import { VpnWatcher } from './vpn.js';

// KUMPULAN STATE EKSKLUSIF
const VIEW_IDLE = 'idle';
const VIEW_COMPACT_MEDIA = 'compact_media';
const VIEW_COMPACT_RECORD = 'compact_record';
const VIEW_COMPACT_DL = 'compact_dl';
const VIEW_WORKSPACE = 'workspace';
const VIEW_MOUNT = 'mount';
const VIEW_VPN = 'vpn';
const VIEW_BT = 'bluetooth';
const VIEW_HUD = 'hud';
const VIEW_CHARGING = 'charging';
const VIEW_COUNTDOWN = 'countdown';
const VIEW_NOTIFICATION = 'notification';
const VIEW_EXPANDED_MEDIA = 'expanded_media';
const VIEW_EXPANDED_RECORD = 'expanded_record';
const VIEW_CONTROL_CENTER = 'control_center';

export default class DynamicIslandExtension extends Extension {
    enable() {
        console.log('[DynamicIsland] Mengaktifkan iOS Pro Native Design System...');

        this._settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
        this._originalShowBanners = this._settings.get_boolean('show-banners');
        this._settings.set_boolean('show-banners', false);

        if (Main.messageTray._bannerBin) {
            Main.messageTray._bannerBin.hide();
        }

        // ================= APPLE HIG PRECISE GEOMETRY =================
        this._topMargin = 2;
        this._idleWidth = 128;
        this._collapsedHeight = 30;
        this._compactMediaWidth = 174;
        this._compactRecordWidth = 154;
        this._compactDlWidth = 280;
        this._dlHeight = 46;

        this._wsWidth = 186;
        this._vpnWidth = 206;
        this._hudWidth = 196;
        this._chargingWidth = 206;
        this._bluetoothWidth = 214;
        this._mountWidth = 274;

        // Expanded States (Apple Now Playing Squircle 370x160pt)
        this._mediaExpandedWidth = 370;
        this._mediaExpandedHeight = 160;
        this._notifWidth = 372;
        this._notifHeight = 82;
        this._recordExpandedHeight = 88;
        this._countdownWidth = this._idleWidth;

        // visionOS Control Center
        this._ccExpandedWidth = 382;
        this._ccExpandedHeight = 366;

        // ================= STATE MANAGEMENT =================
        this._currentView = VIEW_IDLE;
        this._isExpanded = false;
        this._isControlCenterOpen = false;

        this._currentMedia = null;
        this._mediaActive = false;
        this._currentDownload = null;
        this._currentMount = null;
        this._countdownNumber = 3;

        this._notificationQueue = [];
        this._isProcessingQueue = false;
        this._currentNotification = null;
        this._waitingForMouseLeave = false;

        // Timers
        this._bannerDismissId = null;
        this._autoCollapseId = null;
        this._unhoverTimeoutId = null;
        this._countdownTickId = null;
        this._clockTickId = null;
        this._recordPulseId = null;
        this._pauseTimeoutId = null;
        this._dlCompletedTimeoutId = null;
        this._isDraggingSeek = false;
        this._coverCache = new Map();

        this._monitor = Main.layoutManager.primaryMonitor;
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._monitor = Main.layoutManager.primaryMonitor;
            this._reposition(this._getCurrentPillWidth());
        });

        // ================= NATIVE OLED PILL CONTAINER =================
        this._island = new St.BoxLayout({
            style_class: 'dynamic-island-pill',
            reactive: true,
            track_hover: true,
            visible: true,
            opacity: 255,
            width: this._idleWidth,
            height: this._collapsedHeight,
            vertical: false,
            clip_to_allocation: false, // Nonaktifkan agar tidak ada scissor-clip kotak
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._island.set_pivot_point(0.5, 0.0);

        // Views Registry
        this._allViews = new Map();

        this._initIdleView();
        this._initWorkspaceView();
        this._initCompactMediaView();
        this._initCompactDownloadView();
        this._initCompactRecordView();
        this._initMountView();
        this._initVpnView();
        this._initBluetoothView();
        this._initHudView();
        this._initChargingView();
        this._initCountdownView();
        this._initNotificationView();
        this._initExpandedMediaView();
        this._initExpandedRecordView();
        this._initControlCenterView();

        Main.uiGroup.add_child(this._island);
        this._reposition(this._idleWidth);

        // Core Subsystems
        this._cc = new ControlCenterManager(() => this._syncControlCenterUI());
        this._media = new MediaWatcher(state => this._onMediaUpdate(state));
        this._battery = new BatteryWatcher(event => this._onBatteryEvent(event));
        this._bluetooth = new BluetoothWatcher(event => this._onBluetoothConnected(event));
        this._privacy = new PrivacyWatcher(state => this._onPrivacyState(state));
        this._recorder = new ScreenRecordWatcher({
            onRecordingStarted: () => this._onRecordingStarted(),
            onRecordingStopped: () => this._onRecordingStopped(),
            onTick: data => this._onRecordingTick(data),
        });
        this._wsWatcher = new WorkspaceWatcher(data => this._onWorkspaceChanged(data));
        this._mountWatcher = new MountWatcher({
            onDriveMounted: data => this._onDriveMounted(data),
            onDriveRemoved: name => this._onDriveRemoved(name),
        });
        this._dlWatcher = new DownloadWatcher(data => this._onDownloadProgress(data));
        this._vpnWatcher = new VpnWatcher(data => this._onVpnChanged(data));

        // Notifications
        this._sourceConnections = new Map();
        Main.messageTray.getSources().forEach(s => this._connectSource(s));
        this._sourceAddedId = Main.messageTray.connect('source-added', (_t, s) => this._connectSource(s));
        this._sourceRemovedId = Main.messageTray.connect('source-removed', (_t, s) => this._disconnectSource(s));

        // Hooks & Tickers
        this._hookOsd();
        this._setupMouseEvents();
        this._startClockAndWave();

        // Boot View
        this._setView(VIEW_IDLE);
    }

    // ================= STATE & SQUIRCLE CLASS SWITCHER =================
    _setView(viewName) {
        this._currentView = viewName;

        for (const [name, actor] of this._allViews.entries()) {
            if (name === viewName) {
                actor.show();
                actor.visible = true;
                actor.opacity = 255; // Pastikan paksa terlihat
            } else {
                actor.hide();
                actor.visible = false;
                actor.opacity = 0;
            }
        }
    }

    _restoreBestView() {
        if (this._isControlCenterOpen) {
            this._setView(VIEW_CONTROL_CENTER);
            return;
        }

        let targetView = VIEW_IDLE;
        let targetWidth = this._idleWidth;
        let targetHeight = this._collapsedHeight;

        // Prioritas: Perekaman Layar > Musik > Jam
        if (this._recorder?.isRecording) {
            targetView = VIEW_COMPACT_RECORD;
            targetWidth = this._compactRecordWidth;
        } else if (this._mediaActive && this._currentMedia) {
            targetView = VIEW_COMPACT_MEDIA;
            targetWidth = this._compactMediaWidth;
        }

        this._isExpanded = false;
        this._setView(targetView);
        this._repositionAndResize(targetWidth, targetHeight, 300);
    }

    _getCurrentPillWidth() {
        switch (this._currentView) {
            case VIEW_WORKSPACE: return this._wsWidth;
            case VIEW_MOUNT: return this._mountWidth;
            case VIEW_VPN: return this._vpnWidth;
            case VIEW_BT: return this._bluetoothWidth;
            case VIEW_HUD: return this._hudWidth;
            case VIEW_CHARGING: return this._chargingWidth;
            case VIEW_COUNTDOWN: return this._countdownWidth;
            case VIEW_NOTIFICATION: return this._notifWidth;
            case VIEW_EXPANDED_MEDIA: return this._mediaExpandedWidth;
            case VIEW_EXPANDED_RECORD: return this._mediaExpandedWidth;
            case VIEW_CONTROL_CENTER: return this._ccExpandedWidth;
            case VIEW_COMPACT_RECORD: return this._compactRecordWidth;
            case VIEW_COMPACT_DL: return this._compactDlWidth;
            case VIEW_COMPACT_MEDIA: return this._compactMediaWidth;
            default: return this._idleWidth;
        }
    }

    _initIdleView() {
        this._privacyBox = new St.BoxLayout({
            style_class: 'dynamic-island-privacy-box',
            vertical: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._cameraDot = new St.Widget({ style_class: 'dynamic-island-privacy-dot dot-camera', visible: false, y_align: Clutter.ActorAlign.CENTER });
        this._micDot = new St.Widget({ style_class: 'dynamic-island-privacy-dot dot-mic', visible: false, y_align: Clutter.ActorAlign.CENTER });
        this._privacyBox.add_child(this._cameraDot);
        this._privacyBox.add_child(this._micDot);

        this._idleClockLabel = new St.Label({
            style_class: 'dynamic-island-idle-clock',
            text: this._getFormattedTime(),
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._idleClockLabel.clutter_text.ellipsize = 0;

        this._idleLeftSpacer = new St.Widget({ style_class: 'dynamic-island-idle-spacer', visible: false });

        this._idleBox = new St.BoxLayout({
            style_class: 'dynamic-island-idle-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
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
        this._allViews.set(VIEW_IDLE, this._idleBox);
    }

    _initWorkspaceView() {
        this._wsBox = new St.BoxLayout({
            style_class: 'dynamic-island-ws-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Icon grid bernuansa Apple System Blue
        this._wsIcon = new St.Icon({
            icon_name: 'view-grid-symbolic',
            icon_size: 14,
            style_class: 'dynamic-island-ws-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Label teks Workspace
        this._wsLabel = new St.Label({
            style_class: 'dynamic-island-ws-label',
            text: 'Desk 1',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Container Dots Pagination di sisi kanan ala iOS
        this._wsDotsBox = new St.BoxLayout({
            style_class: 'dynamic-island-ws-dots-box',
            vertical: false,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        this._wsBox.add_child(this._wsIcon);
        this._wsBox.add_child(this._wsLabel);
        this._wsBox.add_child(this._wsDotsBox);

        this._island.add_child(this._wsBox);
        this._allViews.set(VIEW_WORKSPACE, this._wsBox);
    }

    _onWorkspaceChanged({ index, totalWorkspaces, name }) {
        if (this._isControlCenterOpen || this._isExpanded) return;
        if (this._bannerDismissId) GLib.source_remove(this._bannerDismissId);

        this._wsDotsBox.destroy_all_children();
        const total = Math.min(6, Math.max(2, totalWorkspaces || 4));

        // Buat dot pagination ala iOS (Aktif = Kapsul lonjong lebar 14px, Inaktif = Bulat 5px)
        for (let i = 1; i <= total; i++) {
            const isCurrent = (i === index);
            const dot = new St.Widget({
                style_class: isCurrent ? 'dynamic-island-ws-dot-active' : 'dynamic-island-ws-dot',
                width: isCurrent ? 14 : 5,
                height: 5,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._wsDotsBox.add_child(dot);
        }
        this._wsLabel.set_text(name);

        this._setView(VIEW_WORKSPACE);
        this._repositionAndResize(this._wsWidth, this._collapsedHeight, 320, Clutter.AnimationMode.EASE_OUT_CUBIC);

        // Tampilkan selama 1.3 detik lalu kembali otomatis (responsif ala iOS HUD)
        this._bannerDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1300, () => {
            this._bannerDismissId = null;
            this._restoreBestView();
            return GLib.SOURCE_REMOVE;
        });
    }

    _initCompactDownloadView() {
        this._dlBox = new St.BoxLayout({
            style_class: 'dynamic-island-dl-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._dlIconBin = new St.Bin({
            style_class: 'dynamic-island-dl-icon-bin',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'folder-download-symbolic',
                icon_size: 15,
                style_class: 'dynamic-island-dl-icon',
            }),
        });

        this._dlTextCol = new St.BoxLayout({
            style_class: 'dynamic-island-dl-text-col',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dlStatusLabel = new St.Label({
            style_class: 'dynamic-island-dl-status',
            text: 'DOWNLOADING',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dlNameLabel = new St.Label({
            style_class: 'dynamic-island-dl-name',
            text: 'File',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dlNameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._dlTextCol.add_child(this._dlStatusLabel);
        this._dlTextCol.add_child(this._dlNameLabel);

        this._dlProgressBox = new St.BoxLayout({
            style_class: 'dynamic-island-dl-progress-box',
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dlTrackBin = new St.Bin({
            style_class: 'dynamic-island-dl-track',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dlFill = new St.Widget({
            style_class: 'dynamic-island-dl-fill',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.FILL,
            width: 8,
        });
        this._dlTrackBin.set_child(this._dlFill);

        this._dlPercentLabel = new St.Label({
            style_class: 'dynamic-island-dl-percent',
            text: '0%',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dlProgressBox.add_child(this._dlTrackBin);
        this._dlProgressBox.add_child(this._dlPercentLabel);

        this._dlCompleteBin = new St.Bin({
            style_class: 'dynamic-island-dl-complete-bin',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
            child: new St.Icon({
                icon_name: 'object-select-symbolic',
                icon_size: 14,
                style_class: 'dynamic-island-dl-checkmark',
            }),
        });

        this._dlBox.add_child(this._dlIconBin);
        this._dlBox.add_child(this._dlTextCol);
        this._dlBox.add_child(this._dlProgressBox);
        this._dlBox.add_child(this._dlCompleteBin);

        this._island.add_child(this._dlBox);
        this._allViews.set(VIEW_COMPACT_DL, this._dlBox);
    }

    _showDownloadComplete(fileName) {
        if (this._dlCompletedTimeoutId) {
            GLib.source_remove(this._dlCompletedTimeoutId);
            this._dlCompletedTimeoutId = null;
        }

        this._dlStatusLabel.set_text('Downloaded');
        this._dlNameLabel.set_text(fileName || 'File');
        this._dlProgressBox.visible = false;
        this._dlCompleteBin.visible = true;

        this._setView(VIEW_COMPACT_DL);
        this._repositionAndResize(this._compactDlWidth, this._dlHeight, 320, Clutter.AnimationMode.EASE_OUT_CUBIC);

        this._dlCompletedTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3500, () => {
            this._dlCompletedTimeoutId = null;
            this._currentDownload = null;
            this._dlProgressBox.visible = true;
            this._dlCompleteBin.visible = false;
            this._restoreBestView();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onDownloadProgress(data) {
        if (!data) {
            if (this._currentDownload && !this._dlCompletedTimeoutId) {
                const lastFile = this._currentDownload.filename || this._currentDownload.name || 'File';
                this._showDownloadComplete(lastFile);
            } else if (!this._dlCompletedTimeoutId) {
                if (this._currentView === VIEW_COMPACT_DL) this._restoreBestView();
            }
            return;
        }

        if (this._dlCompletedTimeoutId) {
            GLib.source_remove(this._dlCompletedTimeoutId);
            this._dlCompletedTimeoutId = null;
        }

        this._currentDownload = data;

        const fileName = data.filename || data.name || data.title || 'File';
        let rawPct = 0;
        if (data.percentage !== undefined && data.percentage !== null) {
            rawPct = data.percentage;
        } else if (data.progress !== undefined && data.progress !== null) {
            rawPct = data.progress <= 1 ? data.progress * 100 : data.progress;
        } else if (data.pct !== undefined) {
            rawPct = data.pct;
        }

        const pct = Math.min(100, Math.max(0, Math.round(rawPct)));
        const isComplete = data.isCompleted || data.complete || data.done || data.status === 'completed' || pct >= 100;

        if (isComplete) {
            this._showDownloadComplete(fileName);
            return;
        }

        this._dlStatusLabel.set_text('Downloading');
        this._dlNameLabel.set_text(fileName);
        this._dlPercentLabel.set_text(`${pct}%`);
        this._dlProgressBox.visible = true;
        this._dlCompleteBin.visible = false;

        const trackW = 54;
        this._dlFill.width = Math.max(4, Math.round((pct / 100) * trackW));

        if (!this._isExpanded && !this._isControlCenterOpen &&
            this._currentView !== VIEW_WORKSPACE &&
            this._currentView !== VIEW_MOUNT &&
            this._currentView !== VIEW_VPN &&
            this._currentView !== VIEW_HUD &&
            this._currentView !== VIEW_CHARGING &&
            this._currentView !== VIEW_BT) {
            this._setView(VIEW_COMPACT_DL);
            this._repositionAndResize(this._compactDlWidth, this._dlHeight, 320, Clutter.AnimationMode.EASE_OUT_CUBIC);
        }
    }

    _initCompactRecordView() {
        this._compactRecordBox = new St.BoxLayout({
            style_class: 'dynamic-island-compact-record',
            vertical: false,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
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

        this._compactRecordBox.add_child(this._recordDot);
        this._compactRecordBox.add_child(this._compactRecordLabel);
        this._island.add_child(this._compactRecordBox);
        this._allViews.set(VIEW_COMPACT_RECORD, this._compactRecordBox);
    }

    _initCompactMediaView() {
        this._compactBox = new St.BoxLayout({ style_class: 'dynamic-island-compact', vertical: false, x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._compactIcon = new St.Icon({ icon_size: 18, icon_name: 'audio-x-generic-symbolic' });
        this._compactArtBin = new St.Bin({ style_class: 'dynamic-island-compact-art', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER, child: this._compactIcon });

        this._waveBars = [];
        this._waveBox = new St.BoxLayout({ style_class: 'dynamic-island-wave', vertical: false, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER, x_expand: true });
        for (let i = 0; i < 4; i++) {
            const bar = new St.Widget({ style_class: 'dynamic-island-wave-bar', width: 3, height: 6, y_align: Clutter.ActorAlign.CENTER });
            this._waveBars.push(bar);
            this._waveBox.add_child(bar);
        }
        this._compactBox.add_child(this._compactArtBin);
        this._compactBox.add_child(this._waveBox);
        this._island.add_child(this._compactBox);
        this._allViews.set(VIEW_COMPACT_MEDIA, this._compactBox);
    }

    _initExpandedMediaView() {
        this._mediaContent = new St.BoxLayout({ style_class: 'dynamic-island-media-content', vertical: true, x_expand: true, y_expand: true, reactive: true });

        this._topRow = new St.BoxLayout({ style_class: 'dynamic-island-media-top-row', vertical: false, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._mediaIcon = new St.Icon({ icon_size: 54, icon_name: 'audio-x-generic-symbolic' });
        this._mediaArtBin = new St.Bin({ style_class: 'dynamic-island-media-art', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, child: this._mediaIcon });

        this._textInfo = new St.BoxLayout({ style_class: 'dynamic-island-track-info', vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._titleLabel = new St.Label({ style_class: 'dynamic-island-title', text: '', y_align: Clutter.ActorAlign.CENTER });
        this._bodyLabel = new St.Label({ style_class: 'dynamic-island-artist', text: '', y_align: Clutter.ActorAlign.CENTER });
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._bodyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._textInfo.add_child(this._titleLabel);
        this._textInfo.add_child(this._bodyLabel);

        this._headerWaveBars = [];
        this._headerWaveBox = new St.BoxLayout({ style_class: 'dynamic-island-header-wave', vertical: false, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER });
        for (let i = 0; i < 4; i++) {
            const bar = new St.Widget({ style_class: 'dynamic-island-wave-bar', width: 3.5, height: 8, y_align: Clutter.ActorAlign.CENTER });
            this._headerWaveBars.push(bar);
            this._headerWaveBox.add_child(bar);
        }

        this._topRow.add_child(this._mediaArtBin);
        this._topRow.add_child(this._textInfo);
        this._topRow.add_child(this._headerWaveBox);
        this._mediaContent.add_child(this._topRow);

        this._progressSection = new St.BoxLayout({ style_class: 'dynamic-island-progress-section', vertical: true, x_expand: true });
        this._progressTrack = new St.Widget({ style_class: 'dynamic-island-progress-track', x_expand: true, y_align: Clutter.ActorAlign.CENTER, reactive: true });
        this._progressFill = new St.Widget({ style_class: 'dynamic-island-progress-fill', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.FILL, reactive: false, width: 8 });
        this._progressTrack.add_child(this._progressFill);

        this._timeRow = new St.BoxLayout({ style_class: 'dynamic-island-time-row', vertical: false, x_expand: true });
        this._timeLabel = new St.Label({ style_class: 'dynamic-island-time', text: '0:00' });
        this._durationLabel = new St.Label({ style_class: 'dynamic-island-time', text: '-0:00', x_align: Clutter.ActorAlign.END, x_expand: true });
        this._timeRow.add_child(this._timeLabel);
        this._timeRow.add_child(this._durationLabel);
        this._progressSection.add_child(this._progressTrack);
        this._progressSection.add_child(this._timeRow);
        this._mediaContent.add_child(this._progressSection);

        this._controlsRow = new St.BoxLayout({ style_class: 'dynamic-island-controls-row', vertical: false, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true });
        this._prevBtn = new St.Button({ style_class: 'dynamic-island-ctrl-btn', child: new St.Icon({ icon_name: 'media-skip-backward-symbolic', icon_size: 20 }), can_focus: true, reactive: true });
        this._playBtn = new St.Button({ style_class: 'dynamic-island-ctrl-btn dynamic-island-play-btn', child: new St.Icon({ icon_name: 'media-playback-start-symbolic', icon_size: 28 }), can_focus: true, reactive: true });
        this._nextBtn = new St.Button({ style_class: 'dynamic-island-ctrl-btn', child: new St.Icon({ icon_name: 'media-skip-forward-symbolic', icon_size: 20 }), can_focus: true, reactive: true });
        this._controlsRow.add_child(this._prevBtn);
        this._controlsRow.add_child(this._playBtn);
        this._controlsRow.add_child(this._nextBtn);
        this._mediaContent.add_child(this._controlsRow);

        this._island.add_child(this._mediaContent);
        this._allViews.set(VIEW_EXPANDED_MEDIA, this._mediaContent);
    }

    _toSeconds(val) {
        if (!val || isNaN(val)) return 0;
        return val > 100000 ? Math.floor(val / 1000000) : Math.floor(val);
    }

    _formatTime(secs) {
        const s = Math.max(0, Math.floor(secs));
        const mins = Math.floor(s / 60);
        const remSecs = s % 60;
        return `${mins}:${remSecs < 10 ? '0' : ''}${remSecs}`;
    }

    _updateMediaProgress() {
        if (!this._currentMedia || !this._mediaActive) return;

        // Ambil durasi total (length) dan posisi saat ini (pos)
        const duration = this._currentMedia.length || 0; // dalam mikrodetik
        const pos = this._media?.getPosition() ?? 0;    // dalam mikrodetik

        if (duration <= 0) return;

        // Konversi ke detik untuk Label waktu
        const durSecs = Math.floor(duration / 1000000);
        const posSecs = Math.floor(pos / 1000000);
        const remSecs = Math.max(0, durSecs - posSecs);

        // Update Label Waktu (0:00)
        if (this._timeLabel) this._timeLabel.set_text(this._formatTime(posSecs));
        if (this._durationLabel) {
            this._durationLabel.set_text(durSecs > 0 ? `-${this._formatTime(remSecs)}` : '0:00');
        }

        // Update Panjang Progress Fill (Putih)
        // Hitung rasio (0.0 sampai 1.0)
        const ratio = Math.clamp(pos / duration, 0, 1);
        
        // Pastikan track bar memiliki lebar sebelum menghitung fill
        const trackWidth = this._progressTrack.get_width() || 330; 
        
        // Update lebar secara real-time
        this._progressFill.set_width(Math.max(6, Math.floor(trackWidth * ratio)));

        // SINKRONISASI UNTUK CONTROL CENTER (Jika sedang dibuka)
        if (this._isControlCenterOpen) {
            const ccTrackWidth = this._ccScrubTrack.get_width() || 180;
            this._ccScrubFill.set_width(Math.max(16, Math.floor(ccTrackWidth * ratio)));
        }
    }

    _initExpandedRecordView() {
        this._recordExpandedBox = new St.BoxLayout({ style_class: 'dynamic-island-record-expanded', vertical: false, x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER, reactive: true });
        this._recordTextCol = new St.BoxLayout({ style_class: 'dynamic-island-record-text-col', vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._recordSubLabelRow = new St.BoxLayout({ style_class: 'dynamic-island-record-sub-label-row', vertical: false, y_align: Clutter.ActorAlign.CENTER });
        this._recordExpandedDot = new St.Widget({ style_class: 'dynamic-island-record-dot dynamic-island-record-dot-mini', y_align: Clutter.ActorAlign.CENTER });
        this._recordSubLabel = new St.Label({ style_class: 'dynamic-island-record-sub-label', text: 'RECORDING', y_align: Clutter.ActorAlign.CENTER });
        this._recordSubLabelRow.add_child(this._recordExpandedDot);
        this._recordSubLabelRow.add_child(this._recordSubLabel);

        this._recordBigLabel = new St.Label({ style_class: 'dynamic-island-record-big-label', text: '00:00', y_align: Clutter.ActorAlign.CENTER });
        this._recordTextCol.add_child(this._recordSubLabelRow);
        this._recordTextCol.add_child(this._recordBigLabel);

        this._recordStopBtn = new St.Button({ style_class: 'dynamic-island-record-stop-btn', child: new St.Icon({ icon_name: 'media-playback-stop-symbolic', icon_size: 16 }), can_focus: true, reactive: true, y_align: Clutter.ActorAlign.CENTER });
        this._recordExpandedBox.add_child(this._recordTextCol);
        this._recordExpandedBox.add_child(this._recordStopBtn);

        this._island.add_child(this._recordExpandedBox);
        this._allViews.set(VIEW_EXPANDED_RECORD, this._recordExpandedBox);
    }

    _initControlCenterView() {
        this._controlCenterBox = new St.BoxLayout({ style_class: 'dynamic-island-cc-box', vertical: true, x_expand: true, y_expand: true, reactive: true });

        this._ccHeaderRow = new St.BoxLayout({ style_class: 'dynamic-island-cc-header', vertical: false, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._ccBtnClose = new St.Button({ style_class: 'dynamic-island-cc-close', child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 13 }), can_focus: true, y_align: Clutter.ActorAlign.CENTER });
        this._ccBtnClose.connect('clicked', () => this._collapse());
        this._ccTitle = new St.Label({ style_class: 'dynamic-island-cc-title', text: 'Control Center', x_expand: true, y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.CENTER });
        const ccHeaderRightSpacer = new St.Widget({ width: 32, height: 32 });

        this._ccHeaderRow.add_child(this._ccBtnClose);
        this._ccHeaderRow.add_child(this._ccTitle);
        this._ccHeaderRow.add_child(ccHeaderRightSpacer);
        this._controlCenterBox.add_child(this._ccHeaderRow);

        this._ccTopRow = new St.BoxLayout({ style_class: 'dynamic-island-cc-top-row', vertical: false, x_expand: true });
        this._ccClusterLayout = new Clutter.GridLayout({ column_spacing: 10, row_spacing: 10, column_homogeneous: true, row_homogeneous: true });
        this._ccCluster = new St.Widget({ style_class: 'dynamic-island-cc-cluster', layout_manager: this._ccClusterLayout, y_align: Clutter.ActorAlign.FILL });

        this._ccBtnWifi = new St.Button({ style_class: 'dynamic-island-cc-circle-btn', child: new St.Icon({ icon_name: 'network-wireless-signal-excellent-symbolic', icon_size: 18 }), can_focus: true });
        // Klik Kiri: Menyalakan/Mematikan Wi-Fi
        this._ccBtnWifi.connect('clicked', () => {
            this._cc.toggleWifi();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => { this._syncControlCenterUI(); return GLib.SOURCE_REMOVE; });
        });
        // Klik Kanan: Langsung membuka pemindai & daftar Wi-Fi sekitar bawaan GNOME
        this._ccBtnWifi.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === 3) {
                this._collapse();
                this._cc.openWifiSettings();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._ccBtnBt = new St.Button({ style_class: 'dynamic-island-cc-circle-btn', child: new St.Icon({ icon_name: 'bluetooth-active-symbolic', icon_size: 18 }), can_focus: true });
        this._ccBtnBt.connect('clicked', () => { this._cc.toggleBluetooth(); GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => { this._syncControlCenterUI(); return GLib.SOURCE_REMOVE; }); });

        this._ccPowerIcon = new St.Icon({ icon_name: 'power-profile-balanced-symbolic', icon_size: 18 });
        this._ccBtnPower = new St.Button({ style_class: 'dynamic-island-cc-circle-btn', child: this._ccPowerIcon, can_focus: true });
        this._ccBtnPower.connect('clicked', () => {
            this._cc.togglePowerMode();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => { this._syncControlCenterUI(); return GLib.SOURCE_REMOVE; });
        });

        this._ccBtnAirplane = new St.Button({ style_class: 'dynamic-island-cc-circle-btn', child: new St.Icon({ icon_name: 'airplane-mode-symbolic', icon_size: 18 }), can_focus: true });
        this._ccBtnAirplane.connect('clicked', () => { this._cc.toggleAirplaneMode(); GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => { this._syncControlCenterUI(); return GLib.SOURCE_REMOVE; }); });

        this._ccClusterLayout.attach(this._ccBtnWifi, 0, 0, 1, 1);
        this._ccClusterLayout.attach(this._ccBtnBt, 1, 0, 1, 1);
        this._ccClusterLayout.attach(this._ccBtnPower, 0, 1, 1, 1);
        this._ccClusterLayout.attach(this._ccBtnAirplane, 1, 1, 1, 1);
        this._ccTopRow.add_child(this._ccCluster);

        this._ccMediaBox = new St.BoxLayout({ style_class: 'dynamic-island-cc-media', vertical: true, x_expand: true });
        this._ccMediaTopRow = new St.BoxLayout({ style_class: 'dynamic-island-cc-media-row', vertical: false, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._ccMediaArt = new St.Icon({ icon_size: 46, icon_name: 'audio-x-generic-symbolic', style_class: 'dynamic-island-cc-media-art' });
        this._ccMediaInfo = new St.BoxLayout({ style_class: 'dynamic-island-cc-media-info', vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._ccMediaTitle = new St.Label({ style_class: 'dynamic-island-cc-media-title', text: 'Tidak Ada Media', y_align: Clutter.ActorAlign.CENTER });
        this._ccMediaTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._ccMediaArtist = new St.Label({ style_class: 'dynamic-island-cc-media-artist', text: 'Siap memutar musik', y_align: Clutter.ActorAlign.CENTER });
        this._ccMediaArtist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._ccMediaInfo.add_child(this._ccMediaTitle);
        this._ccMediaInfo.add_child(this._ccMediaArtist);

        this._ccPlayBtn = new St.Button({ style_class: 'dynamic-island-cc-play-btn', child: new St.Icon({ icon_name: 'media-playback-start-symbolic', icon_size: 16 }), can_focus: true, y_align: Clutter.ActorAlign.CENTER });
        this._ccPlayBtn.connect('clicked', () => this._media?.togglePlayPause());
        this._ccMediaTopRow.add_child(this._ccMediaArt);
        this._ccMediaTopRow.add_child(this._ccMediaInfo);
        this._ccMediaTopRow.add_child(this._ccPlayBtn);

        this._ccScrubTrack = new St.Widget({ style_class: 'dynamic-island-cc-scrub', x_expand: true, y_align: Clutter.ActorAlign.CENTER, reactive: true });
        this._ccScrubFill = new St.Widget({ style_class: 'dynamic-island-cc-scrub-fill', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.FILL, width: 60 });
        this._ccScrubTrack.add_child(this._ccScrubFill);

        this._ccMediaBox.add_child(this._ccMediaTopRow);
        this._ccMediaBox.add_child(this._ccScrubTrack);
        this._ccTopRow.add_child(this._ccMediaBox);
        this._controlCenterBox.add_child(this._ccTopRow);

        this._ccBottomGrid = new Clutter.GridLayout({ column_spacing: 10, row_spacing: 10, column_homogeneous: true, row_homogeneous: true });
        this._ccGridContainer = new St.Widget({ layout_manager: this._ccBottomGrid, x_expand: true });

        const makeSqBtn = (iconName, onClick) => {
            const btn = new St.Button({ style_class: 'dynamic-island-cc-sq-btn', child: new St.Icon({ icon_name: iconName, icon_size: 20 }), can_focus: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
            if (onClick) btn.connect('clicked', onClick);
            return btn;
        };

        this._sqBtnNight = makeSqBtn('night-light-symbolic', () => { this._cc.toggleNightLight(); this._syncControlCenterUI(); });
        this._sqBtnDark = makeSqBtn('weather-clear-night-symbolic', () => { this._cc.toggleDarkMode(); this._syncControlCenterUI(); });
        this._sqBtnRecord = makeSqBtn('media-record-symbolic', () => { this._collapse(); this._cc.openScreenshot(); });
        this._sqBtnScreenshot = makeSqBtn('camera-photo-symbolic', () => { this._collapse(); this._cc.openScreenshot(); });
        this._sqBtnLock = makeSqBtn('system-lock-screen-symbolic', () => { this._collapse(); this._cc.lockScreen(); });
        this._sqBtnSearch = makeSqBtn('system-search-symbolic', () => { this._collapse(); Main.overview.show(); });
        this._sqBtnSettings = makeSqBtn('preferences-system-symbolic', () => { this._collapse(); this._cc.openSettings(); });
        this._sqBtnShutdown = makeSqBtn('system-shutdown-symbolic', () => { this._collapse(); this._cc.openPowerMenu(); });

        this._ccBottomGrid.attach(this._sqBtnNight, 0, 0, 1, 1);
        this._ccBottomGrid.attach(this._sqBtnDark, 1, 0, 1, 1);
        this._ccBottomGrid.attach(this._sqBtnRecord, 2, 0, 1, 1);
        this._ccBottomGrid.attach(this._sqBtnScreenshot, 3, 0, 1, 1);
        this._ccBottomGrid.attach(this._sqBtnLock, 0, 1, 1, 1);
        this._ccBottomGrid.attach(this._sqBtnSearch, 1, 1, 1, 1);
        this._ccBottomGrid.attach(this._sqBtnSettings, 2, 1, 1, 1);
        this._ccBottomGrid.attach(this._sqBtnShutdown, 3, 1, 1, 1);

        this._controlCenterBox.add_child(this._ccGridContainer);
        this._island.add_child(this._controlCenterBox);
        this._allViews.set(VIEW_CONTROL_CENTER, this._controlCenterBox);
    }

    _initMountView() {
        this._mountBox = new St.BoxLayout({ style_class: 'dynamic-island-mount-box', vertical: false, x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._mountIconBin = new St.Bin({ style_class: 'dynamic-island-mount-icon-bin', child: new St.Icon({ icon_name: 'drive-removable-media-symbolic', icon_size: 14 }) });
        this._mountTextCol = new St.BoxLayout({ style_class: 'dynamic-island-mount-text-col', vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._mountTitle = new St.Label({ style_class: 'dynamic-island-mount-title', text: 'USB Drive' });
        this._mountTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._mountSubtitle = new St.Label({ style_class: 'dynamic-island-mount-subtitle', text: 'Tersedia' });
        this._mountTextCol.add_child(this._mountTitle);
        this._mountTextCol.add_child(this._mountSubtitle);

        this._mountEjectBtn = new St.Button({ style_class: 'dynamic-island-mount-eject-btn', child: new St.Icon({ icon_name: 'media-eject-symbolic', icon_size: 12 }), y_align: Clutter.ActorAlign.CENTER, can_focus: true });
        this._mountEjectBtn.connect('clicked', () => {
            if (this._currentMount?.mount) {
                this._mountWatcher.eject(this._currentMount.mount, (ok) => {
                    this._mountSubtitle.set_text(ok ? 'Aman Dicabut ✓' : 'Gagal Eject');
                    this._mountEjectBtn.visible = false;
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1400, () => { this._restoreBestView(); return GLib.SOURCE_REMOVE; });
                });
            }
        });

        this._mountBox.add_child(this._mountIconBin);
        this._mountBox.add_child(this._mountTextCol);
        this._mountBox.add_child(this._mountEjectBtn);
        this._island.add_child(this._mountBox);
        this._allViews.set(VIEW_MOUNT, this._mountBox);
    }

    _initNotificationView() {
        this._notifBox = new St.BoxLayout({ style_class: 'dynamic-island-notif-box', vertical: false, x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER, reactive: true });
        this._notifIcon = new St.Icon({ icon_size: 38, icon_name: 'dialog-information-symbolic' });
        this._notifIconBin = new St.Bin({ style_class: 'dynamic-island-notif-art', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, child: this._notifIcon });

        this._notifTextBox = new St.BoxLayout({ style_class: 'dynamic-island-notif-text-box', vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._notifHeaderRow = new St.BoxLayout({ vertical: false, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._notifTitle = new St.Label({ style_class: 'dynamic-island-notif-title', text: 'Pengirim', x_expand: true });
        this._notifTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._notifAppBadge = new St.Label({ style_class: 'dynamic-island-notif-badge', text: 'PESAN' });
        this._notifHeaderRow.add_child(this._notifTitle);
        this._notifHeaderRow.add_child(this._notifAppBadge);

        this._notifBody = new St.Label({ style_class: 'dynamic-island-notif-body', text: 'Isi teks pesan...' });
        this._notifBody.clutter_text.line_wrap = true;
        this._notifBody.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._notifBody.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._notifTextBox.add_child(this._notifHeaderRow);
        this._notifTextBox.add_child(this._notifBody);
        this._notifBox.add_child(this._notifIconBin);
        this._notifBox.add_child(this._notifTextBox);

        // Menangkap klik kiri pada area notifikasi
        this._notifBox.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === 1) {
                this._activateCurrentNotification();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._island.add_child(this._notifBox);
        this._allViews.set(VIEW_NOTIFICATION, this._notifBox);
    }

    _initVpnView() {
        this._vpnBox = new St.BoxLayout({
            style_class: 'dynamic-island-vpn-box',
            vertical: false,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._vpnIcon = new St.Icon({
            icon_name: 'channel-secure-symbolic',
            icon_size: 13,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._vpnIconBin = new St.Bin({
            style_class: 'dynamic-island-vpn-icon-bin connected',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            child: this._vpnIcon,
        });

        this._vpnNameLabel = new St.Label({
            style_class: 'dynamic-island-vpn-name',
            text: 'WARP',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._vpnNameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._vpnStatusLabel = new St.Label({
            style_class: 'dynamic-island-vpn-status connected',
            text: 'Connected',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });

        this._vpnBox.add_child(this._vpnIconBin);
        this._vpnBox.add_child(this._vpnNameLabel);
        this._vpnBox.add_child(this._vpnStatusLabel);

        this._island.add_child(this._vpnBox);
        this._allViews.set(VIEW_VPN, this._vpnBox);
    }

    _onVpnChanged({ name, isConnected }) {
        if (this._isControlCenterOpen) return;
        if (this._bannerDismissId) {
            GLib.source_remove(this._bannerDismissId);
            this._bannerDismissId = null;
        }

        const displayName = name || 'WARP';
        if (this._vpnNameLabel) {
            this._vpnNameLabel.set_text(displayName);
        }

        if (isConnected) {
            if (this._vpnIcon) this._vpnIcon.icon_name = 'channel-secure-symbolic';
            if (this._vpnIconBin) this._vpnIconBin.style_class = 'dynamic-island-vpn-icon-bin connected';
            if (this._vpnStatusLabel) {
                this._vpnStatusLabel.set_text('Connected');
                this._vpnStatusLabel.style_class = 'dynamic-island-vpn-status connected';
            }
        } else {
            if (this._vpnIcon) this._vpnIcon.icon_name = 'channel-insecure-symbolic';
            if (this._vpnIconBin) this._vpnIconBin.style_class = 'dynamic-island-vpn-icon-bin disconnected';
            if (this._vpnStatusLabel) {
                this._vpnStatusLabel.set_text('Disconnected');
                this._vpnStatusLabel.style_class = 'dynamic-island-vpn-status disconnected';
            }
        }

        this._setView(VIEW_VPN);
        this._repositionAndResize(this._vpnWidth, this._collapsedHeight, 320, Clutter.AnimationMode.EASE_OUT_CUBIC);

        this._bannerDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2600, () => {
            this._bannerDismissId = null;
            this._restoreBestView();
            return GLib.SOURCE_REMOVE;
        });
    }

    _initBluetoothView() {
        this._bluetoothBox = new St.BoxLayout({ style_class: 'dynamic-island-bt-box', vertical: false, x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._btIcon = new St.Icon({ icon_size: 14, icon_name: 'audio-headphones-symbolic', style_class: 'dynamic-island-bt-icon' });
        this._btIconBin = new St.Bin({ style_class: 'dynamic-island-bt-icon-bin', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, child: this._btIcon });
        this._btNameLabel = new St.Label({ style_class: 'dynamic-island-bt-name', text: 'AirPods', y_align: Clutter.ActorAlign.CENTER, x_expand: true });
        this._btNameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._btRightBox = new St.BoxLayout({ style_class: 'dynamic-island-bt-right', vertical: false, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER });
        this._btPercentLabel = new St.Label({ style_class: 'dynamic-island-bt-percent', text: '100%', y_align: Clutter.ActorAlign.CENTER, visible: false });
        this._btBatteryShell = new St.Widget({ style_class: 'dynamic-island-battery-shell', y_align: Clutter.ActorAlign.CENTER, visible: false });
        this._btBatteryFill = new St.Widget({ style_class: 'dynamic-island-battery-fill', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.FILL });
        this._btBatteryCap = new St.Widget({ style_class: 'dynamic-island-battery-cap', y_align: Clutter.ActorAlign.CENTER, visible: false });
        this._btBatteryShell.add_child(this._btBatteryFill);

        this._btStatusLabel = new St.Label({ style_class: 'dynamic-island-bt-status', text: 'Connected', y_align: Clutter.ActorAlign.CENTER });
        this._btRightBox.add_child(this._btStatusLabel);
        this._btRightBox.add_child(this._btPercentLabel);
        this._btRightBox.add_child(this._btBatteryShell);
        this._btRightBox.add_child(this._btBatteryCap);

        this._bluetoothBox.add_child(this._btIconBin);
        this._bluetoothBox.add_child(this._btNameLabel);
        this._bluetoothBox.add_child(this._btRightBox);
        this._island.add_child(this._bluetoothBox);
        this._allViews.set(VIEW_BT, this._bluetoothBox);
    }

    _initHudView() {
        this._hudBox = new St.BoxLayout({ style_class: 'dynamic-island-hud-box', vertical: false, x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._hudIcon = new St.Icon({ style_class: 'dynamic-island-hud-icon', icon_size: 15, y_align: Clutter.ActorAlign.CENTER });
        this._hudSliderTrack = new St.Widget({ style_class: 'dynamic-island-hud-track', x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._hudSliderFill = new St.Widget({ style_class: 'dynamic-island-hud-fill', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.FILL });
        this._hudSliderTrack.add_child(this._hudSliderFill);
        this._hudBox.add_child(this._hudIcon);
        this._hudBox.add_child(this._hudSliderTrack);
        this._island.add_child(this._hudBox);
        this._allViews.set(VIEW_HUD, this._hudBox);
    }

    _initChargingView() {
        this._chargingBox = new St.BoxLayout({ style_class: 'dynamic-island-charging-box', vertical: false, x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._chargingLabel = new St.Label({ style_class: 'dynamic-island-charging-label', text: 'Charging', y_align: Clutter.ActorAlign.CENTER });
        this._chargingRightBox = new St.BoxLayout({ style_class: 'dynamic-island-charging-right', vertical: false, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER, x_expand: true });
        this._chargingPercentLabel = new St.Label({ style_class: 'dynamic-island-charging-percent', text: '100%', y_align: Clutter.ActorAlign.CENTER });
        this._batteryShell = new St.Widget({ style_class: 'dynamic-island-battery-shell', y_align: Clutter.ActorAlign.CENTER });
        this._batteryFill = new St.Widget({ style_class: 'dynamic-island-battery-fill', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.FILL });
        this._batteryCap = new St.Widget({ style_class: 'dynamic-island-battery-cap', y_align: Clutter.ActorAlign.CENTER });
        this._batteryShell.add_child(this._batteryFill);
        this._chargingBolt = new St.Label({ style_class: 'dynamic-island-charging-bolt', text: '⚡', y_align: Clutter.ActorAlign.CENTER });

        this._chargingRightBox.add_child(this._chargingPercentLabel);
        this._chargingRightBox.add_child(this._chargingBolt);
        this._chargingRightBox.add_child(this._batteryShell);
        this._chargingRightBox.add_child(this._batteryCap);
        this._chargingBox.add_child(this._chargingLabel);
        this._chargingBox.add_child(this._chargingRightBox);
        this._island.add_child(this._chargingBox);
        this._allViews.set(VIEW_CHARGING, this._chargingBox);
    }

    _initCountdownView() {
        this._countdownBox = new St.Bin({ style_class: 'dynamic-island-countdown-box', x_expand: true, y_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        this._countdownLabel = new St.Label({ style_class: 'dynamic-island-countdown-label', text: '3', y_align: Clutter.ActorAlign.CENTER });
        this._countdownBox.set_child(this._countdownLabel);
        this._island.add_child(this._countdownBox);
        this._allViews.set(VIEW_COUNTDOWN, this._countdownBox);
    }

    _onDriveMounted(data) {
        if (this._isControlCenterOpen) return;
        if (this._bannerDismissId) GLib.source_remove(this._bannerDismissId);

        this._currentMount = data;
        this._mountTitle.set_text(data.name);
        this._mountSubtitle.set_text(data.freeSpace || 'Drive Terhubung');
        this._mountEjectBtn.visible = true;

        this._setView(VIEW_MOUNT);
        this._repositionAndResize(this._mountWidth, this._collapsedHeight, 320, Clutter.AnimationMode.EASE_OUT_CUBIC);

        this._bannerDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3800, () => {
            this._bannerDismissId = null;
            if (!this._island.hover) this._restoreBestView();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onDriveRemoved(name) {
        if (this._isControlCenterOpen) return;
        this._mountTitle.set_text(name || 'Drive');
        this._mountSubtitle.set_text('Terputus');
        this._mountEjectBtn.visible = false;
        this._setView(VIEW_MOUNT);
        this._repositionAndResize(this._mountWidth, this._collapsedHeight, 320, Clutter.AnimationMode.EASE_OUT_CUBIC);

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => {
            this._restoreBestView();
            return GLib.SOURCE_REMOVE;
        });
    }

    _connectSource(source) {
        if (this._sourceConnections.has(source)) return;
        const id = source.connect('notification-added', (_s, n) => this._onNotification(n));
        this._sourceConnections.set(source, id);
    }

    _disconnectSource(source) {
        if (this._sourceConnections.has(source)) {
            try { source.disconnect(this._sourceConnections.get(source)); } catch (_) { }
            this._sourceConnections.delete(source);
        }
    }

    _onNotification(notification) {
        this._notificationQueue.push(notification);
        this._processQueue();
    }

    _processQueue() {
        if (this._isProcessingQueue || this._notificationQueue.length === 0 || this._isControlCenterOpen) return;

        this._isProcessingQueue = true;
        this._currentNotification = this._notificationQueue.shift();
        this._waitingForMouseLeave = false;

        const n = this._currentNotification;
        this._notifTitle.set_text(n.title || 'Notifikasi');
        this._notifBody.set_text(n.body || '');

        const sourceName = n.source?.title || n.source?.name || '';
        this._notifAppBadge.set_text(sourceName ? sourceName.toUpperCase() : 'PESAN');

        if (n.gicon) this._setNotifIcon({ gicon: n.gicon });
        else if (n.icon_name) this._setNotifIcon({ iconName: n.icon_name });
        else this._setNotifIcon({ iconName: 'dialog-information-symbolic' });

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
        this._setView(VIEW_NOTIFICATION);
        this._repositionAndResize(this._notifWidth, this._notifHeight, 340, Clutter.AnimationMode.EASE_OUT_CUBIC);

        if (this._autoCollapseId) GLib.source_remove(this._autoCollapseId);
        this._autoCollapseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4500, () => {
            this._autoCollapseId = null;
            if (this._island.hover) {
                this._waitingForMouseLeave = true;
            } else {
                this._isProcessingQueue = false;
                this._restoreBestView();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _activateCurrentNotification() {
        const n = this._currentNotification;
        if (!n) return;

        const source = n.source;

        // 1. Jalankan aktivasi aksi bawaan notifikasi GNOME
        try {
            if (typeof n.activate === 'function') {
                n.activate();
            }
        } catch (_) { }

        // 2. Buka jendela aplikasi sumber pengirim notifikasi
        try {
            if (source) {
                if (typeof source.open === 'function') {
                    source.open();
                } else if (source.app && typeof source.app.activate === 'function') {
                    source.app.activate();
                }
            }
        } catch (_) { }

        // 3. Langsung tutup/kembalikan Dynamic Island ke tampilan normal
        if (this._autoCollapseId) {
            GLib.source_remove(this._autoCollapseId);
            this._autoCollapseId = null;
        }
        this._isProcessingQueue = false;
        this._waitingForMouseLeave = false;
        this._restoreBestView();
    }

    _expandControlCenter() {
        this._isExpanded = true;
        this._isControlCenterOpen = true;
        this._syncControlCenterUI();

        this._setView(VIEW_CONTROL_CENTER);
        this._repositionAndResize(this._ccExpandedWidth, this._ccExpandedHeight, 340, Clutter.AnimationMode.EASE_OUT_CUBIC);
    }

    _collapse() {
        this._isExpanded = false;
        this._isControlCenterOpen = false;
        this._restoreBestView();
    }

    _onBluetoothConnected({ name, icon, battery }) {
        if (this._isControlCenterOpen) return;
        if (this._bannerDismissId) GLib.source_remove(this._bannerDismissId);

        this._btNameLabel.set_text(name || 'Bluetooth Device');
        this._btIcon.icon_name = icon || 'audio-headphones-symbolic';

        if (battery !== null && battery !== undefined && battery >= 0) {
            this._btStatusLabel.visible = false;
            this._btPercentLabel.set_text(`${battery}%`);
            this._btPercentLabel.visible = true;
            this._btBatteryFill.width = Math.max(2, Math.floor((battery / 100) * 18));
            this._btBatteryShell.visible = true;
            this._btBatteryCap.visible = true;
        } else {
            this._btPercentLabel.visible = false;
            this._btBatteryShell.visible = false;
            this._btBatteryCap.visible = false;
            this._btStatusLabel.visible = true;
        }

        this._setView(VIEW_BT);
        this._repositionAndResize(this._bluetoothWidth, this._collapsedHeight, 320, Clutter.AnimationMode.EASE_OUT_CUBIC);

        this._bannerDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2800, () => {
            this._bannerDismissId = null;
            this._restoreBestView();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onBatteryEvent({ isCharging, percentage }) {
        if (!isCharging || this._isControlCenterOpen) return;
        if (this._bannerDismissId) GLib.source_remove(this._bannerDismissId);

        this._chargingLabel.set_text('Charging');
        this._chargingPercentLabel.set_text(`${percentage}%`);
        this._batteryFill.width = Math.max(2, Math.floor((percentage / 100) * 18));

        this._setView(VIEW_CHARGING);
        this._repositionAndResize(this._chargingWidth, this._collapsedHeight, 320, Clutter.AnimationMode.EASE_OUT_CUBIC);

        this._bannerDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._bannerDismissId = null;
            this._restoreBestView();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hookOsd() {
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
                this._showOsdInIsland({ icon, iconName, level, maxLevel, isVolume });
                return;
            }
            this._origOsdShow(monitorIndex, icon, label, level, maxLevel);
        };
    }

    _showOsdInIsland({ icon, iconName, level, maxLevel, isVolume }) {
        if (this._isControlCenterOpen) return;
        if (this._bannerDismissId) GLib.source_remove(this._bannerDismissId);

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

        this._hudSliderFill.width = isMuted ? 0 : Math.round(136 * ratio);

        this._setView(VIEW_HUD);
        this._repositionAndResize(this._hudWidth, this._collapsedHeight, 320, Clutter.AnimationMode.EASE_OUT_CUBIC);

        this._bannerDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => {
            this._bannerDismissId = null;
            this._restoreBestView();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onRecordingStarted() {
        this._countdownNumber = 3;
        this._countdownLabel.set_text('3');
        this._setView(VIEW_COUNTDOWN);
        this._repositionAndResize(this._countdownWidth, this._collapsedHeight, 320, Clutter.AnimationMode.EASE_OUT_CUBIC);

        this._countdownTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
            this._countdownNumber--;
            if (this._countdownNumber > 0) {
                this._countdownLabel.set_text(String(this._countdownNumber));
                return GLib.SOURCE_CONTINUE;
            } else {
                this._countdownTickId = null;
                this._setView(VIEW_COMPACT_RECORD);
                this._repositionAndResize(this._compactRecordWidth, this._collapsedHeight, 320, Clutter.AnimationMode.EASE_OUT_CUBIC);
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
        this._stopRecordPulse();
        this._restoreBestView();
    }

    _startRecordPulse() {
        this._stopRecordPulse();
        let dim = false;
        this._recordPulseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 650, () => {
            dim = !dim;
            const target = dim ? 80 : 255;
            this._recordDot?.ease({ opacity: target, duration: 500, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE });
            this._recordExpandedDot?.ease({ opacity: target, duration: 500, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE });
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

    _onMediaUpdate(state) {
        this._currentMedia = state;

        // 1. Jika tidak ada musik atau player mati
        if (!state || state.status === 'Stopped') {
            this._mediaActive = false;
            // Jika saat ini sedang menampilkan musik, kembalikan ke jam (idle)
            if (this._currentView === VIEW_COMPACT_MEDIA || this._currentView === VIEW_EXPANDED_MEDIA) {
                this._restoreBestView();
            }
            this._syncControlCenterUI();
            return;
        }

        // 2. Tandai musik sebagai aktif (Playing maupun Paused)
        this._mediaActive = true;

        // 3. Update Label & Gambar (Art)
        this._titleLabel.set_text(state.title || 'Unknown Title');
        this._bodyLabel.set_text(state.artist || 'Unknown Artist');
        this._loadCoverArt(state.artUrl);

        // 4. Update Icon Play/Pause di mode expanded
        const playIcon = (state.status === 'Playing') ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        if (this._playBtn && this._playBtn.child) {
            this._playBtn.child.icon_name = playIcon;
        }

        // 5. LOGIKA PEMAKSA TAMPILAN
        // Jika tidak sedang dalam mode besar (Expanded/Control Center)
        if (!this._isExpanded && !this._isControlCenterOpen) {
            // Tampilkan musik jika: Island sedang idle, ATAU sedang menampilkan musik tapi butuh refresh
            if (this._currentView === VIEW_IDLE || this._currentView === VIEW_COMPACT_MEDIA) {
                this._setView(VIEW_COMPACT_MEDIA);
                this._repositionAndResize(this._compactMediaWidth, this._collapsedHeight, 300);
            }
        }

        this._updateMediaProgress();
        this._syncControlCenterUI();
    }

    _syncControlCenterUI() {
        if (!this._cc) return;
        if (this._cc.isDarkMode()) this._sqBtnDark.add_style_class_name('on'); else this._sqBtnDark.remove_style_class_name('on');
        if (this._cc.isNightLight()) this._sqBtnNight.add_style_class_name('on'); else this._sqBtnNight.remove_style_class_name('on');


        // 1. Sinkronisasi Wi-Fi (Ikon & Status Aktif)
        const isWifiOn = this._cc.isWifiEnabled();
        if (isWifiOn) {
            this._ccBtnWifi.add_style_class_name('on');
            this._ccBtnWifi.child.icon_name = 'network-wireless-signal-excellent-symbolic';
        } else {
            this._ccBtnWifi.remove_style_class_name('on');
            this._ccBtnWifi.child.icon_name = 'network-wireless-disabled-symbolic';
        }

        if (this._cc.isBluetoothEnabled()) this._ccBtnBt.add_style_class_name('on'); else this._ccBtnBt.remove_style_class_name('on');
        if (this._cc.isAirplaneMode()) this._ccBtnAirplane.add_style_class_name('on'); else this._ccBtnAirplane.remove_style_class_name('on');

        // Sinkronisasi Power Profile
        const pMode = this._cc.getPowerProfile();
        if (pMode === 'Performance') {
            this._ccPowerIcon.icon_name = 'power-profile-performance-symbolic';
            this._ccBtnPower.add_style_class_name('on');
        } else if (pMode === 'Power Saver') {
            this._ccPowerIcon.icon_name = 'power-profile-power-saver-symbolic';
            this._ccBtnPower.add_style_class_name('on');
        } else {
            this._ccPowerIcon.icon_name = 'power-profile-balanced-symbolic';
            this._ccBtnPower.remove_style_class_name('on');
        }

        if (this._currentMedia && this._currentMedia.status !== 'Stopped') {
            this._ccMediaTitle.set_text(this._currentMedia.title || 'Sedang Diputar');
            this._ccMediaArtist.set_text(this._currentMedia.artist || 'Tidak Diketahui');
            this._ccPlayBtn.child.icon_name = (this._currentMedia.status === 'Playing') ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            const duration = this._currentMedia.length || 0;
            if (duration > 0) {
                const pos = this._media?.getPosition() ?? 0;
                const ratio = Math.max(0, Math.min(1, pos / duration));
                const trackW = this._ccScrubTrack.width || 180;
                this._ccScrubFill.width = Math.max(16, Math.floor(trackW * ratio));
            }
        } else {
            this._ccMediaTitle.set_text('Tidak Ada Media');
            this._ccMediaArtist.set_text('Siap memutar musik');
            this._ccPlayBtn.child.icon_name = 'media-playback-start-symbolic';
            this._ccScrubFill.width = 30;
        }
    }

    _loadCoverArt(url) {
        if (!url) { this._setMediaIcon({ iconName: 'audio-x-generic-symbolic' }); return; }
        if (url.startsWith('file://')) {
            try {
                const path = Gio.File.new_for_uri(url).get_path();
                const pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 128, 128, false);
                this._setMediaIcon({ pixbuf: pb });
            } catch (_) { this._setMediaIcon({ iconName: 'audio-x-generic-symbolic' }); }
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
                if (this._currentMedia?.artUrl === url) this._setMediaIcon({ pixbuf: pb });
            } catch (_) { }
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
            } catch (_) { }
        }
        this._mediaIcon.icon_name = iconName || 'audio-x-generic-symbolic';
        this._compactIcon.icon_name = iconName || 'audio-x-generic-symbolic';
        this._ccMediaArt.icon_name = iconName || 'audio-x-generic-symbolic';
    }

    _animateWaves() {
        // Pola variasi tinggi gelombang dinamis layaknya visualizer iOS
        const heightsCompact = [
            Math.floor(Math.random() * 10) + 4,
            Math.floor(Math.random() * 12) + 4,
            Math.floor(Math.random() * 10) + 4,
            Math.floor(Math.random() * 8)  + 4,
        ];

        const heightsExpanded = [
            Math.floor(Math.random() * 12) + 4,
            Math.floor(Math.random() * 16) + 5,
            Math.floor(Math.random() * 14) + 4,
            Math.floor(Math.random() * 10) + 4,
        ];

        // Animasikan bar di mode Compact (Pill kecil)
        if (this._waveBars) {
            this._waveBars.forEach((bar, i) => {
                bar.ease({
                    height: heightsCompact[i],
                    duration: 130,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                });
            });
        }

        // Animasikan bar di mode Expanded (Pop-up lebar kanan atas lagu)
        if (this._headerWaveBars) {
            this._headerWaveBars.forEach((bar, i) => {
                bar.ease({
                    height: heightsExpanded[i],
                    duration: 130,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                });
            });
        }
    }

    _resetWaves() {
        // Kembalikan semua bar ke tinggi minimal (flat) saat musik di-pause/stop
        if (this._waveBars) {
            this._waveBars.forEach(bar => {
                bar.ease({
                    height: 4,
                    duration: 180,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            });
        }
        if (this._headerWaveBars) {
            this._headerWaveBars.forEach(bar => {
                bar.ease({
                    height: 4,
                    duration: 180,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            });
        }
    }

    _setupMouseEvents() {
        this._island.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === 3) {
                if (this._isControlCenterOpen) this._collapse();
                else this._expandControlCenter();
                return Clutter.EVENT_STOP;
            }
            // Jika user mengklik kiri saat notifikasi sedang tampil
            if (event.get_button() === 1 && this._currentView === VIEW_NOTIFICATION) {
                this._activateCurrentNotification();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._island.connect('notify::hover', () => {
            if (this._currentView === VIEW_HUD || this._currentView === VIEW_CHARGING || this._currentView === VIEW_BT || this._currentView === VIEW_COUNTDOWN) return;
            const hovering = this._island.hover;
            if (hovering) {
                if (this._unhoverTimeoutId) { GLib.source_remove(this._unhoverTimeoutId); this._unhoverTimeoutId = null; }
                if (this._isControlCenterOpen) return;

                if (!this._isExpanded && !this._isProcessingQueue) {
                    if (this._recorder?.isRecording) {
                        this._isExpanded = true;
                        this._setView(VIEW_EXPANDED_RECORD);
                        this._repositionAndResize(this._mediaExpandedWidth, this._recordExpandedHeight, 340, Clutter.AnimationMode.EASE_OUT_CUBIC);
                    } else if (this._mediaActive) {
                        this._isExpanded = true;
                        this._setView(VIEW_EXPANDED_MEDIA);
                        this._repositionAndResize(this._mediaExpandedWidth, this._mediaExpandedHeight, 340, Clutter.AnimationMode.EASE_OUT_CUBIC);
                        this._updateMediaProgress();
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
                            this._isProcessingQueue = false;
                            this._restoreBestView();
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
        this._recordStopBtn.connect('clicked', () => this._recorder.stopRecordingSession());
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
        if (this._idleClockLabel) this._idleClockLabel.set_text(this._getFormattedTime());
    }

    _startClockAndWave() {
        this._updateClock();
        
        // Ticker Utama (Berjalan setiap 1 detik)
        this._clockTickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            
            if (this._mediaActive && this._currentMedia) {
                this._updateMediaProgress();
            }
            return GLib.SOURCE_CONTINUE;
        });

        // Ticker Animasi Wave (Berjalan setiap 150ms)
        this._wavesAreReset = false;
        this._waveTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            if (this._mediaActive && this._currentMedia?.status === 'Playing') {
                this._wavesAreReset = false;
                this._animateWaves(); // Jalankan bar goyang naik-turun
            } else if (!this._wavesAreReset) {
                this._wavesAreReset = true;
                this._resetWaves();   // Kembalikan ke posisi datar saat jeda
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _reposition(width) {
        if (!this._island || !this._monitor) return;
        const x = this._monitor.x + Math.floor((this._monitor.width - width) / 2);
        const y = this._monitor.y + this._topMargin;
        this._island.set_position(x, y);
    }

    _repositionAndResize(width, height, duration = 320, mode = Clutter.AnimationMode.EASE_OUT_CUBIC) {
        const targetX = this._monitor.x + Math.floor((this._monitor.width - width) / 2);
        const targetY = this._monitor.y + this._topMargin;
        this._island.ease({ width, height, x: targetX, y: targetY, duration, mode });
    }

    disable() {
        if (this._clockTickId) GLib.source_remove(this._clockTickId);
        if (this._waveTickId) GLib.source_remove(this._waveTickId);
        if (this._bannerDismissId) GLib.source_remove(this._bannerDismissId);
        if (this._autoCollapseId) GLib.source_remove(this._autoCollapseId);
        if (this._unhoverTimeoutId) GLib.source_remove(this._unhoverTimeoutId);
        if (this._countdownTickId) GLib.source_remove(this._countdownTickId);
        if (this._recordPulseId) GLib.source_remove(this._recordPulseId);
        if (this._pauseTimeoutId) GLib.source_remove(this._pauseTimeoutId);
        if (this._dlCompletedTimeoutId) GLib.source_remove(this._dlCompletedTimeoutId);

        if (this._origOsdShow) Main.osdWindowManager.show = this._origOsdShow;
        if (this._settings) {
            this._settings.set_boolean('show-banners', this._originalShowBanners);
            this._settings = null;
        }
        if (Main.messageTray._bannerBin) Main.messageTray._bannerBin.show();
        if (this._monitorsChangedId) Main.layoutManager.disconnect(this._monitorsChangedId);
        if (this._sourceAddedId) Main.messageTray.disconnect(this._sourceAddedId);
        if (this._sourceRemovedId) Main.messageTray.disconnect(this._sourceRemovedId);

        for (const [source, id] of this._sourceConnections) {
            try { source.disconnect(id); } catch (_) { }
        }
        this._sourceConnections.clear();

        if (this._cc) this._cc.destroy();
        if (this._recorder) this._recorder.destroy();
        if (this._privacy) this._privacy.destroy();
        if (this._bluetooth) this._bluetooth.destroy();
        if (this._battery) this._battery.destroy();
        if (this._media) this._media.destroy();
        if (this._wsWatcher) this._wsWatcher.destroy();
        if (this._mountWatcher) this._mountWatcher.destroy();
        if (this._dlWatcher) this._dlWatcher.destroy();
        if (this._vpnWatcher) this._vpnWatcher.destroy();
        if (this._island) this._island.destroy();
    }
}