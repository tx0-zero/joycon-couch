#!/usr/bin/env python3
"""
Yuxie Joy-Con Windows/Linux 跨平台桥接脚本（与 macOS JoyConHelper.swift 完全同协议）
依赖：pip install hidapi
Windows 键鼠模拟直接调用原生 user32.SendInput（无需额外依赖）。
"""

import ctypes
import json
import struct
import sys
import threading
import time

NINTENDO_VID = 0x057E
JOYCON_L_PID = 0x2006
JOYCON_R_PID = 0x2007


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class WinInput:
    """Windows 原生 user32.SendInput 封装（零外部依赖）。"""

    def __init__(self):
        self.is_win = sys.platform == "win32"
        if self.is_win:
            self.user32 = ctypes.windll.user32

    def _mouse_event(self, flags, dx=0, dy=0, data=0):
        if not self.is_win:
            return
        self.user32.mouse_event(flags, int(dx), int(dy), int(data), 0)

    def move(self, dx, dy):
        self._mouse_event(0x0001, dx, dy)  # MOUSEEVENTF_MOVE

    def mouse_down(self, button):
        self._mouse_event(0x0002 if button == "left" else 0x0008)

    def mouse_up(self, button):
        self._mouse_event(0x0004 if button == "left" else 0x0010)

    def mouse_click(self, button):
        self.mouse_down(button)
        self.mouse_up(button)

    def scroll(self, dx, dy):
        if dy:
            self._mouse_event(0x0800, 0, 0, int(dy * 20))  # WHEEL
        if dx:
            self._mouse_event(0x1000, 0, 0, int(dx * 20))  # HWHEEL

    def _key(self, vk, up=False):
        if not self.is_win:
            return
        self.user32.keybd_event(vk, 0, 0x0002 if up else 0, 0)

    def _combo(self, *vks):
        for vk in vks:
            self._key(vk, False)
        for vk in reversed(vks):
            self._key(vk, True)

    def key_combo(self, combo):
        if not self.is_win:
            return
        VK_RETURN = 0x0D
        VK_ESCAPE = 0x1B
        VK_TAB = 0x09
        VK_CONTROL = 0x11
        VK_MENU = 0x12  # Alt
        VK_LWIN = 0x5B
        VK_LEFT = 0x25
        VK_RIGHT = 0x27
        VK_Z = 0x5A

        mapping = {
            "enter": (VK_RETURN,),
            "escape": (VK_ESCAPE,),
            "undo": (VK_CONTROL, VK_Z),
            "copy": (VK_CONTROL, 0x43),
            "paste": (VK_CONTROL, 0x56),
            "cut": (VK_CONTROL, 0x58),
            "select_all": (VK_CONTROL, 0x41),
            "backspace": (0x08,),
            "screenshot": (VK_LWIN, 0x10, 0x53),
            "close_tab": (VK_CONTROL, 0x57),
            "switch_window": (VK_MENU, VK_TAB),
            "mission_control": (VK_LWIN, VK_TAB),
            "desktop_left": (VK_CONTROL, VK_LWIN, VK_LEFT),
            "desktop_right": (VK_CONTROL, VK_LWIN, VK_RIGHT),
            "voice_hotkey": (VK_CONTROL, VK_MENU, 0x20),
            "voice_ctrl_alt_space": (VK_CONTROL, VK_MENU, 0x20),
            "voice_opt_space": (VK_MENU, 0x20),
            "voice_cmd_shift_space": (VK_CONTROL, 0x10, 0x20),
            "voice_win_h": (VK_LWIN, 0x48),
            "voice_f13": (0x7C,),
        }
        if combo == "clear_all":
            self._combo(VK_CONTROL, 0x41)
            time.sleep(0.03)
            self._combo(0x08)
            return
        vks = mapping.get(combo)
        if vks:
            self._combo(*vks)


