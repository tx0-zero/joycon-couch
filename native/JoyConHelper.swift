import Foundation
import IOKit
import IOKit.hid
import CoreGraphics
import ApplicationServices

// Yuxie Joy-Con 原生 macOS 桥接（IOKit HID + CoreGraphics）
// 协议：stdin 接收 JSON 行指令，stdout 输出 JSON 行事件（ready / connected / disconnected / frame / error）

let NINTENDO_VID = 0x057e
let JOYCON_L_PID = 0x2006
let JOYCON_R_PID = 0x2007

final class OutputWriter {
    private let q = DispatchQueue(label: "yuxie.joycon.out")
    func send(_ obj: [String: Any]) {
        q.async {
            if let data = try? JSONSerialization.data(withJSONObject: obj),
               let line = String(data: data, encoding: .utf8) {
                FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
            }
        }
    }
}

let out = OutputWriter()

final class MouseAndKeyController {
    private var leftButtonDown = false
    private var lastClickTime: TimeInterval = 0
    private var lastClickPos: CGPoint = .zero
    private var clickCount: Int64 = 1

    private func currentPos() -> CGPoint {
        return CGEvent(source: nil)?.location ?? CGPoint(x: 400, y: 400)
    }

    private func clampToDisplays(_ p: CGPoint) -> CGPoint {
        var count: UInt32 = 0
        CGGetOnlineDisplayList(0, nil, &count)
        guard count > 0 else { return p }
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetOnlineDisplayList(count, &displays, &count)
        var unionRect = CGRect.null
        for d in displays {
            unionRect = unionRect.union(CGDisplayBounds(d))
        }
        guard !unionRect.isNull else { return p }
        return CGPoint(
            x: max(unionRect.minX, min(unionRect.maxX - 1, p.x)),
            y: max(unionRect.minY, min(unionRect.maxY - 1, p.y))
        )
    }

    func move(dx: Double, dy: Double) {
        let cur = currentPos()
        let next = clampToDisplays(CGPoint(x: cur.x + dx, y: cur.y + dy))
        let eventType: CGEventType = leftButtonDown ? .leftMouseDragged : .mouseMoved
        if let ev = CGEvent(mouseEventSource: nil, mouseType: eventType, mouseCursorPosition: next, mouseButton: .left) {
            ev.flags = []
            ev.setDoubleValueField(.mouseEventDeltaX, value: dx)
            ev.setDoubleValueField(.mouseEventDeltaY, value: dy)
            ev.post(tap: .cghidEventTap)
        }
    }

