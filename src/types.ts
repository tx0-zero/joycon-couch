export type JoyConSide = 'right' | 'left';
export type JoyConVoiceMode = 'hold' | 'toggle';

export interface JoyConSettings {
  enabled: boolean;
  side: JoyConSide;
  voiceMode: JoyConVoiceMode;
  cursorSpeed: number; // px per frame at full deflection (60Hz), default 18
  scrollSpeed: number; // scroll units per frame, default 10
  deadzone: number; // 0..0.4, default 0.12
  gesturesEnabled: boolean;
  rumbleEnabled: boolean;
}

export interface JoyConButtons {
  a: boolean;
  b: boolean;
  x: boolean;
  y: boolean;
  r: boolean;
  zr: boolean;
  plus: boolean;
  home: boolean;
  rStick: boolean;
  sr: boolean;
  sl: boolean;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 从原生/跨平台 HID 桥接层上报的一帧 Joy-Con 状态（~60Hz）。 */
export interface JoyConFrame {
  side: JoyConSide;
  ts: number; // ms
  stickX: number; // -1..1（右为正）
  stickY: number; // -1..1（上为正）
  buttons: JoyConButtons;
  accel?: Vec3; // 单位约 g
  gyro?: Vec3; // 单位约 deg/s
}

export type KeyComboId =
  | 'enter'
  | 'escape'
  | 'undo'
  | 'copy'
  | 'paste'
  | 'cut'
  | 'select_all'
  | 'backspace'
  | 'close_tab'
  | 'switch_window'
  | 'mission_control'
  | 'desktop_left'
  | 'desktop_right';

export type JoyConAction =
  | { type: 'mouseMove'; dx: number; dy: number }
  | { type: 'mouseDown'; button: 'left' | 'right' }
  | { type: 'mouseUp'; button: 'left' | 'right' }
  | { type: 'mouseClick'; button: 'left' | 'right' }
  | { type: 'mouseScroll'; dx: number; dy: number }
  | { type: 'keyCombo'; combo: KeyComboId }
  | { type: 'voiceStart' }
  | { type: 'voiceStop' }
  | { type: 'voiceToggle' }
  | { type: 'voiceCancel' }
  | { type: 'toggleHud' }
  | { type: 'radialOpen' }
  | { type: 'radialSelect'; index: number; stickX: number; stickY: number }
  | { type: 'radialClose' }
  | { type: 'rumble'; pattern: 'tap' | 'double' | 'soft' }
  | { type: 'notice'; title: string; detail: string };

export interface JoyConStatus {
  enabled: boolean;
  helperRunning: boolean;
  connected: boolean;
  side: JoyConSide | null;
  locked: boolean;
  scrollMode: boolean;
  error: string | null;
}

export function defaultJoyConSettings(): JoyConSettings {
  return {
    enabled: true,
    side: 'right',
    voiceMode: 'hold',
    cursorSpeed: 18,
    scrollSpeed: 12,
    deadzone: 0.12,
    gesturesEnabled: true,
    rumbleEnabled: true,
  };
}