class JoyConWinBridge:
    def __init__(self, target_side="right"):
        self.target_side = target_side
        self.dev = None
        self.side = target_side
        self.pkt = 0
        self.lock = threading.Lock()
        self.win_input = WinInput()

    def send_subcmd(self, subcmd, data=b""):
        with self.lock:
            if not self.dev:
                return
            buf = bytearray(49)
            buf[0] = 0x01
            buf[1] = self.pkt & 0x0F
            self.pkt = (self.pkt + 1) & 0xFF
            buf[2:10] = bytes([0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40])
            buf[10] = subcmd
            buf[11 : 11 + len(data)] = data
            self.dev.write(bytes(buf))

    def rumble(self, pattern="tap"):
        strong = bytes([0x28, 0xC8, 0x60, 0x72, 0x28, 0xC8, 0x60, 0x72])
        soft = bytes([0x28, 0x88, 0x50, 0x64, 0x28, 0x88, 0x50, 0x64])
        off = bytes([0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40])

        def raw(payload):
            with self.lock:
                if not self.dev:
                    return
                buf = bytearray(10)
                buf[0] = 0x10
                buf[1] = self.pkt & 0x0F
                self.pkt = (self.pkt + 1) & 0xFF
                buf[2:10] = payload
                try:
                    self.dev.write(bytes(buf))
                except Exception:
                    pass

        def run():
            if pattern == "double":
                raw(strong)
                time.sleep(0.05)
                raw(off)
                time.sleep(0.06)
                raw(strong)
                time.sleep(0.06)
                raw(off)
            elif pattern == "soft":
                raw(soft)
                time.sleep(0.045)
                raw(off)
            else:
                raw(strong)
                time.sleep(0.06)
                raw(off)

        threading.Thread(target=run, daemon=True).start()

    def stdin_loop(self):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            t = msg.get("type")
            if t == "mouseMove":
                self.win_input.move(msg.get("dx", 0), msg.get("dy", 0))
            elif t == "mouseDown":
                self.win_input.mouse_down(msg.get("button", "left"))
            elif t == "mouseUp":
                self.win_input.mouse_up(msg.get("button", "left"))
            elif t == "mouseClick":
                self.win_input.mouse_click(msg.get("button", "left"))
            elif t == "mouseScroll":
                self.win_input.scroll(msg.get("dx", 0), msg.get("dy", 0))
            elif t == "keyCombo":
                self.win_input.key_combo(msg.get("combo", ""))
            elif t == "rumble":
                self.rumble(msg.get("pattern", "tap"))

    def run(self):
        try:
            import hid  # type: ignore
        except ImportError:
            emit({"event": "error", "message": "Windows 端请先执行 pip install hidapi"})
            return

        threading.Thread(target=self.stdin_loop, daemon=True).start()
        emit({"event": "ready"})

        pids = [JOYCON_L_PID, JOYCON_R_PID] if self.target_side == "left" else [JOYCON_R_PID, JOYCON_L_PID]

        while True:
            found = None
            for pid in pids:
                infos = hid.enumerate(NINTENDO_VID, pid)
                if infos:
                    found = (pid, infos[0]["path"])
                    break

            if not found:
                time.sleep(1.0)
                continue

            pid, path = found
            self.side = "left" if pid == JOYCON_L_PID else "right"
            try:
                dev = hid.device()
                dev.open_path(path)
                dev.set_nonblocking(False)
                self.dev = dev
            except Exception as e:
                emit({"event": "error", "message": f"打开 Joy-Con 失败: {e}"})
                time.sleep(1.5)
                continue

            try:
                time.sleep(0.05)
                self.send_subcmd(0x03, b"\x30")
                time.sleep(0.05)
                self.send_subcmd(0x40, b"\x01")
                time.sleep(0.05)
                self.send_subcmd(0x48, b"\x01")
                time.sleep(0.05)
                self.send_subcmd(0x30, b"\x01")
                emit({"event": "connected", "side": self.side})

                calib_n = 0
                sum_x = 0.0
                sum_y = 0.0
                cx, cy = 2048.0, 2048.0

                while True:
                    data = dev.read(64, timeout_ms=200)
                    if not data:
                        continue
                    if data[0] != 0x30 or len(data) < 49:
                        continue
                    b3, b4, b5 = data[3], data[4], data[5]
                    off = 6 if self.side == "left" else 9
                    s0, s1, s2 = data[off], data[off + 1], data[off + 2]
                    rx = float(s0 | ((s1 & 0x0F) << 8))
                    ry = float((s1 >> 4) | (s2 << 4))
                    if calib_n < 12:
                        sum_x += rx
                        sum_y += ry
                        calib_n += 1
                        if calib_n == 12:
                            cx, cy = sum_x / 12.0, sum_y / 12.0
                        continue

                    nx = max(-1.0, min(1.0, (rx - cx) / 1350.0))
                    ny = max(-1.0, min(1.0, (ry - cy) / 1350.0))
                    ax, ay, az, gx, gy, gz = struct.unpack_from("<hhhhhh", bytes(data), 13)
                    imu_sign = -1.0 if self.side == "left" else 1.0
                    buttons = (
                        {
                            "y": bool(b5 & 0x08),
                            "x": bool(b5 & 0x02),
                            "b": bool(b5 & 0x01),
                            "a": bool(b5 & 0x04),
                            "sr": bool(b5 & 0x10),
                            "sl": bool(b5 & 0x20),
                            "r": bool(b5 & 0x40),
                            "zr": bool(b5 & 0x80),
                            "plus": bool(b4 & 0x01),
                            "rStick": bool(b4 & 0x08),
                            "home": bool(b4 & 0x20),
                        }
                        if self.side == "left"
                        else {
                            "y": bool(b3 & 0x01),
                            "x": bool(b3 & 0x02),
                            "b": bool(b3 & 0x04),
                            "a": bool(b3 & 0x08),
                            "sr": bool(b3 & 0x10),
                            "sl": bool(b3 & 0x20),
                            "r": bool(b3 & 0x40),
                            "zr": bool(b3 & 0x80),
                            "plus": bool(b4 & 0x02),
                            "rStick": bool(b4 & 0x04),
                            "home": bool(b4 & 0x10),
                        }
                    )
                    emit(
                        {
                            "event": "frame",
                            "frame": {
                                "side": self.side,
                                "ts": int(time.time() * 1000),
                                "stickX": nx,
                                "stickY": ny,
                                "buttons": buttons,
                                "accel": {"x": ax * 0.000244, "y": ay * 0.000244, "z": az * 0.000244},
                                "gyro": {"x": gx * 0.06103 * imu_sign, "y": gy * 0.06103 * imu_sign, "z": gz * 0.06103 * imu_sign},
                            },
                        }
                    )
            except Exception:
                pass
            finally:
                with self.lock:
                    try:
                        if self.dev:
                            self.dev.close()
                    except Exception:
                        pass
                    self.dev = None
                emit({"event": "disconnected"})
                time.sleep(1.0)


if __name__ == "__main__":
    side = "right"
    if "--side" in sys.argv:
        idx = sys.argv.index("--side")
        if idx + 1 < len(sys.argv):
            side = sys.argv[idx + 1]
    JoyConWinBridge(side).run()