    func mouseDown(button: String) {
        let pos = currentPos()
        let now = Date().timeIntervalSince1970
        if button == "left" {
            leftButtonDown = true
            let dist = hypot(pos.x - lastClickPos.x, pos.y - lastClickPos.y)
            if now - lastClickTime < 0.32 && dist < 8 {
                clickCount = min(3, clickCount + 1)
            } else {
                clickCount = 1
            }
            lastClickTime = now
            lastClickPos = pos
            if let ev = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: pos, mouseButton: .left) {
                ev.flags = []
                ev.setIntegerValueField(.mouseEventClickState, value: clickCount)
                ev.post(tap: .cghidEventTap)
            }
        } else {
            if let ev = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: pos, mouseButton: .right) {
                ev.flags = []
                ev.post(tap: .cghidEventTap)
            }
        }
    }

    func mouseUp(button: String) {
        let pos = currentPos()
        if button == "left" {
            leftButtonDown = false
            if let ev = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: pos, mouseButton: .left) {
                ev.flags = []
                ev.setIntegerValueField(.mouseEventClickState, value: clickCount)
                ev.post(tap: .cghidEventTap)
            }
        } else {
            if let ev = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: pos, mouseButton: .right) {
                ev.flags = []
                ev.post(tap: .cghidEventTap)
            }
        }
    }

    func mouseClick(button: String) {
        mouseDown(button: button)
        mouseUp(button: button)
    }

    func scroll(dx: Int32, dy: Int32) {
        if let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy * 4, wheel2: -dx * 4, wheel3: 0) {
            ev.flags = []
            ev.post(tap: .cghidEventTap)
        }
    }

    private func sendKey(_ keyCode: CGKeyCode, flags: CGEventFlags = []) {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else { return }
        down.flags = flags
        up.flags = []
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        if !flags.isEmpty {
            // 复位系统修饰键状态，防止 Control/Command 残留导致后续左键变成右键菜单
            if let reset = CGEvent(keyboardEventSource: nil, virtualKey: 59, keyDown: false) {
                reset.type = .flagsChanged
                reset.flags = []
                reset.post(tap: .cghidEventTap)
            }
        }
    }

    func keyCombo(_ combo: String) {
        switch combo {
        case "enter":
            sendKey(36) // Return
        case "escape":
            sendKey(53) // Escape
        case "undo":
            sendKey(6, flags: .maskCommand) // Cmd+Z
        case "copy":
            sendKey(8, flags: .maskCommand) // Cmd+C
        case "paste":
            sendKey(9, flags: .maskCommand) // Cmd+V
        case "cut":
            sendKey(7, flags: .maskCommand) // Cmd+X
        case "select_all":
            sendKey(0, flags: .maskCommand) // Cmd+A
        case "backspace":
            sendKey(51) // Delete / Backspace
        case "close_tab":
            sendKey(13, flags: .maskCommand) // Cmd+W
        case "switch_window":
            sendKey(48, flags: .maskCommand) // Cmd+Tab
        case "mission_control":
            sendKey(126, flags: .maskControl) // Ctrl+Up
        case "desktop_left":
            sendKey(123, flags: .maskControl) // Ctrl+Left
        case "desktop_right":
            sendKey(124, flags: .maskControl) // Ctrl+Right
        case "voice_hotkey", "voice_ctrl_alt_space":
            sendKey(49, flags: [.maskControl, .maskAlternate]) // Ctrl+Opt+Space
        case "voice_opt_space":
            sendKey(49, flags: .maskAlternate) // Opt+Space
        case "voice_cmd_shift_space":
            sendKey(49, flags: [.maskCommand, .maskShift]) // Cmd+Shift+Space
        case "voice_win_h":
            sendKey(4, flags: .maskCommand)
        case "voice_f13":
            sendKey(105) // F13
        default:
            break
        }
    }
}

final class JoyConHIDBridge {
    private var manager: IOHIDManager?
    private var device: IOHIDDevice?
    private var connectedSide: String = "right"
    private let targetSide: String
    private var packetCounter: UInt8 = 0
    private var reportBuffer = [UInt8](repeating: 0, count: 512)

    // 智能静止中心校准（跳过连接初期 10 帧，连续 16 帧静止波动 < 45 才锁定中心，彻底避免配对时误触导致漂移）
    private var centerX: Double = 2048.0
    private var centerY: Double = 2048.0
    private var calibrated = false
    private var skipFrames = 0
    private var calibBufX: [Double] = []
    private var calibBufY: [Double] = []

    init(targetSide: String) {
        self.targetSide = targetSide
    }

