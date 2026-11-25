import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMO = path.join(ROOT, 'promo');
const SCENE_URL = 'file://' + path.join(PROMO, 'scene.html');
const PORT = 9229;
const FPS = 30;
const DURATION = 18;
const TOTAL_FRAMES = FPS * DURATION;

const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1920,1080',
    SCENE_URL,
  ],
  { stdio: 'ignore' },
);

async function waitForWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
      const page = list.find((x) => x.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* wait */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Chrome CDP failed to start');
}

const wsUrl = await waitForWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});

const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

// Wait for renderFrame to be ready
for (let i = 0; i < 20; i++) {
  const r = await cdp('Runtime.evaluate', { expression: 'typeof window.renderFrame', returnByValue: true });
  if (r.result?.value === 'function') break;
  await new Promise((r) => setTimeout(r, 100));
}

// 1. Export high-res cover.png (Scene 3 radial menu frame at t=7.85s)
await cdp('Runtime.evaluate', { expression: 'window.renderFrame(7.85)' });
const coverData = await cdp('Runtime.evaluate', {
  expression: 'document.getElementById("c").toDataURL("image/png").slice(22)',
  returnByValue: true,
});
fs.writeFileSync(path.join(PROMO, 'cover.png'), Buffer.from(coverData.result.value, 'base64'));
console.log('✓ Saved promo/cover.png');

// 2. Pipe 540 JPEG frames directly into ffmpeg -> promo/demo.mp4
const ff = spawn(
  'ffmpeg',
  [
    '-y',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-framerate', String(FPS),
    '-i', '-',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '18',
    '-movflags', '+faststart',
    path.join(PROMO, 'demo.mp4'),
  ],
  { stdio: ['pipe', 'ignore', 'pipe'] },
);

let ffErr = '';
ff.stderr.on('data', (d) => (ffErr += String(d)));

const t0 = Date.now();
for (let f = 0; f < TOTAL_FRAMES; f++) {
  const t = (f / FPS).toFixed(4);
  const res = await cdp('Runtime.evaluate', {
    expression: `window.renderFrame(${t}); document.getElementById("c").toDataURL("image/jpeg", 0.94).slice(23)`,
    returnByValue: true,
  });
  const buf = Buffer.from(res.result.value, 'base64');
  if (!ff.stdin.write(buf)) {
    await new Promise((r) => ff.stdin.once('drain', r));
  }
}
ff.stdin.end();
await new Promise((resolve, reject) => {
  ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(ffErr.slice(-400)))));
});

ws.close();
chrome.kill();
console.log(`✓ Rendered promo/demo.mp4 (${TOTAL_FRAMES} frames, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
