import type { JoyConAction, JoyConButtons, JoyConFrame, JoyConSettings, KeyComboId } from './types';

/** 6 方向轮盘菜单（从正上 12 点顺时针排列：0=上, 1=右上, 2=右下, 3=下, 4=左下, 5=左上）。 */
export const RADIAL_SECTORS: { combo: KeyComboId; label: string; key: string }[] = [
  { combo: 'copy', label: '复制', key: '⌘C' },
  { combo: 'select_all', label: '全选', key: '⌘A' },
  { combo: 'screenshot', label: '截图', key: '⌘⌃⇧4' },
  { combo: 'paste', label: '粘贴', key: '⌘V' },
  { combo: 'close_tab', label: '关标签', key: '⌘W' },
  { combo: 'clear_all', label: '清空', key: '⌘A⌫' },
];

export function radialIndexFromStick(x: number, y: number, threshold = 0.32): number {
  if (Math.hypot(x, y) < threshold) return -1;
  // 从正上(0, 1)顺时针计算角度 [0, 360)
  const deg = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
  return Math.floor(((deg + 30) % 360) / 60);
}

export interface MapperContext {
  isRecording: boolean;
  isBusy: boolean;
}

const EMPTY_BUTTONS: JoyConButtons = {
  a: false,
  b: false,
  x: false,
  y: false,
  r: false,
  zr: false,
  plus: false,
  home: false,
  rStick: false,
  sr: false,
  sl: false,
};

/** 单轴辅助函数（保留兼容与单测）。 */
export function shapeStickAxis(raw: number, deadzone: number, exponent = 2.6): number {
  const clamped = Math.max(-1, Math.min(1, raw));
  const abs = Math.abs(clamped);
  if (abs <= deadzone) return 0;
  const norm = (abs - deadzone) / (1 - deadzone);
  return Math.sign(clamped) * Math.pow(norm, exponent);
}

/**
 * 径向圆形死区 + 双区精密响应曲线（类似 Steam Input / FPS 瞄准曲线）：
 * - 0.00 ~ 0.55：高精度微操区（像素级点按钮、选字不飘）
 * - 0.55 ~ 1.00：快速爬坡区（配合外圈时间加速，半秒跨 4K 大屏）
 */
export function shapeStickVector(
  rawX: number,
  rawY: number,
  deadzone: number,
): { x: number; y: number; mag: number } {
  const mag = Math.hypot(rawX, rawY);
  if (mag <= deadzone || mag < 1e-6) return { x: 0, y: 0, mag: 0 };
  const norm = Math.min(1, (mag - deadzone) / (1 - deadzone));
  // 前半段平缓（低斜率微调），后半段高次陡峭起飞
  const shaped = norm <= 0.55
    ? norm * 0.22 + Math.pow(norm, 3) * 0.55
    : 0.2125 + Math.pow((norm - 0.55) / 0.45, 2.0) * 1.1875;
  const ux = rawX / mag;
  const uy = rawY / mag;
  return { x: ux * shaped, y: uy * shaped, mag: norm };
}

/**
 * 跨平台右手 Joy-Con 状态机与映射引擎（纯 TypeScript，不依赖具体操作系统）。
 *
 * 默认键位：
 * - 摇杆：移动光标（按 R3 切换为平滑滚轮模式）
 * - R（上肩键）：鼠标左键（单击 / 按住拖动）
 * - ZR（下扳机）：语音输入（支持按住说话 / 点按开关）
 * - A：回车发送（Enter）
 * - B：录音时取消，平时鼠标右键
 * - X：切换窗口（Mac Cmd+Tab / Win Alt+Tab）
 * - Y：窗口概览（Mac 调度中心 / Win Win+Tab）
 * - +：撤销（Cmd/Ctrl+Z）
 * - Home：锁定 / 解锁防误触
 * - 大幅度体感手势（需开启 gesturesEnabled）：
 *   - 快速向左/右甩手腕：切换左/右虚拟桌面
 *   - 用力摇晃：撤销或取消录音
 */
