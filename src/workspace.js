import GLib from 'gi://GLib';

export class WorkspaceWatcher {
    constructor(onChange) {
        this._onChange = onChange;
        this._wsManager = global.workspace_manager || global.workspaceManager || null;
        this._workspaceChangedId = null;
        this._lastIndex = this._getActiveIndex();

        this._install();
    }

    _getActiveIndex() {
        try {
            return this._wsManager?.get_active_workspace()?.index() ?? 0;
        } catch (_) {
            return 0;
        }
    }

    _install() {
        if (!this._wsManager) return;

        try {
            // Sinyal resmi GNOME Shell untuk pergantian workspace aktif
            this._workspaceChangedId = this._wsManager.connect(
                'active-workspace-changed',
                () => {
                    const newIndex = this._getActiveIndex();
                    // Hanya picu jika user benar-benar berpindah workspace
                    if (newIndex !== this._lastIndex) {
                        this._lastIndex = newIndex;
                        this._notifyCurrentWorkspace();
                    }
                }
            );
        } catch (e) {
            console.log('[DynamicIsland] Gagal connect active-workspace-changed:', e.message);
            this._workspaceChangedId = null;
        }
    }

    _notifyCurrentWorkspace() {
        if (!this._onChange || !this._wsManager) return;

        const index = this._getActiveIndex() + 1; // 1-based index
        const totalWorkspaces = this._wsManager.get_n_workspaces?.() ?? 4;
        const name = `Desk ${index}`;

        this._onChange({
            index,
            totalWorkspaces,
            name,
        });
    }

    destroy() {
        if (this._workspaceChangedId && this._wsManager) {
            try {
                this._wsManager.disconnect(this._workspaceChangedId);
            } catch (_) {}
            this._workspaceChangedId = null;
        }

        this._onChange = null;
        this._wsManager = null;
    }
}