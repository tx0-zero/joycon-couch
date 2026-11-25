import assert from 'node:assert/strict';
import { JoyConMapper, shapeStickAxis } from './mapper';
import { defaultJoyConSettings, type JoyConButtons, type JoyConFrame } from './types';

const btns = (p: Partial<JoyConButtons> = {}): JoyConButtons => ({
  a: false, b: false, x: false, y: false, r: false, zr: false, plus: false, home: false, rStick: false, sr: false, sl: false, ...p,
});
const frame = (p: Partial<JoyConFrame> = {}): JoyConFrame => ({
  side: 'right', ts: 1000, stickX: 0, stickY: 0, buttons: btns(), ...p,
});

assert.equal(shapeStickAxis(0.1, 0.12), 0);
assert.ok(shapeStickAxis(0.9, 0.12) > 0.7);

const m = new JoyConMapper();
const cfg = defaultJoyConSettings();
const a1 = m.process(frame({ stickX: 0.8, buttons: btns({ r: true }) }), cfg, { isRecording: false, isBusy: false });
assert.ok(a1.some((x) => x.type === 'mouseDown' && x.button === 'left'));
assert.ok(a1.some((x) => x.type === 'mouseMove' && x.dx > 0));

const g1 = m.process(frame({ ts: 2500, buttons: btns({ r: false }), gyro: { x: 0, y: 0, z: 380 }, accel: { x: 0, y: 0, z: 1 } }), cfg, { isRecording: false, isBusy: false });
assert.ok(g1.some((x) => x.type === 'keyCombo' && x.combo === 'desktop_left'));

console.log('✓ joycon-couch 单元测试全部通过');
