'use strict';
/** End-to-end smoke test: boots the server with an isolated data dir and no external API keys. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const PORT = 3900 + Math.floor(Math.random() * 90);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aivideo-'));
const BASE = `http://localhost:${PORT}`;
const env = { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_PASSWORD: 'test-pass-123', BASE_URL: BASE, APP_SECRET: 'x'.repeat(32) };
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'GOOGLE_TTS_API_KEY', 'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_ENDPOINT']) delete env[k];

let cookie = '';
let csrf = '';
async function call(method, p, body, extra = {}) {
  const res = await fetch(BASE + p, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}), ...extra },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  let data = null;
  try { data = await res.clone().json(); } catch { /* not json */ }
  return { status: res.status, data, res };
}
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', f]).toString()).streams;

async function waitFor(id, ms = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = (await call('GET', `/api/videos/${id}`)).data.video;
    if (['ready', 'failed'].includes(v.status)) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('timeout waiting for video');
}

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

(async () => {
  // Cloud storage points at a local S3-compatible mock (not R2), so finished videos really upload and are verified.
  const { startMockS3 } = require('./mock-s3');
  const mock = await startMockS3({ accessKey: 'smoke-key' });
  Object.assign(env, { R2_ACCESS_KEY_ID: 'smoke-key', R2_SECRET_ACCESS_KEY: 'smoke-secret-value', R2_ENDPOINT: mock.url, R2_BUCKET_NAME: 'smoke-bucket' });
  const srv = spawn('node', ['server.js'], { env, cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 50 && !log.includes('running at'); i++) await new Promise((r) => setTimeout(r, 100));
    assert(log.includes('running at'), 'server did not start: ' + log);

    // --- auth
    assert.strictEqual((await call('GET', '/api/videos')).status, 401); ok('API requires login');
    assert.strictEqual((await call('POST', '/api/login', { password: 'wrong' })).status, 401); ok('wrong password rejected');
    const login = await call('POST', '/api/login', { password: 'test-pass-123' });
    assert.strictEqual(login.status, 200); csrf = login.data.csrf; ok('login works');
    const nocsrf = await fetch(BASE + '/api/keys/OPENAI_API_KEY', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: '{"value":"abc"}' });
    assert.strictEqual(nocsrf.status, 403); ok('CSRF token enforced');

    // --- static + headers
    const page = await fetch(BASE + '/');
    assert.strictEqual(page.status, 200);
    assert(page.headers.get('content-security-policy').includes("script-src 'self'")); ok('dashboard served with CSP');
    assert.strictEqual((await fetch(BASE + '/..%2Fserver.js')).status, 404); ok('path traversal blocked');

    // --- key vault
    const secret = 'sk-test-SECRETVALUE-9876';
    const put = await call('PUT', '/api/keys/OPENAI_API_KEY', { value: secret });
    assert.strictEqual(put.status, 200);
    assert(!JSON.stringify(put.data).includes('SECRETVALUE')); ok('key value never returned');
    assert.strictEqual((await call('PUT', '/api/keys/NOT_A_KEY', { value: 'x' })).status, 404); ok('unknown key names rejected');
    assert(!fs.readFileSync(path.join(DATA, 'vault.json'), 'utf8').includes('SECRETVALUE')); ok('key encrypted at rest');
    await call('DELETE', '/api/keys/OPENAI_API_KEY');

    // --- validation
    assert.strictEqual((await call('POST', '/api/videos', { story: 'short', language: 'en', format: 'shorts' })).status, 400); ok('short story rejected');

    // Publishing queue: the endpoint works with nothing scheduled, and scheduling needs YouTube first.
    const queue = await call('GET', '/api/schedule');
    assert.strictEqual(queue.status, 200); assert(Array.isArray(queue.data.items)); ok('publishing queue endpoint works');
    // Daily public publishing needs daily upload on, and a one-time consent. Nothing is uploaded by these checks.
    assert.strictEqual((await call('PUT', '/api/settings', { dailyPublic: true, dailyAutoUpload: false })).status, 400); ok('public daily publishing needs daily upload on');
    assert.strictEqual((await call('PUT', '/api/settings', { dailyPublic: true, dailyAutoUpload: true })).status, 400); ok('public daily publishing needs the one-time consent');
    assert.strictEqual((await call('PUT', '/api/settings', { dailyPublishHour: 25 })).status, 400); ok('daily publish hour is validated');
    assert.strictEqual((await call('POST', '/api/videos', { story: 'x'.repeat(50), language: 'fr', format: 'shorts' })).status, 400); ok('bad language rejected');

    // --- English Short with music + captions
    const storyEn = 'Once upon a time, a small village sat beside a quiet river. Every morning a girl named Meera walked to the water. She listened to the birds. One day she found a glowing stone. It whispered a secret about the stars.';
    const a = await call('POST', '/api/videos', { story: storyEn, language: 'en', format: 'shorts', music: 'ambient-calm', captions: true });
    assert.strictEqual(a.status, 202);
    // --- Hindi long video (queued behind the first; one render at a time)
    const storyHi = 'एक छोटे से गाँव में एक लड़की रहती थी। उसका नाम मीरा था। हर सुबह वह नदी किनारे जाती थी। एक दिन उसे एक चमकता हुआ पत्थर मिला।';
    const b = await call('POST', '/api/videos', { story: storyHi, language: 'hi', format: 'long', music: 'none', captions: true });
    assert.strictEqual(b.status, 202);

    const va = await waitFor(a.data.video.id);
    assert.strictEqual(va.status, 'ready', 'short failed: ' + va.error); ok('Short generated');
    const fa = path.join(DATA, 'videos', va.id, 'video.mp4');
    const sa = probe(fa);
    const vs = sa.find((s) => s.codec_type === 'video');
    const wantShort = process.env.RENDER_HD === '1' ? '1080x1920' : '720x1280';
    assert.strictEqual(`${vs.width}x${vs.height}`, wantShort); ok(`2D cartoon Short is ${wantShort} (9:16)`);
    assert(sa.some((s) => s.codec_type === 'audio')); ok('audio track present (music bed)');
    assert(va.warnings.some((w) => /text-to-speech/.test(w))); ok('missing TTS key reported honestly');
    assert(fs.existsSync(path.join(DATA, 'videos', va.id, 'thumb.jpg'))); ok('thumbnail created');
    // --- cloud storage: saved to the bucket, each file confirmed in the bucket
    assert.strictEqual(va.cloud && va.cloud.saved, true, 'not saved to cloud: ' + JSON.stringify(va.cloud)); ok('Short saved to cloud storage and confirmed');
    const kinds = va.cloud.files.map((f) => f.kind);
    for (const k of ['video', 'thumbnail', 'metadata']) assert(kinds.includes(k), 'missing cloud file: ' + k); ok('video, thumbnail and metadata saved to cloud');
    assert(va.cloud.files.every((f) => mock.objects('smoke-bucket').has(f.key))); ok('every saved file is in the bucket');
    assert(!va.warnings.some((w) => /NOT saved to cloud/.test(w))); ok('no false "not saved" warning');

    const vb = await waitFor(b.data.video.id);
    assert.strictEqual(vb.status, 'ready', 'long failed: ' + vb.error); ok('Hindi long video generated');
    const sb = probe(path.join(DATA, 'videos', vb.id, 'video.mp4')).find((s) => s.codec_type === 'video');
    const wantLong = process.env.RENDER_HD === '1' ? '1920x1080' : '1280x720';
    assert.strictEqual(`${sb.width}x${sb.height}`, wantLong); ok(`2D cartoon long video is ${wantLong} (16:9)`);

    // --- 2D cartoon Short with dialogue: animated characters, per-line voices, footsteps, subtitles
    const ovr = (await call("GET", "/api/overview")).data;
    const st2 = ovr.animation.providers.find((x) => x.id === "local-2d");
    assert(st2 && typeof st2.ok === "boolean"); ok("2D cartoon renderer reported with its reason");
    const storyDlg = "Ravi: Let us run to the park!\nSita [F]: Yes, I will walk with you.\nThe two friends played in the garden and were very happy. Later they walked home in the evening.";
    const c3 = await call("POST", "/api/videos", { story: storyDlg, language: "en", format: "shorts", music: "none", captions: true });
    if (!st2.ok) {
      assert.strictEqual(c3.status, 409); ok("2D cartoon refused honestly when the renderer is unavailable");
    } else {
      assert.strictEqual(c3.status, 202);
      const v3 = await waitFor(c3.data.video.id, 900000);
      assert.strictEqual(v3.status, "ready", "2D cartoon failed: " + v3.error); ok("2D cartoon Short generated");
      assert.strictEqual(v3.mode, "2d-cartoon"); assert.strictEqual(v3.engine, "local-2d"); ok("video recorded as 2d-cartoon / local-2d");
      const f3 = path.join(DATA, "videos", v3.id, "video.mp4");
      const vs3 = probe(f3).find((x) => x.codec_type === "video");
      const want3 = process.env.RENDER_HD === "1" ? "1080x1920" : "720x1280";
      assert.strictEqual(vs3.width + "x" + vs3.height, want3); ok("2D cartoon Short is " + want3 + " (9:16)");
      const p1 = path.join(DATA, "f1.png"), p2 = path.join(DATA, "f2.png");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "0.8", "-i", f3, "-frames:v", "1", p1]);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "3.0", "-i", f3, "-frames:v", "1", p2]);
      assert(!fs.readFileSync(p1).equals(fs.readFileSync(p2))); ok("frames change over time (animated, not a still image)");
      assert(v3.soundEffects > 0, "footsteps were added"); ok("footsteps and sound effects added from the movement timeline");
      assert(v3.warnings.some((w) => /text-to-speech/.test(w))); ok("missing voice reported honestly (no key here)");
      assert(fs.existsSync(path.join(DATA, "videos", v3.id, "thumb.jpg"))); ok("thumbnail created");
    }

    // --- playback from cloud: with the local copy gone, the video is sent from the bucket, not a 404
    const localMp4 = path.join(DATA, 'videos', va.id, 'video.mp4');
    const kept = localMp4 + '.kept';
    fs.renameSync(localMp4, kept);
    try {
      const cloudPlay = await fetch(`${BASE}/api/videos/${va.id}/file`, { headers: { cookie }, redirect: 'manual' });
      assert.strictEqual(cloudPlay.status, 302, 'no redirect to cloud: ' + cloudPlay.status);
      assert(cloudPlay.headers.get('location').includes('smoke-bucket')); ok('video plays from cloud storage when the local copy is gone');
    } finally { fs.renameSync(kept, localMp4); }

    // --- range requests
    const rng = await fetch(`${BASE}/api/videos/${va.id}/file`, { headers: { cookie, range: 'bytes=0-99' } });
    assert.strictEqual(rng.status, 206); ok('video streaming supports Range');

    // --- approval gate
    const noConnect = await call('POST', `/api/videos/${va.id}/approve`, { confirm: true, title: 'T' });
    assert.strictEqual(noConnect.status, 409); ok('cannot upload while YouTube is not connected');
    const noConfirm = await call('POST', `/api/videos/${va.id}/approve`, { title: 'T' });
    assert([400, 409].includes(noConfirm.status)); ok('approval without confirm refused');
    assert.strictEqual((await call('GET', `/api/videos/${va.id}`)).data.video.status, 'ready'); ok('video stays "ready" (never auto-uploaded)');
    assert.strictEqual((await call('POST', '/api/youtube/connect')).status, 400); ok('OAuth connect needs client credentials first');

    // --- delete
    assert.strictEqual((await call('DELETE', `/api/videos/${vb.id}`)).status, 200);
    assert(!fs.existsSync(path.join(DATA, 'videos', vb.id))); ok('delete removes files');

    console.log(`\n${passed} checks passed`);
  } catch (e) {
    console.error('\nFAILED:', e.message);
    console.error('--- server log ---\n' + log.slice(-1500));
    process.exitCode = 1;
  } finally {
    srv.kill();
    mock.close().catch(() => {});
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})();
