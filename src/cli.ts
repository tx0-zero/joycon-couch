import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JoyConMapper, RADIAL_SECTORS } from './mapper';
import { defaultJoyConSettings, type JoyConFrame, type JoyConSettings } from './types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(os.homedir(), '.joycon-couch.json');

type VoiceHotkeyPreset = 'ctrl_alt_space' | 'opt_space' | 'cmd_shift_space' | 'win_h' | 'f13';

interface AppConfig extends JoyConSettings {
  voiceHotkey: VoiceHotkeyPreset;
  uiPort: number;
}

const VOICE_PRESETS: { id: VoiceHotkeyPreset; label: string; hint: string }[] = [
  { id: 'ctrl_alt_space', label: 'Ctrl + Option/Alt + Space', hint: 'Yuxie / Custom global dictation' },
  { id: 'opt_space', label: 'Option/Alt + Space', hint: 'Superwhisper / Raycast / Alfred' },
  { id: 'cmd_shift_space', label: 'Cmd/Ctrl + Shift + Space', hint: 'Wispr Flow / Custom shortcut' },
  { id: 'win_h', label: 'Win + H', hint: 'Windows built-in Voice Typing' },
  { id: 'f13', label: 'F13', hint: 'Conflict-free dedicated dictation trigger' },
];

function loadConfig(): AppConfig {
  const base: AppConfig = {
    ...defaultJoyConSettings(),
    deadzone: 0.16,
    voiceHotkey: 'ctrl_alt_space',
    uiPort: 43921,
  };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return { ...base, ...saved };
    }
  } catch {
    /* ignore broken config */
  }
  return base;
}

function saveConfig(cfg: AppConfig) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch {
    /* ignore write error */
  }
}

const args = process.argv.slice(2);
const numArg = (flag: string, fallback: number) => {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1]) {
    const v = Number(args[i + 1]);
    if (Number.isFinite(v)) return v;
  }
  return fallback;
};

let cfg: AppConfig = loadConfig();
cfg.cursorSpeed = numArg('--speed', cfg.cursorSpeed);
cfg.scrollSpeed = numArg('--scroll', cfg.scrollSpeed);
cfg.deadzone = numArg('--deadzone', cfg.deadzone);
if (args.includes('--no-gestures')) cfg.gesturesEnabled = false;
if (args.includes('--no-rumble')) cfg.rumbleEnabled = false;
if (args.includes('--toggle-voice')) cfg.voiceMode = 'toggle';

let connectedSide: 'left' | 'right' | null = null;
const mapper = new JoyConMapper();

function renderSettingsHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>JoyCon-Couch Settings</title>
<style>
  :root { color-scheme: dark; --bg:#0f1014; --card:#181a20; --line:#2a2d37; --ink:#f3f4f6; --muted:#9ca3af; --accent:#ff6a3d; --ok:#34d399; }
  * { box-sizing: border-box; margin:0; padding:0; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif; background:var(--bg); color:var(--ink); padding:28px; max-width:760px; margin:0 auto; }
  h1 { font-size:20px; display:flex; align-items:center; gap:10px; }
  .pill { font-size:12px; padding:3px 10px; border-radius:999px; background:#23262f; color:var(--muted); font-weight:600; }
  .pill.on { background:rgba(52,211,153,.16); color:var(--ok); }
  .sub { color:var(--muted); font-size:13px; margin:6px 0 20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px; margin-bottom:16px; }
  .card h2 { font-size:14px; margin-bottom:12px; color:#fff; }
  .row { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:10px 0; border-top:1px solid var(--line); }
  .row:first-of-type { border-top:0; padding-top:0; }
  .lbl { font-size:13.5px; font-weight:600; }
  .desc { font-size:12px; color:var(--muted); margin-top:2px; }
  select, input[type=range] { background:#111318; color:#fff; border:1px solid var(--line); border-radius:8px; padding:6px 10px; font-size:13px; }
  input[type=range] { border:0; accent-color:var(--accent); width:180px; padding:0; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:6px; }
  .krow { display:flex; gap:10px; align-items:center; background:#12141a; border:1px solid var(--line); padding:8px 10px; border-radius:9px; font-size:12.5px; }
  .kcap { min-width:64px; text-align:center; background:#232630; border-radius:6px; padding:3px 6px; font-weight:700; color:#fff; }
  .toast { position:fixed; bottom:18px; right:22px; background:var(--accent); color:#fff; padding:8px 14px; border-radius:10px; font-size:12.5px; font-weight:600; opacity:0; transition:opacity .2s; }
  .toast.show { opacity:1; }
</style>
</head>
<body>
  <h1>JoyCon-Couch <span id="status" class="pill">Connecting…</span></h1>
  <div class="sub">Single 49g Nintendo Switch Joy-Con (L or R) controller for couch vibe-coding &amp; voice dictation.</div>

  <div class="card">
    <h2>Voice Dictation Binding</h2>
    <div class="row">
      <div><div class="lbl">Voice Input Hotkey (ZR / ZL)</div><div class="desc">Bind to Wispr Flow, Superwhisper, Yuxie, macOS/Windows dictation</div></div>
      <select id="voiceHotkey">
        ${VOICE_PRESETS.map((p) => `<option value="${p.id}">${p.label} — ${p.hint}</option>`).join('')}
      </select>
    </div>
    <div class="row">
      <div><div class="lbl">Trigger Mode</div><div class="desc">Hold to talk (Push-to-Talk) or press once to start / stop</div></div>
      <select id="voiceMode">
        <option value="hold">Hold ZR/ZL (Push-to-Talk)</option>
        <option value="toggle">Tap ZR/ZL (Toggle)</option>
      </select>
    </div>
  </div>

  <div class="card">
    <h2>Cursor &amp; Gesture Feel</h2>
    <div class="row">
      <div><div class="lbl">Cursor Speed <span id="vSpeed" class="pill"></span></div><div class="desc">Dual-zone precision curve + 2.3x outer-edge boost</div></div>
      <input id="cursorSpeed" type="range" min="8" max="36" step="1" />
    </div>
    <div class="row">
      <div><div class="lbl">Scroll Speed <span id="vScroll" class="pill"></span></div><div class="desc">Press stick (R3/L3) to toggle smooth scroll mode</div></div>
      <input id="scrollSpeed" type="range" min="4" max="28" step="1" />
    </div>
    <div class="row">
      <div><div class="lbl">Anti-Drift Deadzone <span id="vDz" class="pill"></span></div><div class="desc">Increase slightly if an older Joy-Con has hardware drift</div></div>
      <input id="deadzone" type="range" min="0.06" max="0.30" step="0.01" />
    </div>
    <div class="row">
      <div><div class="lbl">Wrist-Flick Workspace Switch</div><div class="desc">Quickly flick wrist left / right to switch virtual desktops</div></div>
      <input id="gesturesEnabled" type="checkbox" />
    </div>
    <div class="row">
      <div><div class="lbl">HD Rumble Feedback</div><div class="desc">Subtle haptic tap on voice trigger, radial menu &amp; lock</div></div>
      <input id="rumbleEnabled" type="checkbox" />
    </div>
  </div>

  <div class="card">
    <h2>Symmetric Button Map (Right / Left Joy-Con)</h2>
    <div class="grid">
      <div class="krow"><span class="kcap">Stick</span><span>Dual-zone cursor / Scroll</span></div>
      <div class="krow"><span class="kcap">R3 / L3</span><span>Toggle cursor &amp; scroll mode</span></div>
      <div class="krow"><span class="kcap">R / L</span><span>Left Click &amp; Drag (damped)</span></div>
      <div class="krow"><span class="kcap">ZR / ZL</span><span>Voice Dictation Trigger</span></div>
      <div class="krow"><span class="kcap">A / →</span><span>Enter (Send prompt)</span></div>
      <div class="krow"><span class="kcap">B / ↓</span><span>Right Click</span></div>
      <div class="krow"><span class="kcap">X / ↑</span><span>Switch Window (⌘/Alt+Tab)</span></div>
      <div class="krow"><span class="kcap">Y / ←</span><span>Mission Control / Win+Tab</span></div>
      <div class="krow"><span class="kcap">+ / -</span><span>Tap: Undo · Hold: 6-way Radial</span></div>
      <div class="krow"><span class="kcap">Home / ◻</span><span>Lock / Unlock anti-accidental</span></div>
    </div>
  </div>
  <div id="toast" class="toast">Saved</div>
<script>
const $ = (id) => document.getElementById(id);
let toastTimer;
function showToast(m) {
  const t = $('toast'); t.textContent = m; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1200);
}
async function sync() {
  const r = await fetch('/api/state').then(x => x.json());
  const st = $('status');
  st.textContent = r.connectedSide ? ('Connected · ' + r.connectedSide.toUpperCase()) : 'Waiting for Bluetooth Joy-Con…';
  st.className = 'pill' + (r.connectedSide ? ' on' : '');
  const c = r.config;
  $('voiceHotkey').value = c.voiceHotkey;
  $('voiceMode').value = c.voiceMode;
  $('cursorSpeed').value = c.cursorSpeed; $('vSpeed').textContent = c.cursorSpeed;
  $('scrollSpeed').value = c.scrollSpeed; $('vScroll').textContent = c.scrollSpeed;
  $('deadzone').value = c.deadzone; $('vDz').textContent = Number(c.deadzone).toFixed(2);
  $('gesturesEnabled').checked = !!c.gesturesEnabled;
  $('rumbleEnabled').checked = !!c.rumbleEnabled;
}
async function update(patch) {
  await fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch) });
  showToast('Saved');
  sync();
}
$('voiceHotkey').onchange = e => update({ voiceHotkey: e.target.value });
$('voiceMode').onchange = e => update({ voiceMode: e.target.value });
$('cursorSpeed').oninput = e => { $('vSpeed').textContent = e.target.value; update({ cursorSpeed: Number(e.target.value) }); };
$('scrollSpeed').oninput = e => { $('vScroll').textContent = e.target.value; update({ scrollSpeed: Number(e.target.value) }); };
$('deadzone').oninput = e => { $('vDz').textContent = Number(e.target.value).toFixed(2); update({ deadzone: Number(e.target.value) }); };
$('gesturesEnabled').onchange = e => update({ gesturesEnabled: e.target.checked });
$('rumbleEnabled').onchange = e => update({ rumbleEnabled: e.target.checked });
sync();
setInterval(sync, 2000);
</script>
</body>
</html>`;
}

if (!args.includes('--no-ui')) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connectedSide, locked: mapper.isLocked, scrollMode: mapper.isScrollMode, config: cfg, radial: RADIAL_SECTORS }));
      return;
    }
    if (req.url === '/api/config' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          cfg = { ...cfg, ...JSON.parse(body) };
          saveConfig(cfg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, config: cfg }));
        } catch {
          res.writeHead(400);
          res.end('bad json');
        }
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderSettingsHtml());
  });
  server.listen(cfg.uiPort, '127.0.0.1', () => {
    console.log(`⚙  Settings UI: http://127.0.0.1:${cfg.uiPort}`);
  });
}

