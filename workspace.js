import GLib from 'gi://GLib';

export class WorkspaceWatcher {
    constructor(onChange) {
        this._onChange = onChange;
        this._workspaceChangedId = null;
        this._startupId = null;
        this._display = global.display || null;

        this._notifyCurrentWorkspace();
        this._install();
    }

    _install() {
        if (!this._display) return;

        try {
            this._workspaceChangedId = this._display.connect(
                'workspace-switched',
                () => this._notifyCurrentWorkspace()
            );
        } catch (_) {
            this._workspaceChangedId = null;
        }

        try {
            this._startupId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._notifyCurrentWorkspace();
                return GLib.SOURCE_REMOVE;
            });
        } catch (_) {
            this._startupId = null;
        }
    }

    _notifyCurrentWorkspace() {
        if (!this._onChange) return;

        const workspaceManager = global.workspace_manager;
        const activeWorkspace = workspaceManager?.get_active_workspace?.();
        const index = (activeWorkspace?.index?.() ?? 0) + 1;
        const totalWorkspaces = workspaceManager?.n_workspaces ?? 4;
        const name = `Desk ${index}`;

        this._onChange({
            index,
            totalWorkspaces,
            name,
        });
    }

    destroy() {
        if (this._workspaceChangedId && this._display) {
            try {
                this._display.disconnect(this._workspaceChangedId);
            } catch (_) {}
            this._workspaceChangedId = null;
        }

        if (this._startupId) {
            try {
                GLib.source_remove(this._startupId);
            } catch (_) {}
            this._startupId = null;
        }

        this._onChange = null;
        this._display = null;
    }
}
