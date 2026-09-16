import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { MediaWatcher } from './src/mpris.js';
import { BatteryWatcher } from './src/battery.js';
import { BluetoothWatcher } from './src/bluetooth.js';
import { PrivacyWatcher } from './src/privacy.js';
import { ScreenRecordWatcher } from './src/recorder.js';
import { ControlCenterManager } from './src/controlCenter.js';
import { WorkspaceWatcher } from './src/workspace.js';
import { MountWatcher } from './src/mount.js';
import { DownloadWatcher } from './src/download.js';
import { VpnWatcher } from './src/vpn.js';
import { PopupQueue } from './src/popupQueue.js';

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

        this._preferences = this.getSettings();
        this._popupQueue = new PopupQueue();
        this._testTimers = new Set();
        this._realPrivacyState = {camera: false, mic: false};
        this._settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.notifications' });
        this._originalShowBanners = this._settings.get_boolean('show-banners');
        if (this._featureEnabled('notifications')) this._settings.set_boolean('show-banners', false);

        if (this._featureEnabled('notifications') && Main.messageTray._bannerBin) {
            Main.messageTray._bannerBin.hide();
        }

        // ================= APPLE HIG PRECISE GEOMETRY =================
        this._topMargin = this._preferences.get_int('top-offset');
        this._idleWidth = 128;
        this._privacyExtraWidth = 0;
        this._collapsedHeight = 30;
        this._compactMediaWidth = 174;
        this._compactRecordWidth = 154;
        this._compactDlWidth = 210;
        this._dlHeight = 30;

        this._wsWidth = 186;
        this._vpnWidth = 206;
        this._hudWidth = 196;
        this._chargingWidth = 206;
        this._bluetoothWidth = 250;
        this._pendingBluetoothEvent = null;
        this._mountWidth = 280;

        // Expanded States (Apple Now Playing Squircle 370x160pt)
        this._mediaExpandedWidth = 370;
        this._mediaExpandedHeight = 160;
        this._notifWidth = 372;
        this._notifHeight = 94;
        this._recordExpandedHeight = 88;
        this._countdownWidth = this._idleWidth;

        // visionOS Control Center
        this._ccExpandedWidth = 382;
        this._ccExpandedHeight = 450;

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
        this._mediaPausedHidden = false;
        this._mediaIntroTimeoutId = null;
        this._mediaIntroMarker = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'dynamic-island-mpris-intro']);
        this._mediaBootId = '';
        this._mediaIntroShown = false;
        try {
            const [, bootBytes] = GLib.file_get_contents('/proc/sys/kernel/random/boot_id');
            this._mediaBootId = new TextDecoder().decode(bootBytes).trim();
            const [, markerBytes] = GLib.file_get_contents(this._mediaIntroMarker);
            this._mediaIntroShown = new TextDecoder().decode(markerBytes) === this._mediaBootId;
        } catch (_) { }
        this._dlCompletedTimeoutId = null;
        this._dlCollapseTimeoutId = null;
        this._dlExpanded = false;
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
        this._island.set_pivot_point(0, 0);
        this._island.set_scale(this._preferences.get_double('island-scale'), this._preferences.get_double('island-scale'));

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

        this._initPrivacyOverlay();
        this._preferencesChangedId = this._preferences.connect('changed', (_settings, key) => this._applyPreferences(key));
        this._initTestService();

        // Core Subsystems
        this._cc = new ControlCenterManager(() => this._syncControlCenterUI());
        this._media = new MediaWatcher(state => this._onMediaUpdate(state));
        this._battery = new BatteryWatcher(event => this._onBatteryEvent(event));
        this._bluetooth = new BluetoothWatcher(event => this._onBluetoothConnected(event));
        this._privacy = this._featureEnabled('privacy') ? new PrivacyWatcher(state => this._onPrivacyState(state)) : null;
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
        this._dlWatcher = this._featureEnabled('download') ? new DownloadWatcher(data => this._onDownloadProgress(data)) : null;
        this._vpnWatcher = this._featureEnabled('vpn') ? new VpnWatcher(data => this._onVpnChanged(data)) : null;

        // Notifications
        this._sourceConnections = new Map();
        this._notificationConnections = new Map();
        this._destroyedNotifications = new WeakSet();
        Main.messageTray.getSources().forEach(s => this._connectSource(s));
        this._sourceAddedId = Main.messageTray.connect('source-added', (_t, s) => this._connectSource(s));
        this._sourceRemovedId = Main.messageTray.connect('source-removed', (_t, s) => this._disconnectSource(s));

        // Hooks & Tickers
        this._hookOsd();
        this._setupMouseEvents();
        this._startClockAndWave();

        // Boot View
        this._restoreBestView();
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

        if (this._notificationQueue.length) {
            this._processQueue();
            return;
        }

        const nextPopup = this._popupQueue.next();
        if (nextPopup) {
            this._isExpanded = false;
            nextPopup();
            if (this._popupQueue.active) return;
            this._restoreBestView();
            return;
        }

        if (this._pendingBluetoothEvent) {
            const event = this._pendingBluetoothEvent;
            this._pendingBluetoothEvent = null;
            this._isExpanded = false;
            this._onBluetoothConnected(event);
            return;
        }

        let targetView = VIEW_IDLE;
        let targetWidth = this._idleWidth + this._privacyExtraWidth;
        let targetHeight = this._collapsedHeight;

        // Prioritas: Perekaman Layar > Musik > Jam
        if (this._featureEnabled('recording') && this._recorder?.isRecording) {
            targetView = VIEW_COMPACT_RECORD;
            targetWidth = this._compactRecordWidth;
        } else if (this._currentDownload) {
            targetView = VIEW_COMPACT_DL;
            targetWidth = this._compactDlWidth;
            targetHeight = this._dlHeight;
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
            default: return this._idleWidth + this._privacyExtraWidth;
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
        // Privacy is rendered separately so every view retains its indicators.

        this._island.add_child(this._idleBox);
        this._allViews.set(VIEW_IDLE, this._idleBox);
    }

    _utilityGlyph(path) {
        return new Gio.BytesIcon({bytes: new GLib.Bytes(new TextEncoder().encode(
            `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="${path}" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`))});
    }

    // Only workspace, VPN and mount use this brief popup transition.
    _showUtilityPopup(view, actor, width, height, duration) {
        if (this._bannerDismissId) GLib.source_remove(this._bannerDismissId);
        if (this._currentView !== view) {
            this._setView(view);
            actor.clip_to_allocation = true;
            actor.remove_all_transitions();
            actor.opacity = 0;
            this._repositionAndResize(width, height, 280, Clutter.AnimationMode.EASE_OUT_CUBIC);
            actor.ease({opacity: 255, delay: 100, duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this._bannerDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._preferences.get_int('popup-duration'), () => {
            this._bannerDismissId = null;
            if (this._currentView === view) this._restoreBestView();
            return GLib.SOURCE_REMOVE;
        });
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
            gicon: this._utilityGlyph('M3 5h7v14H3Z M14 5h7v14h-7Z'),
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
        if (!this._admitPopup('workspace', 30, () => this._onWorkspaceChanged({index, totalWorkspaces, name}))) return;
        if (this._isControlCenterOpen) return;
        if (this._bannerDismissId) GLib.source_remove(this._bannerDismissId);

        this._wsDotsBox.destroy_all_children();
        const count = Math.max(1, totalWorkspaces || 1);
        const total = Math.min(6, count);
        const first = Math.max(1, Math.min(index - 2, count - total + 1));

        // Buat dot pagination ala iOS (Aktif = Kapsul lonjong lebar 14px, Inaktif = Bulat 5px)
        for (let i = 1; i <= total; i++) {
            const isCurrent = (first + i - 1 === index);
            const dot = new St.Widget({
                style_class: isCurrent ? 'dynamic-island-ws-dot-active' : 'dynamic-island-ws-dot',
                width: isCurrent ? 14 : 5,
                height: 5,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._wsDotsBox.add_child(dot);
        }
        this._wsLabel.set_text(name);

        this._showUtilityPopup(VIEW_WORKSPACE, this._wsBox, this._wsWidth, this._collapsedHeight, 1300);
    }

    _initCompactDownloadView() {
        // Rounded monoline glyphs, independent of the desktop icon theme.
        const glyph = path => new Gio.BytesIcon({bytes: new GLib.Bytes(
            new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="${path}" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`))});
        this._dlArrowIcon = glyph('M12 4v12 M7.5 11.5 12 16l4.5-4.5 M5 18v2h14v-2');
        this._dlDoneIcon = glyph('m5.5 12 4.5 4.5 8.5-9');
        this._dlIcon = new St.Icon({gicon: this._dlArrowIcon, icon_size: 18,
            style_class: 'dynamic-island-dl-icon', y_align: Clutter.ActorAlign.CENTER});
        this._dlBox = new St.BoxLayout({style_class: 'dynamic-island-dl-box',
            x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._dlContentCol = new St.BoxLayout({vertical: true, x_expand: true,
            style_class: 'dynamic-island-dl-content-col', y_align: Clutter.ActorAlign.CENTER});
        const row = new St.BoxLayout({x_expand: true, style_class: 'dynamic-island-dl-top-row'});
        this._dlStatusLabel = new St.Label({text: 'Mengunduh', x_expand: true,
            style_class: 'dynamic-island-dl-status', y_align: Clutter.ActorAlign.CENTER});
        this._dlPercentLabel = new St.Label({text: '',
            style_class: 'dynamic-island-dl-percent', y_align: Clutter.ActorAlign.CENTER});
        this._dlNameLabel = new St.Label({text: '', visible: false,
            style_class: 'dynamic-island-dl-name'});
        this._dlNameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        row.add_child(this._dlStatusLabel);
        row.add_child(this._dlPercentLabel);
        this._dlContentCol.add_child(row);
        this._dlContentCol.add_child(this._dlNameLabel);
        this._dlBox.add_child(this._dlIcon);
        this._dlBox.add_child(this._dlContentCol);
        this._island.add_child(this._dlBox);
        this._allViews.set(VIEW_COMPACT_DL, this._dlBox);
    }

    _canShowDownload() {
        return !this._isExpanded && !this._isControlCenterOpen &&
            [VIEW_IDLE, VIEW_COMPACT_MEDIA, VIEW_COMPACT_DL].includes(this._currentView);
    }

    _setDownloadExpanded(expanded) {
        this._dlExpanded = expanded;
        this._compactDlWidth = expanded ? 300 : 210;
        this._dlHeight = expanded ? 64 : this._collapsedHeight;
        this._dlNameLabel.visible = expanded;
        this._dlBox.style_class = expanded ? 'dynamic-island-dl-box expanded' : 'dynamic-island-dl-box';
        if (this._currentView === VIEW_COMPACT_DL)
            this._repositionAndResize(this._compactDlWidth, this._dlHeight, 280);
    }

    _cancelDownloadCollapse() {
        if (this._dlCollapseTimeoutId) GLib.source_remove(this._dlCollapseTimeoutId);
        this._dlCollapseTimeoutId = null;
    }

    _onDownloadProgress(data) {
        if (!this._featureEnabled('download')) data = null;
        if (!data) {
            if (this._dlCompletedTimeoutId) return;
            this._cancelDownloadCollapse();
            this._currentDownload = null;
            this._setDownloadExpanded(false);
            if (this._currentView === VIEW_COMPACT_DL) this._restoreBestView();
            return;
        }
        const starting = !this._currentDownload || this._currentDownload.isCompleted;
        if (this._dlCompletedTimeoutId) {
            GLib.source_remove(this._dlCompletedTimeoutId);
            this._dlCompletedTimeoutId = null;
        }
        this._currentDownload = data;
        if (data.isCompleted) {
            this._showDownloadComplete(data.filename);
            return;
        }
        this._dlStatusLabel.set_text(data.waiting ? 'Menunggu' :
            data.activeCount > 1 ? `${data.activeCount} unduhan` : 'Mengunduh');
        this._dlNameLabel.set_text(data.filename || 'File');
        this._dlPercentLabel.set_text(Number.isFinite(data.percentage)
            ? `${Math.floor(Math.min(100, Math.max(0, data.percentage)))}%`
            : Number.isFinite(data.size) ? GLib.format_size(data.size) : '');
        this._dlIcon.gicon = this._dlArrowIcon;
        if (starting) {
            this._cancelDownloadCollapse();
            this._setDownloadExpanded(true);
            // Progress callbacks must never restart this timer.
            this._dlCollapseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2200, () => {
                this._dlCollapseTimeoutId = null;
                this._setDownloadExpanded(false);
                return GLib.SOURCE_REMOVE;
            });
        }
        if (this._canShowDownload() && this._currentView !== VIEW_COMPACT_DL) {
            this._setView(VIEW_COMPACT_DL);
            this._repositionAndResize(this._compactDlWidth, this._dlHeight);
        }
    }

    _showDownloadComplete(fileName) {
        this._cancelDownloadCollapse();
        this._dlStatusLabel.set_text('Selesai');
        this._dlNameLabel.set_text(fileName || 'File');
        this._dlPercentLabel.set_text('');
        this._dlIcon.gicon = this._dlDoneIcon;
        this._setDownloadExpanded(false);
        if (this._canShowDownload()) {
            this._setView(VIEW_COMPACT_DL);
            this._repositionAndResize(this._compactDlWidth, this._dlHeight);
        }
        this._dlCompletedTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._dlCompletedTimeoutId = null;
            this._currentDownload = null;
            if (this._currentView === VIEW_COMPACT_DL) this._restoreBestView();
            return GLib.SOURCE_REMOVE;
        });
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
        this._mediaContent = new St.BoxLayout({ style_class: 'dynamic-island-media-content', clip_to_allocation: true, vertical: true, x_expand: true, y_expand: true, reactive: true });

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
        const mediaGlyph = path => new Gio.BytesIcon({bytes: new GLib.Bytes(new TextEncoder().encode(
            `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="${path}" fill="white" stroke="white" stroke-width="1.2" stroke-linejoin="round"/></svg>`))});
        this._mediaPlayGlyph = mediaGlyph('M7 4 20 12 7 20Z');
        this._mediaPauseGlyph = mediaGlyph('M6 4h4v16H6Z M14 4h4v16h-4Z');
        this._mediaPrevGlyph = mediaGlyph('M3 5h2v14H3Z M20 5 7 12l13 7Z');
        this._mediaNextGlyph = mediaGlyph('M19 5h2v14h-2Z M4 5l13 7-13 7Z');
        this._prevBtn = new St.Button({ style_class: 'dynamic-island-ctrl-btn', child: new St.Icon({ gicon: this._mediaPrevGlyph, icon_size: 20 }), can_focus: true, reactive: true });
        this._playBtn = new St.Button({ style_class: 'dynamic-island-ctrl-btn dynamic-island-play-btn', child: new St.Icon({ gicon: this._mediaPlayGlyph, icon_size: 28 }), can_focus: true, reactive: true });
        this._nextBtn = new St.Button({ style_class: 'dynamic-island-ctrl-btn', child: new St.Icon({ gicon: this._mediaNextGlyph, icon_size: 20 }), can_focus: true, reactive: true });
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
        this._controlCenterBox = new St.BoxLayout({ style_class: 'dynamic-island-cc-box', clip_to_allocation: true, vertical: true, x_expand: true, y_expand: true, reactive: true });

        this._ccHeaderRow = new St.BoxLayout({ style_class: 'dynamic-island-cc-header', vertical: false, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._ccBtnClose = new St.Button({ style_class: 'dynamic-island-cc-close', child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 13 }), can_focus: true, y_align: Clutter.ActorAlign.CENTER });
        this._ccBtnClose.connect('clicked', () => this._collapse());
        this._ccTitle = new St.Label({ style_class: 'dynamic-island-cc-title', text: 'Control Center', x_expand: true, y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.CENTER });
        const ccHeaderRightSpacer = new St.Widget({ width: 32, height: 32 });

        this._ccHeaderRow.add_child(this._ccBtnClose);
        this._ccHeaderRow.add_child(this._ccTitle);
        this._ccHeaderRow.add_child(ccHeaderRightSpacer);
        this._controlCenterBox.add_child(this._ccHeaderRow);

        this._ccTopRow = new St.BoxLayout({ style_class: 'dynamic-island-cc-top-row', vertical: true, x_expand: true });
        this._ccClusterLayout = new Clutter.GridLayout({ column_spacing: 10, row_spacing: 10, column_homogeneous: true, row_homogeneous: true });
        this._ccCluster = new St.Widget({ style_class: 'dynamic-island-cc-cluster', layout_manager: this._ccClusterLayout, y_align: Clutter.ActorAlign.FILL });

        this._ccBtnWifi = new St.Button({ style_class: 'dynamic-island-cc-circle-btn', child: new St.Icon({ icon_name: 'network-wireless-signal-excellent-symbolic', icon_size: 18 }), can_focus: true });
        // Klik Kiri: Menyalakan/Mematikan Wi-Fi
        this._ccBtnWifi.connect('clicked', () => {
            this._cc.toggleWifi();
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
        this._ccBtnBt.connect('clicked', () => { this._cc.toggleBluetooth(); });

        this._ccBtnAirplane = new St.Button({ style_class: 'dynamic-island-cc-circle-btn', child: new St.Icon({ icon_name: 'airplane-mode-symbolic', icon_size: 18 }), can_focus: true });
        this._ccBtnAirplane.connect('clicked', () => { this._cc.toggleAirplaneMode(); });

        this._ccWifiIcon = this._ccBtnWifi.child;
        for (const [button, text] of [[this._ccBtnWifi, 'Wi-Fi'], [this._ccBtnBt, 'Bluetooth'], [this._ccBtnAirplane, 'Pesawat']]) {
            const icon = button.child;
            button.set_child(null);
            const content = new St.BoxLayout({vertical: true, style_class: 'dynamic-island-cc-shortcut-content'});
            content.add_child(icon);
            content.add_child(new St.Label({text, style_class: 'dynamic-island-cc-shortcut-label'}));
            button.set_child(content);
            button.accessible_name = text;
        }
        this._ccClusterLayout.attach(this._ccBtnWifi, 0, 0, 1, 1);
        this._ccClusterLayout.attach(this._ccBtnBt, 1, 0, 1, 1);
        this._ccClusterLayout.attach(this._ccBtnAirplane, 2, 0, 1, 1);
        this._ccTopRow.add_child(this._ccCluster);
        const wifiRow = new St.BoxLayout({style_class: 'dynamic-island-cc-wifi-row', x_expand: true});
        this._ccWifiLabel = new St.Label({text: 'Wi-Fi', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'dynamic-island-cc-status-label'});
        this._ccWifiLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const wifiDetails = new St.Button({style_class: 'dynamic-island-cc-details',
            label: 'Jaringan  ›', accessible_name: 'Buka daftar jaringan Wi-Fi', can_focus: true});
        wifiDetails.connect('clicked', () => { this._collapse(); this._cc.openWifiSettings(); });
        wifiRow.add_child(this._ccWifiLabel);
        wifiRow.add_child(wifiDetails);
        this._ccTopRow.add_child(wifiRow);


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

        this._ccScrubTrack = new St.Widget({ style_class: 'dynamic-island-cc-scrub', x_expand: true, y_align: Clutter.ActorAlign.CENTER, reactive: false });
        this._ccScrubFill = new St.Widget({ style_class: 'dynamic-island-cc-scrub-fill', x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.FILL, width: 60 });
        this._ccScrubTrack.add_child(this._ccScrubFill);

        this._ccMediaBox.add_child(this._ccMediaTopRow);
        this._ccMediaBox.add_child(this._ccScrubTrack);
        this._ccTopRow.add_child(this._ccMediaBox);
        this._controlCenterBox.add_child(this._ccTopRow);

        this._ccPowerLabel = new St.Label({text: 'Mode daya · Memuat…', style_class: 'dynamic-island-cc-status-label'});
        this._controlCenterBox.add_child(this._ccPowerLabel);
        const powerRow = new St.BoxLayout({style_class: 'dynamic-island-cc-power-row', x_expand: true});
        this._ccPowerChoices = new Map();
        for (const [profile, label] of [['power-saver', 'Hemat'], ['balanced', 'Seimbang'], ['performance', 'Performa']]) {
            const button = new St.Button({label, style_class: 'dynamic-island-cc-profile',
                can_focus: true, x_expand: true, accessible_name: `Mode daya ${label}`});
            button.connect('clicked', () => this._cc.setPowerProfile(profile));
            this._ccPowerChoices.set(profile, button);
            powerRow.add_child(button);
        }
        this._controlCenterBox.add_child(powerRow);

        this._ccBottomGrid = new Clutter.GridLayout({column_spacing: 8, row_spacing: 8,
            column_homogeneous: true, row_homogeneous: true});
        this._ccGridContainer = new St.Widget({layout_manager: this._ccBottomGrid, x_expand: true});
        const shortcuts = [
            ['_sqBtnNight', 'night-light-symbolic', 'Lampu malam', () => this._cc.toggleNightLight()],
            ['_sqBtnDark', 'weather-clear-night-symbolic', 'Mode gelap', () => this._cc.toggleDarkMode()],
            ['_sqBtnScreenshot', 'camera-photo-symbolic', 'Tangkapan', () => {this._collapse(); this._cc.openScreenshot();}],
            ['_sqBtnLock', 'system-lock-screen-symbolic', 'Kunci', () => {this._collapse(); this._cc.lockScreen();}],
            ['_sqBtnSettings', 'preferences-system-symbolic', 'Pengaturan', () => {this._collapse(); this._cc.openSettings();}],
            ['_sqBtnShutdown', 'system-shutdown-symbolic', 'Daya', () => {this._collapse(); this._cc.openPowerMenu();}],
        ];
        shortcuts.forEach(([key, icon, label, action], i) => {
            const content = new St.BoxLayout({vertical: true, style_class: 'dynamic-island-cc-shortcut-content'});
            content.add_child(new St.Icon({icon_name: icon, icon_size: 18}));
            content.add_child(new St.Label({text: label, style_class: 'dynamic-island-cc-shortcut-label'}));
            const button = new St.Button({child: content, style_class: 'dynamic-island-cc-sq-btn',
                can_focus: true, accessible_name: label, x_expand: true});
            button.connect('clicked', action);
            this[key] = button;
            this._ccBottomGrid.attach(button, i % 3, Math.floor(i / 3), 1, 1);
        });
        this._controlCenterBox.add_child(this._ccGridContainer);
        this._island.add_child(this._controlCenterBox);
        this._allViews.set(VIEW_CONTROL_CENTER, this._controlCenterBox);
    }

    _initMountView() {
        this._mountBox = new St.BoxLayout({ style_class: 'dynamic-island-mount-box', vertical: false, x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._mountIconBin = new St.Bin({
            style_class: 'dynamic-island-mount-icon-bin',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                gicon: this._utilityGlyph('M7 3h10a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z M4 15h16 M16 18h.01'),
                icon_size: 24,
            }),
        });
        this._mountTextCol = new St.BoxLayout({ style_class: 'dynamic-island-mount-text-col', vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._mountTitle = new St.Label({ style_class: 'dynamic-island-mount-title', text: 'USB Drive' });
        this._mountTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._mountSubtitle = new St.Label({ style_class: 'dynamic-island-mount-subtitle', text: 'Tersedia' });
        this._mountSubtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._mountTextCol.add_child(this._mountTitle);
        this._mountTextCol.add_child(this._mountSubtitle);

        this._mountEjectBtn = new St.Button({ style_class: 'dynamic-island-mount-eject-btn', accessible_name: 'Lepas drive', reactive: true, child: new St.Icon({ gicon: this._utilityGlyph('m6 13 6-8 6 8Z M6 18h12'), icon_size: 16 }), y_align: Clutter.ActorAlign.CENTER, can_focus: true });
        this._mountEjectBtn.connect('clicked', () => {
            if (this._currentMount?.mount) {
                const selected = this._currentMount;
                this._mountEjectBtn.reactive = false;
                this._mountWatcher.eject(selected.mount, (ok) => {
                    if (this._currentMount !== selected || this._currentView !== VIEW_MOUNT) return;
                    this._mountSubtitle.set_text(ok ? 'Aman dicabut' : 'Gagal melepas');
                    this._mountEjectBtn.visible = !ok;
                    this._mountEjectBtn.reactive = true;
                    this._showUtilityPopup(VIEW_MOUNT, this._mountBox, this._mountWidth, 64, 2200);
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
        this._notifBox = new St.BoxLayout({ style_class: 'dynamic-island-notif-box', clip_to_allocation: true, vertical: false, x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER, reactive: true });
        this._notifFallbackIcon = new Gio.BytesIcon({bytes: new GLib.Bytes(new TextEncoder().encode(
            '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M24 21c3-2 4-5 3-8S22 6 16 6 5 10 5 15c0 3 2 6 5 8l-1 4 6-3h1c3 0 6-1 8-3Z" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'))});
        this._notifIcon = new St.Icon({ icon_size: 28, gicon: this._notifFallbackIcon });
        this._notifIconBin = new St.Bin({ style_class: 'dynamic-island-notif-art', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, child: this._notifIcon });

        this._notifTextBox = new St.BoxLayout({ style_class: 'dynamic-island-notif-text-box', width: 280, vertical: true, x_expand: false, y_align: Clutter.ActorAlign.CENTER });
        this._notifHeaderRow = new St.BoxLayout({ vertical: false, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        this._notifTitle = new St.Label({ style_class: 'dynamic-island-notif-title', text: 'Pengirim', x_expand: true });
        this._notifTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._notifAppBadge = new St.Label({ style_class: 'dynamic-island-notif-badge', text: '', width: 76 });
        this._notifAppBadge.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._notifHeaderRow.add_child(this._notifTitle);
        this._notifHeaderRow.add_child(this._notifAppBadge);

        this._notifBody = new St.Label({ style_class: 'dynamic-island-notif-body', text: '', height: 36 });
        this._notifBody.clutter_text.use_markup = false;
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
        if (!this._admitPopup('vpn', 30, () => this._onVpnChanged({name, isConnected}))) return;
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
            if (this._vpnIcon) this._vpnIcon.gicon = this._utilityGlyph('M5 11h14v10H5Z M8 11V7a4 4 0 0 1 8 0v4');
            if (this._vpnIconBin) this._vpnIconBin.style_class = 'dynamic-island-vpn-icon-bin connected';
            if (this._vpnStatusLabel) {
                this._vpnStatusLabel.set_text('Connected');
                this._vpnStatusLabel.style_class = 'dynamic-island-vpn-status connected';
            }
        } else {
            if (this._vpnIcon) this._vpnIcon.gicon = this._utilityGlyph('M5 11h14v10H5Z M8 11V7a4 4 0 0 1 7-3');
            if (this._vpnIconBin) this._vpnIconBin.style_class = 'dynamic-island-vpn-icon-bin disconnected';
            if (this._vpnStatusLabel) {
                this._vpnStatusLabel.set_text('Disconnected');
                this._vpnStatusLabel.style_class = 'dynamic-island-vpn-status disconnected';
            }
        }

        this._showUtilityPopup(VIEW_VPN, this._vpnBox, this._vpnWidth, this._collapsedHeight, 2200);
    }

    _initBluetoothView() {
        this._bluetoothBox = new St.BoxLayout({ style_class: 'dynamic-island-bt-box', clip_to_allocation: true, vertical: false, x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER });
        const btGlyph = path => new Gio.BytesIcon({bytes: new GLib.Bytes(new TextEncoder().encode(
            `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="${path}" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`))});
        this._btGlyphs = {
            bluetooth: btGlyph('m7 7 10 10-5 4V3l5 4L7 17'),
            headphones: btGlyph('M4 14v-3a8 8 0 0 1 16 0v3 M4 13h3v7H5a1 1 0 0 1-1-1Z M20 13h-3v7h2a1 1 0 0 0 1-1Z'),
            mouse: btGlyph('M6 9a6 6 0 0 1 12 0v6a6 6 0 0 1-12 0Z M12 5v4'),
            keyboard: btGlyph('M3 6h18v12H3Z M7 10h1 M11 10h1 M15 10h1 M7 14h10'),
            phone: btGlyph('M7 3h10v18H7Z M11 18h2'),
        };
        this._btIcon = new St.Icon({ icon_size: 16, gicon: this._btGlyphs.bluetooth, style_class: 'dynamic-island-bt-icon' });
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
        if (!this._admitPopup('mount', 30, () => this._onDriveMounted(data))) return;
        if (this._isControlCenterOpen) return;
        if (this._bannerDismissId) GLib.source_remove(this._bannerDismissId);

        this._currentMount = data;
        this._mountEjectBtn.reactive = true;
        this._mountTitle.set_text(data.name);
        this._mountSubtitle.set_text('Terhubung');
        this._mountEjectBtn.visible = Boolean(data.mount?.can_eject?.() || data.mount?.can_unmount?.());

        this._showUtilityPopup(VIEW_MOUNT, this._mountBox, this._mountWidth, 64, 2600);
    }

    _onDriveRemoved(name) {
        if (!this._admitPopup('mount', 30, () => this._onDriveRemoved(name))) return;
        if (this._isControlCenterOpen) return;
        this._mountTitle.set_text(name || 'Drive');
        this._mountSubtitle.set_text('Terputus');
        this._mountEjectBtn.visible = false;
        this._showUtilityPopup(VIEW_MOUNT, this._mountBox, this._mountWidth, 64, 1800);
    }

    _connectSource(source) {
        if (this._sourceConnections.has(source)) return;
        const id = source.connect('notification-added', (_s, n) => {
            this._watchNotification(n);
            this._onNotification(n);
        });
        for (const n of source.notifications ?? []) this._watchNotification(n);
        this._sourceConnections.set(source, id);
    }

    _disconnectSource(source) {
        if (this._sourceConnections.has(source)) {
            try { source.disconnect(this._sourceConnections.get(source)); } catch (_) { }
            this._sourceConnections.delete(source);
        }
    }

    _watchNotification(notification) {
        if (this._notificationConnections.has(notification)) return;
        const changed = notification.connect('notify', (_n, property) => {
            if (['title', 'body', 'gicon'].includes(property.name))
                this._onNotification(notification);
        });
        const destroyed = notification.connect('destroy', () => {
            this._destroyedNotifications.add(notification);
            this._notificationQueue = this._notificationQueue.filter(n => n !== notification);
            this._unwatchNotification(notification);
            if (this._currentNotification === notification) this._dismissNotification();
        });
        this._notificationConnections.set(notification, [changed, destroyed]);
    }

    _unwatchNotification(notification) {
        for (const id of this._notificationConnections.get(notification) ?? [])
            notification.disconnect(id);
        this._notificationConnections.delete(notification);
    }

    _onNotification(notification) {
        if (this._destroyedNotifications?.has(notification)) return;
        if (!this._admitPopup('notifications', 80, () => this._onNotification(notification))) return;
        // The latest message replaces the preview; older messages stay in GNOME history.
        this._notificationQueue = [notification];
        this._processQueue();
    }

    _processQueue() {
        if (this._notificationQueue.length === 0 || this._isControlCenterOpen) return;

        this._isProcessingQueue = true;
        this._currentNotification = this._notificationQueue.shift();
        this._waitingForMouseLeave = false;

        const n = this._currentNotification;
        this._notifTitle.set_text((n.title || 'Notifikasi').replace(/\s+/g, ' ').slice(0, 256));
        this._notifBody.set_text((n.body || '').replace(/\s+/g, ' ').slice(0, 2000));

        const sourceName = n.source?.title || n.source?.name || '';
        this._notifAppBadge.set_text(sourceName || '');

        if (n.gicon) this._setNotifIcon({ gicon: n.gicon });
        else if (n.source?.app?.get_app_info()?.get_icon())
            this._setNotifIcon({gicon: n.source.app.get_app_info().get_icon()});
        else this._setNotifIcon({});

        this._expandNotification();
    }

    _setNotifIcon({ gicon = null, iconName = null }) {
        this._notifIcon.gicon = null;
        this._notifIcon.icon_name = null;
        if (gicon) this._notifIcon.gicon = gicon;
        else if (iconName) this._notifIcon.icon_name = iconName;
        else this._notifIcon.gicon = this._notifFallbackIcon;
    }

    _expandNotification() {
        const alreadyVisible = this._currentView === VIEW_NOTIFICATION;
        this._isExpanded = true;
        if (!alreadyVisible) {
            this._setView(VIEW_NOTIFICATION);
            this._notifBox.remove_all_transitions();
            this._notifBox.opacity = 0;
            this._repositionAndResize(this._notifWidth, this._notifHeight, 320,
                Clutter.AnimationMode.EASE_OUT_CUBIC);
            this._notifBox.ease({opacity: 255, delay: 140, duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        if (this._autoCollapseId) GLib.source_remove(this._autoCollapseId);
        this._autoCollapseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._preferences.get_int('popup-duration'), () => {
            this._autoCollapseId = null;
            if (this._currentView === VIEW_NOTIFICATION && this._island.hover)
                this._waitingForMouseLeave = true;
            else
                this._dismissNotification();
            return GLib.SOURCE_REMOVE;
        });
    }

    _dismissNotification() {
        if (this._autoCollapseId) GLib.source_remove(this._autoCollapseId);
        this._autoCollapseId = null;
        this._isProcessingQueue = false;
        this._waitingForMouseLeave = false;
        this._currentNotification = null;
        if (this._currentView === VIEW_NOTIFICATION) this._restoreBestView();
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

        this._dismissNotification();
    }

    _expandControlCenter() {
        this._isExpanded = true;
        this._isControlCenterOpen = true;
        this._syncControlCenterUI();

        this._setView(VIEW_CONTROL_CENTER);
        this._controlCenterBox.remove_all_transitions();
        this._controlCenterBox.opacity = 0;
        this._repositionAndResize(this._ccExpandedWidth, this._ccExpandedHeight, 320, Clutter.AnimationMode.EASE_OUT_CUBIC);
        this._controlCenterBox.ease({opacity: 255, delay: 180, duration: 140,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _collapse() {
        this._isExpanded = false;
        this._isControlCenterOpen = false;
        this._restoreBestView();
    }

    _onBluetoothConnected({ name, icon = '', battery, kind = 'device', connected = true }) {
        if (!this._admitPopup('bluetooth', 30, () => this._onBluetoothConnected({name, icon, battery, kind, connected}))) return;
        if (this._isControlCenterOpen) {
            this._pendingBluetoothEvent = {name, icon, battery, kind, connected};
            return;
        }
        if (this._bannerDismissId) GLib.source_remove(this._bannerDismissId);

        this._btNameLabel.set_text(name || 'Bluetooth Device');
        const type = kind === 'adapter' ? 'bluetooth' :
            /mouse|pointing/.test(icon) ? 'mouse' : /keyboard/.test(icon) ? 'keyboard' :
            /head|audio/.test(icon) ? 'headphones' : /phone/.test(icon) ? 'phone' : 'bluetooth';
        this._btIcon.gicon = this._btGlyphs[type];
        this._btIcon.opacity = connected ? 255 : 130;
        this._btStatusLabel.set_text(kind === 'adapter' ? (connected ? 'Aktif' : 'Nonaktif') :
            (connected ? 'Terhubung' : 'Terputus'));

        if (connected && Number.isFinite(battery) && battery >= 0) {
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

        const visible = this._currentView === VIEW_BT;
        if (!visible) {
            this._setView(VIEW_BT);
            this._bluetoothBox.remove_all_transitions();
            this._bluetoothBox.opacity = 0;
            this._repositionAndResize(this._bluetoothWidth, this._collapsedHeight, 280, Clutter.AnimationMode.EASE_OUT_CUBIC);
            this._bluetoothBox.ease({opacity: 255, delay: 100, duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }

        this._bannerDismissId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._preferences.get_int('popup-duration'), () => {
            this._bannerDismissId = null;
            if (this._currentView === VIEW_BT) this._restoreBestView();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onBatteryEvent({ isCharging, percentage }) {
        if (!isCharging) return;
        if (!this._admitPopup('battery', 30, () => this._onBatteryEvent({isCharging, percentage}))) return;
        if (!isCharging || this._isControlCenterOpen) return;
        if (this._bannerDismissId) GLib.source_remove(this._bannerDismissId);

        this._chargingLabel.set_text('Charging');
        this._chargingPercentLabel.set_text(`${percentage}%`);
        this._batteryFill.width = Math.max(2, Math.floor((percentage / 100) * 18));

        this._showUtilityPopup(VIEW_CHARGING, this._chargingBox, this._chargingWidth, this._collapsedHeight, 2200);
    }

    _hookOsd() {
        this._origOsdShow = Main.osdWindowManager.show.bind(Main.osdWindowManager);
        Main.osdWindowManager.show = (monitorIndex, icon, label, level, maxLevel) => {
            if (!this._featureEnabled('hud')) {
                this._origOsdShow(monitorIndex, icon, label, level, maxLevel);
                return;
            }
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
        if (!this._admitPopup('hud', 60, () => this._showOsdInIsland({icon, iconName, level, maxLevel, isVolume}))) return;
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

        this._showUtilityPopup(VIEW_HUD, this._hudBox, this._hudWidth, this._collapsedHeight, 2200);
    }

    _onRecordingStarted() {
        if (!this._featureEnabled('recording')) return;
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
        if (!this._featureEnabled('recording')) return;
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

    _expandMpris() {
        if (this._currentView === VIEW_EXPANDED_MEDIA) return;
        this._isExpanded = true;
        this._setView(VIEW_EXPANDED_MEDIA);
        this._mediaContent.remove_all_transitions();
        this._mediaContent.opacity = 0;
        this._repositionAndResize(this._mediaExpandedWidth, this._mediaExpandedHeight, 320,
            Clutter.AnimationMode.EASE_OUT_CUBIC);
        this._mediaContent.ease({opacity: 255, delay: 180, duration: 140,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._updateMediaProgress();
    }

    _onMediaUpdate(state) {
        if (state) this._lastMediaState = state;
        if (!this._featureEnabled('media')) state = null;
        this._currentMedia = state;
        const playing = state?.status === 'Playing';
        if (playing || !state || state.status === 'Stopped') {
            if (this._pauseTimeoutId) GLib.source_remove(this._pauseTimeoutId);
            this._pauseTimeoutId = null;
            this._mediaPausedHidden = false;
        }
        if (!state || state.status === 'Stopped') {
            this._mediaActive = false;
            if ([VIEW_COMPACT_MEDIA, VIEW_EXPANDED_MEDIA].includes(this._currentView))
                this._restoreBestView();
            this._syncControlCenterUI();
            return;
        }
        if (!playing && !this._pauseTimeoutId && !this._mediaPausedHidden) {
            this._pauseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                this._pauseTimeoutId = null;
                this._mediaPausedHidden = true;
                this._mediaActive = false;
                if ([VIEW_COMPACT_MEDIA, VIEW_EXPANDED_MEDIA].includes(this._currentView))
                    this._restoreBestView();
                return GLib.SOURCE_REMOVE;
            });
        }
        this._mediaActive = playing || !this._mediaPausedHidden;
        this._titleLabel.set_text(state.title || 'Unknown Title');
        this._bodyLabel.set_text(state.artist || 'Unknown Artist');
        this._loadCoverArt(state.artUrl);
        this._playBtn.child.gicon = playing ? this._mediaPauseGlyph : this._mediaPlayGlyph;
        this._prevBtn.reactive = state.canPrev !== false;
        this._nextBtn.reactive = state.canNext !== false;
        this._prevBtn.opacity = this._prevBtn.reactive ? 255 : 80;
        this._nextBtn.opacity = this._nextBtn.reactive ? 255 : 80;

        if (playing && !this._mediaIntroShown && !this._isExpanded &&
            !this._isControlCenterOpen && [VIEW_IDLE, VIEW_COMPACT_MEDIA].includes(this._currentView)) {
            this._mediaIntroShown = true;
            try { GLib.file_set_contents(this._mediaIntroMarker, this._mediaBootId); } catch (_) { }
            this._expandMpris();
            this._mediaIntroTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                this._mediaIntroTimeoutId = null;
                if (this._currentView === VIEW_EXPANDED_MEDIA) this._restoreBestView();
                return GLib.SOURCE_REMOVE;
            });
        } else if (this._mediaActive && !this._isExpanded && !this._isControlCenterOpen &&
            this._currentView === VIEW_IDLE) {
            this._setView(VIEW_COMPACT_MEDIA);
            this._repositionAndResize(this._compactMediaWidth, this._collapsedHeight, 300);
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
            this._ccWifiIcon.icon_name = 'network-wireless-signal-excellent-symbolic';
        } else {
            this._ccBtnWifi.remove_style_class_name('on');
            this._ccWifiIcon.icon_name = 'network-wireless-disabled-symbolic';
        }

        if (this._cc.isBluetoothEnabled()) this._ccBtnBt.add_style_class_name('on'); else this._ccBtnBt.remove_style_class_name('on');
        if (this._cc.isAirplaneMode()) this._ccBtnAirplane.add_style_class_name('on'); else this._ccBtnAirplane.remove_style_class_name('on');

        this._ccWifiLabel.set_text(this._cc.isWifiEnabled() ? this._cc.getWifiSsid() : 'Wi-Fi nonaktif');
        const pMode = this._cc.getPowerProfile();
        const names = {'Performance': 'Performa', 'Power Saver': 'Hemat daya', 'Balanced': 'Seimbang'};
        this._ccPowerLabel.set_text(this._cc.getPowerError() || `Mode daya · ${names[pMode] || pMode}`);
        const active = {'Performance': 'performance', 'Power Saver': 'power-saver', 'Balanced': 'balanced'}[pMode];
        for (const [profile, button] of this._ccPowerChoices) {
            button.reactive = this._cc.getPowerProfiles().includes(profile) && !this._cc.isPowerPending();
            button.can_focus = button.reactive;
            button.opacity = button.reactive ? 255 : 90;
            if (profile === active) button.add_style_class_name('on');
            else button.remove_style_class_name('on');
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
                    if (this._featureEnabled('recording') && this._recorder?.isRecording) {
                        this._isExpanded = true;
                        this._setView(VIEW_EXPANDED_RECORD);
                        this._repositionAndResize(this._mediaExpandedWidth, this._recordExpandedHeight, 340, Clutter.AnimationMode.EASE_OUT_CUBIC);
                    } else if (this._mediaActive) {
                        this._expandMpris();
                    } else {
                        this._expandControlCenter();
                    }
                }
            } else {
                if (this._isExpanded && !this._isDraggingSeek) {
                    this._unhoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
                        this._unhoverTimeoutId = null;
                        if (this._isProcessingQueue && this._waitingForMouseLeave) {
                            this._dismissNotification();
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

    _onPrivacyState({ camera, mic }, simulated = false) {
        if (!simulated) this._realPrivacyState = {camera, mic};
        if (!this._featureEnabled('privacy')) camera = mic = false;
        this._cameraDot.visible = camera;
        this._micDot.visible = mic;
        this._privacyBox.visible = (camera || mic);
        this._idleLeftSpacer.visible = false;
        this._positionPrivacyOverlay();
        const extraWidth = camera && mic ? 24 : 0;
        if (extraWidth !== this._privacyExtraWidth) {
            this._privacyExtraWidth = extraWidth;
            if (this._currentView === VIEW_IDLE) {
                this._repositionAndResize(this._idleWidth + extraWidth,
                    this._collapsedHeight, 240, Clutter.AnimationMode.EASE_OUT_CUBIC);
            }
        }
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
            
            if (this._mediaActive && this._currentMedia &&
                [VIEW_EXPANDED_MEDIA, VIEW_CONTROL_CENTER].includes(this._currentView)) {
                this._updateMediaProgress();
            }
            return GLib.SOURCE_CONTINUE;
        });

        // Ticker Animasi Wave (Berjalan setiap 150ms)
        this._wavesAreReset = false;
        this._waveTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            if (this._mediaActive && this._currentMedia?.status === 'Playing' &&
                [VIEW_COMPACT_MEDIA, VIEW_EXPANDED_MEDIA].includes(this._currentView)) {
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
        const scale = this._preferences.get_double('island-scale');
        const x = this._monitor.x + Math.max(0, Math.min(this._monitor.width - width * scale,
            (this._monitor.width - width * scale) / 2 + this._preferences.get_int('horizontal-offset')));
        this._island.set_position(Math.round(x), this._monitor.y + this._topMargin);
        this._positionPrivacyOverlay();
    }

    _repositionAndResize(width, height, duration = 320, mode = Clutter.AnimationMode.EASE_OUT_CUBIC) {
        if (!this._monitor) return;
        const scale = this._preferences.get_double('island-scale');
        const targetX = this._monitor.x + Math.max(0, Math.min(this._monitor.width - width * scale,
            (this._monitor.width - width * scale) / 2 + this._preferences.get_int('horizontal-offset')));
        const targetY = this._monitor.y + this._topMargin;
        this._island.ease({width, height, x: Math.round(targetX), y: targetY, duration, mode});
    }

    _featureEnabled(feature) {
        return this._preferences.get_boolean(`enable-${feature}`);
    }

    _admitPopup(feature, priority, callback) {
        if (!this._featureEnabled(feature)) return false;
        const blocked = this._isControlCenterOpen || this._isDraggingSeek ||
            this._currentView === VIEW_COUNTDOWN ||
            (this._isExpanded && [VIEW_EXPANDED_MEDIA, VIEW_EXPANDED_RECORD].includes(this._currentView));
        if (!this._popupQueue.request(feature, priority, callback, blocked)) return false;
        if (this._bannerDismissId) GLib.source_remove(this._bannerDismissId);
        this._bannerDismissId = null;
        if (feature !== 'notifications' && this._autoCollapseId) {
            GLib.source_remove(this._autoCollapseId);
            this._autoCollapseId = null;
        }
        return true;
    }

    _applyPreferences(key) {
        if (key === 'test-mode') {
            if (!this._preferences.get_boolean(key)) this._resetDemo();
            return;
        }
        if (key === 'enable-notifications') {
            const enabled = this._featureEnabled('notifications');
            this._settings.set_boolean('show-banners', enabled ? false : this._originalShowBanners);
            if (Main.messageTray._bannerBin) Main.messageTray._bannerBin.visible = !enabled;
            if (!enabled) {
                this._notificationQueue = [];
                this._dismissNotification();
            }
        }
        if (key === 'enable-download') {
            this._dlWatcher?.destroy();
            this._dlWatcher = null;
            if (this._featureEnabled('download')) this._dlWatcher = new DownloadWatcher(data => this._onDownloadProgress(data));
            else {
                this._currentDownload = null;
                this._cancelDownloadCollapse();
                if (this._dlCompletedTimeoutId) GLib.source_remove(this._dlCompletedTimeoutId);
                this._dlCompletedTimeoutId = null;
            }
        }
        if (key === 'enable-vpn') {
            this._vpnWatcher?.destroy();
            this._vpnWatcher = this._featureEnabled('vpn') ? new VpnWatcher(data => this._onVpnChanged(data)) : null;
        }
        if (key === 'enable-privacy') {
            this._privacy?.destroy();
            this._privacy = this._featureEnabled('privacy') ? new PrivacyWatcher(state => this._onPrivacyState(state)) : null;
            this._onPrivacyState(this._realPrivacyState);
        }
        if (key === 'enable-media') this._onMediaUpdate(this._featureEnabled('media') ? this._lastMediaState : null);
        if (key.startsWith('enable-')) {
            this._popupQueue.clear();
            if (!this._isControlCenterOpen) this._restoreBestView();
        }
        this._topMargin = this._preferences.get_int('top-offset');
        const scale = this._preferences.get_double('island-scale');
        this._island.set_scale(scale, scale);
        this._reposition(this._getCurrentPillWidth());
    }

    _initPrivacyOverlay() {
        this._idleBox.remove_child(this._privacyBox);
        this._privacyBox.style_class = 'dynamic-island-privacy-overlay';
        this._privacyBox.reactive = false;
        Main.uiGroup.add_child(this._privacyBox);
        for (const property of ['x', 'y', 'width', 'height', 'scale-x', 'scale-y'])
            this._island.connect(`notify::${property}`, () => this._positionPrivacyOverlay());
        this._positionPrivacyOverlay();
    }

    _positionPrivacyOverlay() {
        if (!this._privacyBox || !this._island || !this._monitor) return;
        const scale = this._preferences.get_double('island-scale');
        this._privacyBox.set_scale(scale, scale);
        const width = (this._cameraDot.visible && this._micDot.visible ? 36 : 24) * scale;
        const right = this._island.x + this._island.width * scale + 6;
        const x = Math.min(right, this._monitor.x + this._monitor.width - width - 4);
        this._privacyBox.set_position(Math.round(x), Math.round(this._island.y +
            (this._island.height * scale - 22 * scale) / 2));
        Main.uiGroup.set_child_above_sibling(this._privacyBox, this._island);
    }

    _initTestService() {
        const xml = '<node><interface name="org.gnome.Shell.Extensions.DynamicIsland"><method name="Demo"><arg type="s" direction="in"/><arg type="s" direction="out"/></method></interface></node>';
        this._testObject = Gio.DBusExportedObject.wrapJSObject(xml, {
            Demo: name => {
                if (!this._preferences.get_boolean('test-mode')) return 'Mode tes belum aktif: jalankan tools/island-test enable';
                return this._runDemo(name);
            },
        });
        this._testObject.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/DynamicIsland');
    }

    _demoLater(delay, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._testTimers.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._testTimers.add(id);
    }

    _resetDemo() {
        for (const id of this._testTimers) GLib.source_remove(id);
        this._testTimers.clear();
        this._popupQueue.clear();
        if (this._currentDownload?.simulated) {
            if (this._dlCompletedTimeoutId) GLib.source_remove(this._dlCompletedTimeoutId);
            this._dlCompletedTimeoutId = null;
            this._onDownloadProgress(null);
        }
        if (this._currentNotification?.simulated) this._dismissNotification();
        this._onPrivacyState(this._realPrivacyState, true);
        if (!this._isControlCenterOpen) this._restoreBestView();
    }

    _runDemo(name) {
        if (!['mount', 'bluetooth', 'notification', 'download', 'privacy', 'vpn', 'workspace', 'reset'].includes(name)) return 'Jenis tes tidak dikenal';
        this._resetDemo();
        switch (name) {
        case 'mount':
            this._onDriveMounted({name: 'Test USB', mount: null});
            this._demoLater(4000, () => this._onDriveRemoved('Test USB'));
            break;
        case 'bluetooth':
            this._onBluetoothConnected({name: 'Bluetooth', kind: 'adapter', connected: true});
            this._demoLater(4000, () => this._onBluetoothConnected({name: 'Bluetooth', kind: 'adapter', connected: false}));
            break;
        case 'notification':
            this._onNotification({title: 'Pesan uji', body: 'Ini simulasi pesan panjang untuk memeriksa batas teks, ikon dan animasi. '.repeat(8), source: {title: 'Simulasi'}, simulated: true});
            break;
        case 'download':
            if (this._currentDownload) return 'Tunggu unduhan aktif selesai sebelum simulasi';
            for (let i = 0; i <= 5; i++) this._demoLater(i * 1000 + 1, () =>
                {
                    if (!this._currentDownload || this._currentDownload.simulated)
                        this._onDownloadProgress({filename: 'Simulasi.zip', percentage: i * 20, size: i * 1048576, isCompleted: i === 5, simulated: true});
                });
            break;
        case 'privacy':
            this._onPrivacyState({camera: true, mic: true}, true);
            this._demoLater(5000, () => this._onPrivacyState(this._realPrivacyState, true));
            break;
        case 'vpn':
            this._onVpnChanged({name: 'Test VPN', isConnected: true});
            this._demoLater(4000, () => this._onVpnChanged({name: 'Test VPN', isConnected: false}));
            break;
        case 'workspace': this._onWorkspaceChanged({index: 2, totalWorkspaces: 4, name: 'Test Desk 2'}); break;
        }
        return 'Simulasi: ' + name;
    }

    disable() {
        this._testObject?.unexport();
        this._testObject = null;
        for (const id of this._testTimers ?? []) GLib.source_remove(id);
        this._testTimers?.clear();
        this._popupQueue?.clear();
        if (this._preferencesChangedId) this._preferences.disconnect(this._preferencesChangedId);
        this._preferencesChangedId = null;
        this._privacyBox?.destroy();
        if (this._clockTickId) GLib.source_remove(this._clockTickId);
        if (this._waveTickId) GLib.source_remove(this._waveTickId);
        if (this._bannerDismissId) GLib.source_remove(this._bannerDismissId);
        if (this._autoCollapseId) GLib.source_remove(this._autoCollapseId);
        if (this._unhoverTimeoutId) GLib.source_remove(this._unhoverTimeoutId);
        if (this._countdownTickId) GLib.source_remove(this._countdownTickId);
        if (this._recordPulseId) GLib.source_remove(this._recordPulseId);
        if (this._pauseTimeoutId) GLib.source_remove(this._pauseTimeoutId);
        if (this._mediaIntroTimeoutId) GLib.source_remove(this._mediaIntroTimeoutId);
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
        for (const notification of this._notificationConnections.keys())
            this._unwatchNotification(notification);
        this._notificationQueue = [];
        this._currentNotification = null;

        if (this._cc) this._cc.destroy();
        if (this._recorder) this._recorder.destroy();
        if (this._privacy) this._privacy.destroy();
        if (this._bluetooth) this._bluetooth.destroy();
        if (this._battery) this._battery.destroy();
        if (this._media) this._media.destroy();
        if (this._wsWatcher) this._wsWatcher.destroy();
        if (this._mountWatcher) this._mountWatcher.destroy();
        this._cancelDownloadCollapse();
        if (this._dlWatcher) this._dlWatcher.destroy();
        if (this._vpnWatcher) this._vpnWatcher.destroy();
        if (this._island) this._island.destroy();
    }
}