    func start() {
        let mgr = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        self.manager = mgr

        let matchR: [String: Any] = [
            kIOHIDVendorIDKey as String: NINTENDO_VID,
            kIOHIDProductIDKey as String: JOYCON_R_PID
        ]
        let matchL: [String: Any] = [
            kIOHIDVendorIDKey as String: NINTENDO_VID,
            kIOHIDProductIDKey as String: JOYCON_L_PID
        ]
        let criteria: [[String: Any]] = targetSide == "left" ? [matchL, matchR] : [matchR, matchL]
        IOHIDManagerSetDeviceMatchingMultiple(mgr, criteria as CFArray)

        let ctx = Unmanaged.passUnretained(self).toOpaque()

        IOHIDManagerRegisterDeviceMatchingCallback(mgr, { context, _, _, device in
            guard let context = context else { return }
            let bridge = Unmanaged<JoyConHIDBridge>.fromOpaque(context).takeUnretainedValue()
            bridge.onDeviceConnected(device)
        }, ctx)

        IOHIDManagerRegisterDeviceRemovalCallback(mgr, { context, _, _, device in
            guard let context = context else { return }
            let bridge = Unmanaged<JoyConHIDBridge>.fromOpaque(context).takeUnretainedValue()
            bridge.onDeviceRemoved(device)
        }, ctx)

        IOHIDManagerScheduleWithRunLoop(mgr, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
        let res = IOHIDManagerOpen(mgr, IOOptionBits(kIOHIDOptionsTypeNone))
        if res != kIOReturnSuccess {
            out.send(["event": "error", "message": "无法打开 IOHIDManager（错误码 \(res)），请检查输入监控权限"])
            return
        }
        out.send(["event": "ready"])
    }

    private func sendSubcommand(_ subcmd: UInt8, data: [UInt8] = [], rumble: [UInt8]? = nil) {
        guard let dev = self.device else { return }
        var buf = [UInt8](repeating: 0, count: 49)
        buf[0] = 0x01 // Rumble + Subcommand output report
        buf[1] = packetCounter & 0x0f
        packetCounter = packetCounter &+ 1

        // Neutral rumble bytes
        let r = rumble ?? [0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40]
        for i in 0..<min(8, r.count) {
            buf[2 + i] = r[i]
        }
        buf[10] = subcmd
        for i in 0..<min(38, data.count) {
            buf[11 + i] = data[i]
        }
        IOHIDDeviceSetReport(dev, kIOHIDReportTypeOutput, CFIndex(buf[0]), buf, buf.count)
    }

    func rumble(pattern: String) {
        guard self.device != nil else { return }
        // 同时写入左右手震动通道（bytes 0..3 为左手，4..7 为右手），左右手都能清脆震动
        let strong: [UInt8] = [0x28, 0xc8, 0x60, 0x72, 0x28, 0xc8, 0x60, 0x72]
        let soft: [UInt8]   = [0x28, 0x88, 0x50, 0x64, 0x28, 0x88, 0x50, 0x64]
        let off: [UInt8]    = [0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40]

        func sendRawRumble(_ bytes: [UInt8]) {
            guard let dev = self.device else { return }
            var buf = [UInt8](repeating: 0, count: 10)
            buf[0] = 0x10
            buf[1] = packetCounter & 0x0f
            packetCounter = packetCounter &+ 1
            for i in 0..<8 { buf[2 + i] = bytes[i] }
            IOHIDDeviceSetReport(dev, kIOHIDReportTypeOutput, CFIndex(buf[0]), buf, buf.count)
        }

        if pattern == "double" {
            sendRawRumble(strong)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { sendRawRumble(off) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.11) { sendRawRumble(strong) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.17) { sendRawRumble(off) }
        } else if pattern == "soft" {
            sendRawRumble(soft)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.045) { sendRawRumble(off) }
        } else {
            sendRawRumble(strong)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { sendRawRumble(off) }
        }
    }

