import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import UPowerGlib from 'gi://UPowerGlib';

export class BatteryWatcher {
    constructor(onChargingChanged) {
        this._onChargingChanged = onChargingChanged;
        this._client = null;
        this._device = null;
        this._stateSig = null;
        this._lastState = null;

        try {
            this._client = new UPowerGlib.Client();
            this._device = this._client.get_display_device();

            if (this._device && this._device.is_present) {
                this._lastState = this._device.state;

                // HANYA memantau perubahan status colokan (Plug / Unplug)
                this._stateSig = this._device.connect('notify::state', () => {
                    this._checkState();
                });
            }
        } catch (e) {
            console.log('[DynamicIsland] UPower tidak tersedia:', e.message);
        }
    }

    _checkState() {
        if (!this._device) return;
        const currentState = this._device.state;

        const isPluggedIn = (currentState === UPowerGlib.DeviceState.CHARGING ||
                             currentState === UPowerGlib.DeviceState.FULLY_CHARGED ||
                             currentState === UPowerGlib.DeviceState.PENDING_CHARGE);

        const wasPluggedIn = (this._lastState === UPowerGlib.DeviceState.CHARGING ||
                              this._lastState === UPowerGlib.DeviceState.FULLY_CHARGED ||
                              this._lastState === UPowerGlib.DeviceState.PENDING_CHARGE);

        this._lastState = currentState;

        // HANYA picu saat kabel charger BARU SAJA DICOLOKKAN
        if (isPluggedIn && !wasPluggedIn) {
            this._onChargingChanged?.({
                isCharging: true,
                percentage: Math.round(this._device.percentage),
            });
        }
    }

    destroy() {
        if (this._device && this._stateSig) {
            this._device.disconnect(this._stateSig);
            this._stateSig = null;
        }
        this._device = null;
        this._client = null;
        this._onChargingChanged = null;
    }
}