export class JoyConMapper {
  private prev: JoyConButtons = { ...EMPTY_BUTTONS };
  private locked = false;
  private scrollMode = false;
  private leftDown = false;
  private voiceHeld = false;
  private lastGestureAt = 0;
  private yawStreak = 0;
  private yawStreakSign = 0;
  private lastYawFrameAt = 0;
  private impactQuietUntil = 0;
  private shakeHits = 0;
  private lastShakeHitAt = 0;

  // 亚像素累积器，保证极慢速微推时不会因为取整丢失位移
  private accX = 0;
  private accY = 0;
  private scrollAccX = 0;
  private scrollAccY = 0;
  // EMA 轻度平滑 + 外圈持续推满加速（Edge Ramp-up Boost）
  private smoothX = 0;
  private smoothY = 0;
  private edgeHoldStart = 0;
  // + 键轮盘状态机（短按退格删除，按住 >= 170ms 弹出 6 方向轮盘）
  private plusDownAt = 0;
  private radialOpen = false;
  private radialIdx = -1;
  // 松开轮盘后等待摇杆回中，防止大拇指还没松开摇杆导致光标乱跑
  private waitStickNeutral = false;
  // Home / 截图键：短按 = 区域截图进剪贴板，长按 >= 450ms = 锁定/解锁防误触
  private homeDownAt = 0;
  private homeLongFired = false;

  get isLocked() {
    return this.locked;
  }

  get isScrollMode() {
    return this.scrollMode;
  }

  setLocked(v: boolean): JoyConAction[] {
    if (this.locked === v) return [];
    this.locked = v;
    const actions: JoyConAction[] = [];
    if (v && this.leftDown) {
      this.leftDown = false;
      actions.push({ type: 'mouseUp', button: 'left' });
    }
    if (v && this.voiceHeld) {
      this.voiceHeld = false;
      actions.push({ type: 'voiceStop' });
    }
    actions.push({ type: 'notice', title: v ? 'Joy-Con 已锁定' : 'Joy-Con 已解锁', detail: v ? '再按 Home 恢复控制' : '可以继续控制光标和语音' });
    return actions;
  }

  reset(): JoyConAction[] {
    const actions: JoyConAction[] = [];
    if (this.leftDown) {
      this.leftDown = false;
      actions.push({ type: 'mouseUp', button: 'left' });
    }
    if (this.voiceHeld) {
      this.voiceHeld = false;
      actions.push({ type: 'voiceStop' });
    }
    if (this.radialOpen) {
      this.radialOpen = false;
      this.radialIdx = -1;
      actions.push({ type: 'radialClose' });
    }
    this.plusDownAt = 0;
    this.waitStickNeutral = false;
    this.homeDownAt = 0;
    this.homeLongFired = false;
    this.prev = { ...EMPTY_BUTTONS };
    this.accX = 0;
    this.accY = 0;
    this.scrollAccX = 0;
    this.scrollAccY = 0;
    this.smoothX = 0;
    this.smoothY = 0;
    this.edgeHoldStart = 0;
    return actions;
  }

