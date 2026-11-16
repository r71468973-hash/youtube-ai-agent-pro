'use strict';
/**
 * Free local 2D cartoon renderer.
 *
 * Drives a headless Chrome/Chromium (Canvas 2D) over the DevTools protocol. For every scene
 * the stage (lib/animation/stage2d) is loaded with a scene spec and captured frame by frame, then the
 * frames are encoded to an H.264 clip with ffmpeg. No paid API and no npm dependencies are needed.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { run, sleep } = require('../util');
const memory = require('../memory');

const STAGE_DIR = path.join(__dirname, 'stage2d');
const STAGE_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/stage.js': ['stage.js', 'text/javascript; charset=utf-8'],
  
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
    return { id: 'local-2d', ok: false, reason: 'Chrome or Chromium was not found on this server. Install chromium or set CHROME_PATH.' };
  }
  return { id: 'local-2d', ok: true, reason: 'Free local 2D cartoon renderer (headless Chrome, Canvas 2D) is available.', chrome };
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
    // Fewer Chrome helper processes: each one costs resident memory on the 1 GB server.
    '--renderer-process-limit=1', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--no-first-run', '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--js-flags=--max-old-space-size=256',
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
  if (!page) { proc.kill('SIGKILL'); throw new Error('Chrome did not start for 2D rendering.'); }

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
        throw new Error(`2D stage error: ${(d || r.exceptionDetails.text || 'unknown').split('\n')[0]}`);
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
      if (Date.now() - t0 > 60000) throw new Error('2D stage did not load.');
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
      clips.push({ dir, file: path.join(workDir, `clip_${i}.mp4`), duration: frames / fps });
      onProgress((i + 0.5) / specs.length);
    }
  } finally {
    if (cdp) cdp.close();
    srv.close();
    // Chrome may still be flushing its profile; this folder is temporary, so a failed delete must not fail the job.
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* removed with the job's work folder later */ }
  }
  // Chrome is closed now. Encoding alone is what remains, so ffmpeg is not competing with
  // Chrome for the server's 1 GB memory limit (that competition killed ffmpeg before).
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    await encodeFrames(c.dir, c.file, fps, workDir, i);
    fs.rmSync(c.dir, { recursive: true, force: true });
    onProgress((i + 1) / clips.length);
  }
  return clips.map(({ file, duration }) => ({ file, duration }));
}

/**
 * Encodes one scene's JPEG frames to an H.264 clip. A kill by a signal (out of memory) or a timeout
 * is retried once with a single encoder thread; a normal ffmpeg error is not retried, and its full
 * stderr is saved next to the work folder.
 */
async function encodeFrames(dir, file, fps, workDir, index) {
  const make = (threads) => [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(fps), '-i', path.join(dir, 'f%06d.jpg'),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-threads', String(threads), '-movflags', '+faststart', file,
  ];
  const logFile = path.join(workDir, `ffmpeg_clip_${index}_error.log`);
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      memory.log(`clip ${index} encode attempt ${attempt}`);
      await run('ffmpeg', make(1), { timeoutMs: 300000, logFile });
      return;
    } catch (e) {
      lastError = e;
      if (!e.signal && !e.timedOut) break; // a real encoder error: retrying will not help
    }
  }
  throw lastError;
}

module.exports = { status, renderClips, findChrome, STAGE_DIR };
