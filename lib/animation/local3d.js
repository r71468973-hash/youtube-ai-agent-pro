'use strict';
/**
 * Free local 3D animation provider.
 *
 * Drives a headless Chrome/Chromium (WebGL, three.js) over the DevTools protocol. For every scene
 * the stage (lib/animation/stage) is loaded with a scene spec and captured frame by frame, then the
 * frames are encoded to an H.264 clip with ffmpeg. No paid API and no npm dependencies are needed.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { run, sleep } = require('../util');

const STAGE_DIR = path.join(__dirname, 'stage');
const STAGE_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/stage.js': ['stage.js', 'text/javascript; charset=utf-8'],
  '/vendor/three.module.min.js': ['vendor/three.module.min.js', 'text/javascript; charset=utf-8'],
};
const CHROME_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

function findChrome() {
  for (const c of [process.env.CHROME_PATH, ...CHROME_CANDIDATES].filter(Boolean)) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Honest availability report, shown in the dashboard. */
function status() {
  const chrome = findChrome();
  if (!chrome) {
    return { id: 'local-3d', ok: false, reason: 'Chrome or Chromium was not found on this server. Install chromium or set CHROME_PATH.' };
  }
  return { id: 'local-3d', ok: true, reason: 'Free local 3D renderer (Chrome + three.js) is available.', chrome };
}

function serveStage() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const entry = STAGE_FILES[(req.url || '/').split('?')[0]];
      if (!entry) { res.writeHead(404); return res.end(); }
      fs.readFile(path.join(STAGE_DIR, entry[0]), (err, buf) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' });
        res.end(buf);
      });
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function connectChrome({ chrome, width, height, port, profileDir }) {
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' });
  let page = null;
  for (let i = 0; i < 160 && !page; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = targets.find((t) => t.type === 'page') || null;
    } catch { /* not up yet */ }
    if (!page) await sleep(250);
  }
  if (!page) { proc.kill('SIGKILL'); throw new Error('Chrome did not start for 3D rendering.'); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('Could not open the DevTools connection to Chrome.'));
  });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(`Chrome error: ${m.error.message}`));
    else p.resolve(m.result);
  };
  const send = (method, params = {}, timeoutMs = 120000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome timed out on ${method}`)); }, timeoutMs);
    pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
        throw new Error(`3D stage error: ${(d || r.exceptionDetails.text || 'unknown').split('\n')[0]}`);
      }
      return r.result ? r.result.value : undefined;
    },
    close() {
      try { ws.close(); } catch { /* already closed */ }
      proc.kill('SIGKILL');
    },
  };
}

/**
 * Render one MP4 clip per scene spec.
 * specs: stage scene specs (see stage.js). Returns [{file, duration}] in order.
 */
async function renderClips(specs, { width, height, fps = 24, workDir, onProgress = () => {} }) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome or Chromium was not found on this server. Install chromium or set CHROME_PATH.');
  const srv = await serveStage();
  const port = srv.address().port;
  const dbgPort = 9400 + Math.floor(Math.random() * 500);
  const profileDir = path.join(workDir, 'chrome-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const clips = [];
  let cdp = null;
  try {
    cdp = await connectChrome({ chrome, width, height, port: dbgPort, profileDir });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    const t0 = Date.now();
    while (!(await cdp.evaluate('window.STAGE_READY === true'))) {
      if (Date.now() - t0 > 60000) throw new Error('3D stage did not load (WebGL may be unavailable).');
      await sleep(200);
    }

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const frames = Math.max(1, Math.round(spec.duration * fps));
      const dir = path.join(workDir, `frames_${i}`);
      fs.mkdirSync(dir, { recursive: true });
      await cdp.evaluate(`window.loadScene(${JSON.stringify(spec)})`);
      for (let f = 0; f < frames; f++) {
        await cdp.evaluate(`window.setFrame(${(f / fps).toFixed(4)})`);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, captureBeyondViewport: false });
        fs.writeFileSync(path.join(dir, `f${String(f).padStart(6, '0')}.jpg`), Buffer.from(shot.data, 'base64'));
        if (f % 12 === 0) onProgress((i + f / frames) / specs.length);
      }
      const file = path.join(workDir, `clip_${i}.mp4`);
      await run('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-framerate', String(fps), '-i', path.join(dir, 'f%06d.jpg'),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps),
        '-movflags', '+faststart', file,
      ]);
      fs.rmSync(dir, { recursive: true, force: true });
      clips.push({ file, duration: frames / fps });
      onProgress((i + 1) / specs.length);
    }
  } finally {
    if (cdp) cdp.close();
    srv.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
  return clips;
}

module.exports = { status, renderClips, findChrome, STAGE_DIR };
