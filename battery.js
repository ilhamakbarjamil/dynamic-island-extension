import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import UPowerGlib from 'gi://UPowerGlib';

export class BatteryWatcher {
    constructor(onChargingChanged) {
        this._onChargingChanged = onChargingChanged;
        this._client = null;
        this._device = null;
        this._stateSig = null;
        this._percentSig = null;
        this._lastState = null;

        try {
            this._client = new UPowerGlib.Client();
            this._device = this._client.get_display_device();

            if (this._device && this._device.is_present) {
                this._lastState = this._device.state;

                this._stateSig = this._device.connect('notify::state', () => {
                    this._checkState();
                });

                this._percentSig = this._device.connect('notify::percentage', () => {
                    // Update jika sedang mengisi
                    if (this.isCharging()) {
                        this._emit(true, this.getPercentage());
                    }
                });
            }
        } catch (e) {
            console.log('[DynamicIsland] UPower tidak tersedia:', e.message);
        }
    }

    _checkState() {
        if (!this._device) return;
        const currentState = this._device.state;
        const isCharging = (currentState === UPowerGlib.DeviceState.CHARGING ||
                            currentState === UPowerGlib.DeviceState.FULLY_CHARGED ||
                            currentState === UPowerGlib.DeviceState.PENDING_CHARGE);

        const wasCharging = (this._lastState === UPowerGlib.DeviceState.CHARGING ||
                             this._lastState === UPowerGlib.DeviceState.FULLY_CHARGED ||
                             this._lastState === UPowerGlib.DeviceState.PENDING_CHARGE);

        this._lastState = currentState;

        // Picu animasi saat charger dicolokkan (Charging)
        if (isCharging && !wasCharging) {
            this._emit(true, this.getPercentage());
        } else if (!isCharging && wasCharging) {
            this._emit(false, this.getPercentage());
        }
    }

    _emit(isCharging, percentage) {
        try {
            this._onChargingChanged?.({
                isCharging,
                percentage: Math.round(percentage),
            });
        } catch (_) {}
    }

    getPercentage() {
        return this._device ? Math.round(this._device.percentage) : 100;
    }

    isCharging() {
        if (!this._device) return false;
        return (this._device.state === UPowerGlib.DeviceState.CHARGING ||
                this._device.state === UPowerGlib.DeviceState.FULLY_CHARGED);
    }

    destroy() {
        if (this._device) {
            if (this._stateSig) this._device.disconnect(this._stateSig);
            if (this._percentSig) this._device.disconnect(this._percentSig);
        }
        this._device = null;
        this._client = null;
        this._onChargingChanged = null;
    }
}
