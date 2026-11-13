'use strict';
/** Pipeline test against a local mock Gemini API and a local mock S3 server: plan -> images -> voice -> render -> cloud. */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const PORT = 4000 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aivideo-g-'));
const BASE = `http://localhost:${PORT}`;
const png = path.join(DATA, 'mock.png');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=576x1024', '-frames:v', '1', png]);
const PNG_B64 = fs.readFileSync(png).toString('base64');
const pcm = Buffer.alloc(24000 * 2 * 2); // 2s of 24kHz s16 sine
for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 20)), i * 2);

const calls = { plan: 0, image: 0, tts: 0, authHeaderOk: true, keyInUrl: false };
const gem = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => { b += d; });
  req.on('end', () => {
    if (req.headers['x-goog-api-key'] !== 'gem-test-key') calls.authHeaderOk = false;
    if (/key=/.test(req.url)) calls.keyInUrl = true;
    const body = JSON.parse(b || '{}');
    let parts;
    if (req.url.includes('tts')) { calls.tts++; parts = [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }]; }
    else if (req.url.includes('image')) { calls.image++; assert(JSON.stringify(body).includes('3D animated cartoon')); parts = [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]; }
    else {
      calls.plan++;
      const text = JSON.stringify({ characters: 'Meera, a girl with a red scarf', scenes: [
        { narration: 'A girl named Meera walked to the river.', visual: 'Meera at a sunny river' },
        { narration: 'She found a glowing stone.', visual: 'Meera holding a glowing stone' }] });
      parts = [{ text }];
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts } }] }));
  });
});

const objects = new Map();
const s3 = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const k = req.url.split('?')[0];
    if (!req.headers.authorization || !req.headers.authorization.startsWith('AWS4-HMAC-SHA256')) { res.writeHead(403); return res.end(); }
    if (req.method === 'PUT') { objects.set(k, Buffer.concat(chunks)); res.writeHead(200); return res.end(); }
    if (req.method === 'GET') { const o = objects.get(k); res.writeHead(o ? 200 : 404); return res.end(o); }
    if (req.method === 'DELETE') { objects.delete(k); res.writeHead(204); return res.end(); }
    res.writeHead(405); res.end();
  });
});
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

let cookie = '';
let csrf = '';
async function call(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return { status: res.status, data: await res.json().catch(() => null) };
}
const ok = (n) => console.log(`  ok  ${n}`);

(async () => {
  const gp = await listen(gem);
  const sp = await listen(s3);
  const env = {
    ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_PASSWORD: 'test-pass-123', BASE_URL: BASE, APP_SECRET: 'y'.repeat(32),
    GEMINI_API_KEY: 'gem-test-key', ELEVENLABS_API_KEY: 'invalid-test-key', GEMINI_BASE_URL: `http://127.0.0.1:${gp}`, S3_ACCESS_KEY_ID: 'AK', S3_SECRET_ACCESS_KEY: 'SK',
  };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_TTS_API_KEY']) delete env[k];
  const srv = spawn('node', ['server.js'], { env, cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 50 && !log.includes('running at'); i++) await new Promise((r) => setTimeout(r, 100));
    const login = await call('POST', '/api/login', { password: 'test-pass-123' });
    csrf = login.data.csrf;

    const ov = (await call('GET', '/api/overview')).data;
    assert.strictEqual(ov.ai.planner, 'gemini'); assert(ov.ai.images); assert.strictEqual(ov.tts, 'elevenlabs'); ok('Gemini picked for planning and images');
    assert(!JSON.stringify((await call('GET', '/api/keys')).data).includes('gem-test-key')); ok('Gemini key never returned');

    const gt = (await call('POST', '/api/gemini/test')).data;
    assert(gt.ok); ok('Gemini key test endpoint');

    let st = (await call('POST', '/api/storage/test')).data;
    assert(!st.ok && /Missing/.test(st.error)); ok('storage test reports missing config');
    await call('PUT', '/api/settings', { storage: { endpoint: `http://127.0.0.1:${sp}`, bucket: 'test-bucket', pathStyle: true, prefix: 'videos/' } });
    st = (await call('POST', '/api/storage/test')).data;
    assert(st.ok, JSON.stringify(st)); assert.strictEqual(objects.size, 0); ok('storage test: write, read back, delete');

    const create = await call('POST', '/api/videos', { story: 'A girl named Meera walked to the river every morning. One day she found a glowing stone.', language: 'en', format: 'shorts', music: 'none', captions: true });
    assert.strictEqual(create.status, 202);
    const id = create.data.video.id;
    let v;
    for (let i = 0; i < 180; i++) {
      v = (await call('GET', `/api/videos/${id}`)).data.video;
      if (['ready', 'failed'].includes(v.status)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.strictEqual(v.status, 'ready', 'video failed: ' + v.error + ' ' + log.slice(-800));
    assert.strictEqual(v.planner, 'gemini'); assert.strictEqual(v.scenes.length, 2);
    assert(calls.plan >= 1 && calls.image === 2 && calls.tts === 2); ok('Gemini planned 2 scenes, drew 2 images, voiced 2 clips');
    assert(calls.authHeaderOk && !calls.keyInUrl); ok('Gemini key sent in header only');
    const f = path.join(DATA, 'videos', id, 'video.mp4');
    const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', f]).toString()).streams;
    const vs = streams.find((s) => s.codec_type === 'video');
    assert.strictEqual(`${vs.width}x${vs.height}`, '1080x1920'); assert(streams.some((s) => s.codec_type === 'audio')); ok('real MP4 with picture and voice audio');
    assert(v.hasVoice && v.duration > 4); ok('voiceover drives scene duration');
    assert(v.warnings.some((w) => /elevenlabs/.test(w))); ok('broken voice provider is reported and skipped, Gemini voice used instead');
    assert(fs.existsSync(path.join(DATA, 'videos', id, 'voiceover.mp3'))); ok('voiceover audio exported');
    assert(v.cloud && v.cloud.assets.length === 4); ok('video, thumbnail, audio and 2 images uploaded to cloud');
    assert([...objects.keys()].some((k) => k.endsWith(`${id}/video.mp4`))); assert(objects.size === 5); ok('mock bucket holds the files');
    assert(fs.existsSync(f)); ok('local copy kept as fallback');

    assert((await call('DELETE', `/api/videos/${id}`)).status === 200);
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(objects.size, 0); ok('delete removes cloud objects');
    console.log('\nGemini pipeline test passed');
  } catch (e) {
    console.error('\nFAILED:', e.message);
    console.error('--- server log ---\n' + log.slice(-1500));
    process.exitCode = 1;
  } finally {
    srv.kill(); gem.close(); s3.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})();