  process(frame: JoyConFrame, cfg: JoyConSettings, ctx: MapperContext): JoyConAction[] {
    const actions: JoyConAction[] = [];
    const cur = frame.buttons;
    const prev = this.prev;
    const pressed = (k: keyof JoyConButtons) => cur[k] && !prev[k];
    const released = (k: keyof JoyConButtons) => !cur[k] && prev[k];

    // SL / SR 侧键随时可一键弹出/收起桌面漂浮键位速查浮窗
    if (pressed('sl') || pressed('sr')) {
      if (cfg.rumbleEnabled) actions.push({ type: 'rumble', pattern: 'soft' });
      actions.push({ type: 'toggleHud' });
      this.prev = { ...cur };
      return actions;
    }

    // Home / 截图键：
    // - 锁定状态下：短按或长按立即解锁
    // - 解锁状态下：短按 = 区域截图进剪贴板（不碰摇杆、光标不乱跑），长按 >= 450ms = 锁定防误触
    if (pressed('home')) {
      if (this.locked) {
        this.locked = false;
        this.homeDownAt = 0;
        this.homeLongFired = true;
        if (cfg.rumbleEnabled) actions.push({ type: 'rumble', pattern: 'tap' });
        actions.push({ type: 'notice', title: 'Joy-Con 已解锁', detail: '已恢复光标与语音控制' });
        this.prev = { ...cur };
        return actions;
      }
      this.homeDownAt = frame.ts;
      this.homeLongFired = false;
    }
    if (cur.home && !this.locked && !this.homeLongFired && this.homeDownAt > 0 && frame.ts - this.homeDownAt >= 450) {
      this.homeLongFired = true;
      this.homeDownAt = 0;
      this.locked = true;
      if (this.leftDown) {
        this.leftDown = false;
        actions.push({ type: 'mouseUp', button: 'left' });
      }
      if (this.voiceHeld) {
        this.voiceHeld = false;
        actions.push({ type: 'voiceStop' });
      }
      if (cfg.rumbleEnabled) actions.push({ type: 'rumble', pattern: 'double' });
      actions.push({ type: 'notice', title: 'Joy-Con 已锁定', detail: '防误触中，按一下 Home/截图键恢复' });
      this.prev = { ...cur };
      return actions;
    }
    if (released('home')) {
      if (!this.homeLongFired && this.homeDownAt > 0 && !this.locked) {
        if (cfg.rumbleEnabled) actions.push({ type: 'rumble', pattern: 'tap' });
        actions.push({ type: 'keyCombo', combo: 'screenshot' });
        actions.push({ type: 'notice', title: '区域截图（进剪贴板）', detail: '拖框截图后，上挑手腕直接粘贴' });
      }
      this.homeDownAt = 0;
      this.homeLongFired = false;
    }

    if (this.locked) {
      this.prev = { ...cur };
      return actions;
    }

    // 0. + 键：短按撤销，按住 >= 170ms 弹出 6 方向轮盘菜单（复制/粘贴/删除/全选/剪切/关标签）
    if (pressed('plus')) {
      this.plusDownAt = frame.ts;
    }
    if (cur.plus && !this.radialOpen && this.plusDownAt > 0 && frame.ts - this.plusDownAt >= 170) {
      this.radialOpen = true;
      this.radialIdx = -1;
      if (cfg.rumbleEnabled) actions.push({ type: 'rumble', pattern: 'soft' });
      actions.push({ type: 'radialOpen' });
    }
    if (this.radialOpen) {
      if (cur.plus) {
        const idx = radialIndexFromStick(frame.stickX, frame.stickY);
        if (idx !== this.radialIdx) {
          this.radialIdx = idx;
          if (idx >= 0 && cfg.rumbleEnabled) actions.push({ type: 'rumble', pattern: 'soft' });
        }
        actions.push({ type: 'radialSelect', index: this.radialIdx, stickX: frame.stickX, stickY: frame.stickY });
        this.prev = { ...cur };
        return actions;
      } else {
        const chosen = this.radialIdx;
        this.radialOpen = false;
        this.radialIdx = -1;
        this.plusDownAt = 0;
        // 松开轮盘后等摇杆回中，彻底杜绝光标顺着轮盘方向乱跑
        this.waitStickNeutral = true;
        this.smoothX = 0;
        this.smoothY = 0;
        this.accX = 0;
        this.accY = 0;
        actions.push({ type: 'radialClose' });
        if (chosen >= 0 && chosen < RADIAL_SECTORS.length) {
          const sec = RADIAL_SECTORS[chosen];
          if (cfg.rumbleEnabled) actions.push({ type: 'rumble', pattern: 'tap' });
          actions.push({ type: 'keyCombo', combo: sec.combo });
          actions.push({ type: 'notice', title: `轮盘：${sec.label}`, detail: `已发送 ${sec.key}` });
        }
        this.prev = { ...cur };
        return actions;
      }
    }
    if (released('plus') && this.plusDownAt > 0) {
      this.plusDownAt = 0;
      actions.push({ type: 'keyCombo', combo: 'backspace' });
    }

    // 1. 摇杆按下（R3）：切换光标 / 滚轮模式
    if (pressed('rStick')) {
      this.scrollMode = !this.scrollMode;
      this.accX = 0;
      this.accY = 0;
      this.scrollAccX = 0;
      this.scrollAccY = 0;
      if (cfg.rumbleEnabled) actions.push({ type: 'rumble', pattern: 'soft' });
      actions.push({
        type: 'notice',
        title: this.scrollMode ? 'Joy-Con：滚轮模式' : 'Joy-Con：光标模式',
        detail: this.scrollMode ? '推摇杆上下滚动，再按摇杆切回光标' : '推摇杆移动光标',
      });
    }

    // 2. 摇杆位移：径向圆形死区 + 双区精密曲线 + 外圈极速跨屏 + 轻量平滑
    const rawVec = shapeStickVector(frame.stickX, frame.stickY, cfg.deadzone);
    if (this.waitStickNeutral) {
      if (rawVec.mag === 0) {
        this.waitStickNeutral = false;
      }
    }
    if (rawVec.mag === 0 || this.waitStickNeutral) {
      this.smoothX = 0;
      this.smoothY = 0;
      this.edgeHoldStart = 0;
    } else {
      // EMA 滤波：消除摇杆电位器微小抖动，手感更顺滑
      const alpha = 0.48;
      this.smoothX = this.smoothX === 0 ? rawVec.x : this.smoothX + (rawVec.x - this.smoothX) * alpha;
      this.smoothY = this.smoothY === 0 ? rawVec.y : this.smoothY + (rawVec.y - this.smoothY) * alpha;

      if (this.scrollMode) {
        this.edgeHoldStart = 0;
        this.scrollAccX += this.smoothX * cfg.scrollSpeed;
        this.scrollAccY += this.smoothY * cfg.scrollSpeed;
        const dx = Math.trunc(this.scrollAccX);
        const dy = Math.trunc(this.scrollAccY);
        if (dx !== 0 || dy !== 0) {
          this.scrollAccX -= dx;
          this.scrollAccY -= dy;
          actions.push({ type: 'mouseScroll', dx, dy });
        }
      } else {
        // 外圈极速跨屏：推满（>0.88）持续超过 140ms 后，速度在 320ms 内平滑叠乘到 2.3 倍
        let boost = 1.0;
        if (rawVec.mag >= 0.88) {
          if (this.edgeHoldStart === 0) this.edgeHoldStart = frame.ts;
          const heldMs = frame.ts - this.edgeHoldStart;
          if (heldMs > 140) {
            boost = 1.0 + Math.min(1.0, (heldMs - 140) / 320) * 1.3;
          }
        } else {
          this.edgeHoldStart = 0;
        }
        // 按住 R 拖动时微操区自动加细腻阻尼，选字/拖窗口更稳
        const dragFactor = this.leftDown && rawVec.mag < 0.75 ? 0.68 : 1.0;
        const speed = cfg.cursorSpeed * boost * dragFactor;

        // 屏幕坐标 Y 轴向下为正，摇杆向上为正，所以取 -smoothY
        this.accX += this.smoothX * speed;
        this.accY += -this.smoothY * speed;
        const dx = Math.trunc(this.accX);
        const dy = Math.trunc(this.accY);
        if (dx !== 0 || dy !== 0) {
          this.accX -= dx;
          this.accY -= dy;
          actions.push({ type: 'mouseMove', dx, dy });
        }
      }
    }

    // 3. R 键：鼠标左键（单击 / 按住拖动）
    if (pressed('r')) {
      this.leftDown = true;
      actions.push({ type: 'mouseDown', button: 'left' });
    } else if (released('r') && this.leftDown) {
      this.leftDown = false;
      actions.push({ type: 'mouseUp', button: 'left' });
    }

    // 4. ZR 键：触发语写语音输入
    if (cfg.voiceMode === 'hold') {
      if (pressed('zr')) {
        this.voiceHeld = true;
        if (cfg.rumbleEnabled) actions.push({ type: 'rumble', pattern: 'tap' });
        actions.push({ type: 'voiceStart' });
      } else if (released('zr') && this.voiceHeld) {
        this.voiceHeld = false;
        if (cfg.rumbleEnabled) actions.push({ type: 'rumble', pattern: 'soft' });
        actions.push({ type: 'voiceStop' });
      }
    } else {
      if (pressed('zr')) {
        if (cfg.rumbleEnabled) actions.push({ type: 'rumble', pattern: 'tap' });
        actions.push({ type: 'voiceToggle' });
      }
    }

    // 5. A 键：回车发送
    if (pressed('a')) {
      actions.push({ type: 'keyCombo', combo: 'enter' });
    }

    // 6. B 键：录音或处理中取消，平时鼠标右键
    if (pressed('b')) {
      if (ctx.isRecording || ctx.isBusy) {
        if (cfg.rumbleEnabled) actions.push({ type: 'rumble', pattern: 'double' });
        actions.push({ type: 'voiceCancel' });
      } else {
        actions.push({ type: 'mouseClick', button: 'right' });
      }
    }

    // 7. X 键：快速切换窗口（Cmd+Tab / Alt+Tab）
    if (pressed('x')) {
      actions.push({ type: 'keyCombo', combo: 'switch_window' });
    }

    // 8. Y 键：窗口概览（调度中心 / Win+Tab）
    if (pressed('y')) {
      actions.push({ type: 'keyCombo', combo: 'mission_control' });
    }

    // 10. 高频正交体感手势（硬件层已统一归一化左右手坐标系，此处逻辑左右手 100% 共享）：
    // - 放桌防误触：检测到桌面撞击加速度尖峰（> 2.8g）后静默 260ms，过滤放回桌面的瞬态震动
    // - 左甩手腕（yaw > 440 连续 >= 3 帧 / ~50ms）：撤销（⌘Z，刚说错一整句瞬间撤回）
    // - 右甩手腕（yaw < -440 连续 >= 3 帧 / ~50ms）：切换上一个窗口（⌘Tab，浏览器与 Agent 间秒切）
    // - 上挑手腕（使用 x/y 平面合角速度，兼容正握/侧握/躺姿斜握，避免单轴分摊漏检）：粘贴（⌘V）
    if (cfg.gesturesEnabled && !this.leftDown && !ctx.isRecording && frame.gyro && frame.accel) {
      const now = frame.ts;
      const accelMag = Math.hypot(frame.accel.x, frame.accel.y, frame.accel.z);
      if (accelMag > 2.8) {
        this.impactQuietUntil = now + 260;
        this.yawStreak = 0;
        this.yawStreakSign = 0;
      } else if (now >= this.impactQuietUntil && now - this.lastGestureAt > 950) {
        const yaw = frame.gyro.z;
        const absYaw = Math.abs(yaw);
        const pitchMag = Math.hypot(frame.gyro.x, frame.gyro.y);

        if (absYaw > 440 && absYaw > pitchMag * 1.6) {
          const sign = yaw > 0 ? 1 : -1;
          if (sign === this.yawStreakSign && now - this.lastYawFrameAt <= 70) {
            this.yawStreak += 1;
          } else {
            this.yawStreak = 1;
            this.yawStreakSign = sign;
          }
          this.lastYawFrameAt = now;

          if (this.yawStreak >= 3) {
            this.yawStreak = 0;
            this.yawStreakSign = 0;
            this.lastGestureAt = now;
            if (cfg.rumbleEnabled) actions.push({ type: 'rumble', pattern: 'tap' });
            if (sign > 0) {
              actions.push({ type: 'keyCombo', combo: 'undo' });
              actions.push({ type: 'notice', title: '左甩手腕：撤销', detail: '已发送 ⌘Z' });
            } else {
              actions.push({ type: 'keyCombo', combo: 'switch_window' });
            }
          }
        } else {
          this.yawStreak = 0;
          this.yawStreakSign = 0;
          if (pitchMag > 265 && pitchMag > absYaw * 1.25) {
            this.lastGestureAt = now;
            if (cfg.rumbleEnabled) actions.push({ type: 'rumble', pattern: 'tap' });
            actions.push({ type: 'keyCombo', combo: 'paste' });
            actions.push({ type: 'notice', title: '上挑手腕：粘贴', detail: '已发送 ⌘V（文字 / 截图）' });
          }
        }
      } else {
        this.yawStreak = 0;
        this.yawStreakSign = 0;
      }
    } else {
      this.yawStreak = 0;
      this.yawStreakSign = 0;
    }

    this.prev = { ...cur };
    return actions;
  }
}