    private func detachCurrentDevice() {
        if let old = self.device {
            IOHIDDeviceRegisterInputReportCallback(old, &reportBuffer, reportBuffer.count, nil, nil)
            IOHIDDeviceUnscheduleFromRunLoop(old, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
            IOHIDDeviceClose(old, IOOptionBits(kIOHIDOptionsTypeNone))
            self.device = nil
        }
    }

    private func onDeviceConnected(_ dev: IOHIDDevice) {
        if let cur = self.device, cur === dev { return }
        // 若另一只 Joy-Con 仍在占位，先干净释放，允许左右手无缝热切换
        if self.device != nil {
            detachCurrentDevice()
        }
        let pidVal = IOHIDDeviceGetProperty(dev, kIOHIDProductIDKey as CFString) as? Int ?? JOYCON_R_PID
        let side = (pidVal == JOYCON_L_PID) ? "left" : "right"
        self.device = dev
        self.connectedSide = side
        self.calibrated = false
        self.skipFrames = 10
        self.calibBufX.removeAll(keepingCapacity: true)
        self.calibBufY.removeAll(keepingCapacity: true)
        self.centerX = 2048.0
        self.centerY = 2048.0

        // 使用共享模式（kIOHIDOptionsTypeNone），避免 SeizeDevice 导致 macOS 蓝牙/GameController 栈重连卡死在 ACL 假连接
        IOHIDDeviceOpen(dev, IOOptionBits(kIOHIDOptionsTypeNone))
        IOHIDDeviceScheduleWithRunLoop(dev, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)

        let ctx = Unmanaged.passUnretained(self).toOpaque()
        IOHIDDeviceRegisterInputReportCallback(dev, &reportBuffer, reportBuffer.count, { context, _, _, _, reportID, report, reportLength in
            guard let context = context else { return }
            let bridge = Unmanaged<JoyConHIDBridge>.fromOpaque(context).takeUnretainedValue()
            bridge.onInputReport(reportID: reportID, report: report, length: reportLength)
        }, ctx)

        // 依次初始化：立即开启 60Hz 标准完整报告模式(0x30)、开启 IMU(0x40)、开启震动(0x48)、亮起 1 号绿灯(0x30)
        self.sendSubcommand(0x03, data: [0x30])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { self.sendSubcommand(0x40, data: [0x01]) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) { self.sendSubcommand(0x48, data: [0x01]) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.24) { self.sendSubcommand(0x30, data: [0x01]) }

        if !AXIsProcessTrusted() {
            out.send(["event": "error", "message": "缺少辅助功能权限，无法控制鼠标，请在系统设置勾选 Yuxie Dev"])
        }
        out.send(["event": "connected", "side": side])
    }

    private func onDeviceRemoved(_ dev: IOHIDDevice) {
        guard self.device === dev else { return }
        detachCurrentDevice()
        out.send(["event": "disconnected"])
    }

    private func readInt16LE(_ p: UnsafeMutablePointer<UInt8>, _ offset: Int) -> Int16 {
        let lo = UInt16(p[offset])
        let hi = UInt16(p[offset + 1])
        return Int16(bitPattern: lo | (hi << 8))
    }

    private func onInputReport(reportID: UInt32, report: UnsafeMutablePointer<UInt8>, length: CFIndex) {
        // 如果手柄仍处于 0x3F 简短模式，自动补发切换 0x30 完整模式指令
        if reportID == 0x3f {
            self.sendSubcommand(0x03, data: [0x30])
            return
        }
        // 标准完整输入报告 0x30（长度通常 >= 49 字节）
        guard reportID == 0x30, length >= 49 else { return }

        let b3 = report[3] // Right: Y(0), X(1), B(2), A(3), SR(4), SL(5), R(6), ZR(7)
        let b4 = report[4] // Shared: Minus(0), Plus(1), RStick(2), LStick(3), Home(4), Capture(5)
        let b5 = report[5] // Left: Down(0), Up(1), Right(2), Left(3), SR(4), SL(5), L(6), ZL(7)

        // 右手摇杆位于 bytes 9..11（左手位于 6..8）
        let stickOffset = (connectedSide == "left") ? 6 : 9
        let s0 = UInt16(report[stickOffset])
        let s1 = UInt16(report[stickOffset + 1])
        let s2 = UInt16(report[stickOffset + 2])
        let rawX = Double(s0 | ((s1 & 0x0f) << 8))
        let rawY = Double((s1 >> 4) | (s2 << 4))

        if !calibrated {
            if skipFrames > 0 {
                skipFrames -= 1
                return
            }
            calibBufX.append(rawX)
            calibBufY.append(rawY)
            if calibBufX.count >= 16 {
                let spanX = (calibBufX.max() ?? 0) - (calibBufX.min() ?? 0)
                let spanY = (calibBufY.max() ?? 0) - (calibBufY.min() ?? 0)
                if spanX < 60 && spanY < 60 {
                    centerX = calibBufX.reduce(0, +) / Double(calibBufX.count)
                    centerY = calibBufY.reduce(0, +) / Double(calibBufY.count)
                    calibrated = true
                } else {
                    // 刚连接时用户手还在动摇杆：丢弃这批重新等手松开静止
                    calibBufX.removeAll(keepingCapacity: true)
                    calibBufY.removeAll(keepingCapacity: true)
                }
            }
            return
        }

        // Joy-Con 摇杆有效半径约 1350 左右
        let normX = max(-1.0, min(1.0, (rawX - centerX) / 1350.0))
        let normY = max(-1.0, min(1.0, (rawY - centerY) / 1350.0))

        // 6 轴 IMU（bytes 13..24 为第 1 组采样）
        let ax = Double(readInt16LE(report, 13)) * 0.000244
        let ay = Double(readInt16LE(report, 15)) * 0.000244
        let az = Double(readInt16LE(report, 17)) * 0.000244
        let gx = Double(readInt16LE(report, 19)) * 0.06103
        let gy = Double(readInt16LE(report, 21)) * 0.06103
        let gz = Double(readInt16LE(report, 23)) * 0.06103

        // 左右手完全对称映射到统一逻辑按键：
        // 左手：L->r, ZL->zr, →->a(回车), ↓->b(右键/取消), ↑->x(切窗口), ←->y(概览), - ->plus(撤销/轮盘), L3->rStick(切滚轮), 截图键->home(锁定)
        let buttons: [String: Bool] = (connectedSide == "left") ? [
            "y": (b5 & 0x08) != 0,     // 左方向键 ←
            "x": (b5 & 0x02) != 0,     // 上方向键 ↑
            "b": (b5 & 0x01) != 0,     // 下方向键 ↓
            "a": (b5 & 0x04) != 0,     // 右方向键 →
            "sr": (b5 & 0x10) != 0,
            "sl": (b5 & 0x20) != 0,
            "r": (b5 & 0x40) != 0,     // L 上肩键
            "zr": (b5 & 0x80) != 0,    // ZL 下扳机
            "plus": (b4 & 0x01) != 0,  // - 键
            "rStick": (b4 & 0x08) != 0,// 按下左摇杆 L3
            "home": (b4 & 0x20) != 0   // 方形截图键
        ] : [
            "y": (b3 & 0x01) != 0,
            "x": (b3 & 0x02) != 0,
            "b": (b3 & 0x04) != 0,
            "a": (b3 & 0x08) != 0,
            "sr": (b3 & 0x10) != 0,
            "sl": (b3 & 0x20) != 0,
            "r": (b3 & 0x40) != 0,
            "zr": (b3 & 0x80) != 0,
            "plus": (b4 & 0x02) != 0,
            "rStick": (b4 & 0x04) != 0,
            "home": (b4 & 0x10) != 0
        ]

        out.send([
            "event": "frame",
            "frame": [
                "side": connectedSide,
                "ts": Int(Date().timeIntervalSince1970 * 1000),
                "stickX": normX,
                "stickY": normY,
                "buttons": buttons,
                "accel": ["x": ax, "y": ay, "z": az],
                "gyro": ["x": gx, "y": gy, "z": gz]
            ]
        ])
    }
}

// 解析命令行参数
var targetSide = "right"
let args = CommandLine.arguments
if let idx = args.firstIndex(of: "--side"), idx + 1 < args.count {
    targetSide = args[idx + 1]
}

let hidBridge = JoyConHIDBridge(targetSide: targetSide)
let mouseKey = MouseAndKeyController()
hidBridge.start()

// 后台线程读取 stdin 指令
DispatchQueue.global(qos: .userInteractive).async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { continue }

        DispatchQueue.main.async {
            switch type {
            case "mouseMove":
                let dx = (obj["dx"] as? NSNumber)?.doubleValue ?? 0
                let dy = (obj["dy"] as? NSNumber)?.doubleValue ?? 0
                mouseKey.move(dx: dx, dy: dy)
            case "mouseDown":
                mouseKey.mouseDown(button: (obj["button"] as? String) ?? "left")
            case "mouseUp":
                mouseKey.mouseUp(button: (obj["button"] as? String) ?? "left")
            case "mouseClick":
                mouseKey.mouseClick(button: (obj["button"] as? String) ?? "left")
            case "mouseScroll":
                let dx = Int32((obj["dx"] as? NSNumber)?.intValue ?? 0)
                let dy = Int32((obj["dy"] as? NSNumber)?.intValue ?? 0)
                mouseKey.scroll(dx: dx, dy: dy)
            case "keyCombo":
                if let combo = obj["combo"] as? String {
                    mouseKey.keyCombo(combo)
                }
            case "rumble":
                hidBridge.rumble(pattern: (obj["pattern"] as? String) ?? "tap")
            default:
                break
            }
        }
    }
    exit(0)
}

CFRunLoopRun()