const cmd =
  process.platform === 'darwin'
    ? { bin: path.join(ROOT, 'build', 'JoyConHelper'), args: ['--side', cfg.side] }
    : { bin: process.platform === 'win32' ? 'python' : 'python3', args: [path.join(ROOT, 'bridges', 'win_bridge.py'), '--side', cfg.side] };

if (!fs.existsSync(cmd.bin) && process.platform === 'darwin') {
  console.error('Missing build/JoyConHelper. Run `npm run build` first.');
  process.exit(1);
}

console.log('🎮 JoyCon-Couch running (waiting for Bluetooth Joy-Con L or R...)');

const proc = spawn(cmd.bin, cmd.args, { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const send = (obj: Record<string, unknown>) => {
  if (proc.stdin.writable) proc.stdin.write(JSON.stringify(obj) + '\n');
};

proc.stdout.setEncoding('utf8');
proc.stdout.on('data', (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.event === 'connected') {
      connectedSide = msg.side === 'left' ? 'left' : 'right';
      console.log(`✓ Connected Joy-Con (${connectedSide.toUpperCase()})`);
    } else if (msg.event === 'disconnected') {
      connectedSide = null;
      console.log('! Joy-Con disconnected');
      for (const a of mapper.reset()) if (a.type === 'mouseUp') send(a);
    } else if (msg.event === 'error') {
      console.error(`✗ ${msg.message}`);
    } else if (msg.event === 'frame') {
      const actions = mapper.process(msg.frame as JoyConFrame, cfg, { isRecording: false, isBusy: false });
      for (const a of actions) {
        if (a.type === 'voiceStart' || a.type === 'voiceStop' || a.type === 'voiceToggle') {
          send({ type: 'keyCombo', combo: `voice_${cfg.voiceHotkey}` });
        } else if (a.type === 'notice') {
          console.log(`• ${a.title}: ${a.detail}`);
        } else if (a.type !== 'toggleHud' && a.type !== 'voiceCancel' && a.type !== 'radialOpen' && a.type !== 'radialSelect' && a.type !== 'radialClose') {
          send(a);
        }
      }
    }
  }
});

process.on('SIGINT', () => {
  proc.kill();
  process.exit(0);
});
