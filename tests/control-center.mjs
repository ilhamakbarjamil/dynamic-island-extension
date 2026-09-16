import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const code = fs.readFileSync(new URL('../src/controlCenter.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/mg, '').replace('export class', 'class');
let calls = 0;
const context = {Gio: {DBus: {system: {call(...args) {calls++; args.at(-1)({call_finish() {}}, {});}}}, DBusCallFlags: {NONE: 0}},
    GLib: {Variant: class {constructor(type, value) {this.value = value;}}}};
vm.createContext(context);
vm.runInContext(code + ';globalThis.Manager = ControlCenterManager;', context);
const c = Object.create(context.Manager.prototype);
Object.assign(c, {_powerState: {profile: 'balanced', profiles: ['power-saver', 'balanced']},
    _powerService: {name:'test',path:'/test'}, _cancellable:{is_cancelled:()=>false}, _notify(){}, _refreshPowerProfiles(){}});
assert.equal(c.getPowerProfile(), 'Balanced');
c.setPowerProfile('performance');
assert.equal(calls, 0, 'unsupported profile must not be requested');
c.setPowerProfile('power-saver');
assert.equal(calls, 1);
assert.equal(c.isPowerPending(), false);
c._powerState.profile = null;
assert.equal(c.getPowerProfile(), 'Tidak tersedia', 'missing service must not pretend Balanced');
console.log('PASS: profile label, unsupported profile, async completion, unavailable status');
