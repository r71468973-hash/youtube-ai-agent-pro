'use strict';
/**
 * Security checks: authentication, CSRF, headers, secrets at rest and in responses, public-video consent,
 * data deletion, the security log, limits, and database safety. Boots the real server against a temporary
 * data directory. No real Google, Anthropic or Cloudflare calls are made.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aiv-security-'));
const PORT = 4100 + Math.floor(Math.random() * 800);
const BASE = `http://localhost:${PORT}`;
const PASSWORD = 'sec-test-pass-9';
const APP_SECRET = 'y'.repeat(40);
const MARK = {
  token: 'ya29.MARK-ACCESS-7731',
  refresh: '1//MARK-REFRESH-7731',
  key: 'sk-test-MARKVALUE-7731',
  story: 'STORYMARK-7731 a private story line',
  client: 'GOCSPX-MARK-CLIENT-7731',
};
const VIDEO = 'abcdef123456';

process.env.DATA_DIR = DATA;
process.env.APP_SECRET = APP_SECRET;
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC|OPENAI|ELEVENLABS|GOOGLE_TTS|YOUTUBE|S3_|R2_|VIDEO_API|RAILWAY_)/.test(k)) delete process.env[k];

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- unit checks (same process) */
const security = require('../lib/security');
const vault = require('../lib/vault');
const store = require('../lib/store');

(function unitChecks() {
  // Secret-looking fields never reach the log.
  security.event('unit_redaction', { password: PASSWORD, token: MARK.token, cookie: 'aiv_session=abc', ip: '198.51.100.7', note: 'kept' });
  const last = security.recent(1)[0];
  assert.strictEqual(last.type, 'unit_redaction');
  assert.strictEqual(last.ip, '198.51.100.7');
  assert.strictEqual(last.note, 'kept');
  assert(!('password' in last) && !('token' in last) && !('cookie' in last));
  assert(!fs.readFileSync(security.LOG_FILE, 'utf8').includes(PASSWORD));
  ok('security events drop password, token and cookie fields');

  // Client address: behind Railway the last X-Forwarded-For hop is used; otherwise the socket address.
  const req = { headers: { 'x-forwarded-for': 'attacker-chosen, 203.0.113.9' }, socket: { remoteAddress: '10.0.0.1' } };
  process.env.RAILWAY_PROJECT_ID = 'test-project';
  assert.strictEqual(security.clientIp(req), '203.0.113.9');
  delete process.env.RAILWAY_PROJECT_ID;
  assert.strictEqual(security.clientIp(req), '10.0.0.1');
  ok('the client address comes from the trusted proxy hop only behind Railway');

  // Sliding-window limit.
  for (let i = 0; i < 3; i++) assert.strictEqual(security.overLimit('unit-key', 3, 60000), false);
  assert.strictEqual(security.overLimit('unit-key', 3, 60000), true);
  ok('the request limit counts per key and trips after the limit');

  // Owner credentials and YouTube token live encrypted in the vault.
  vault.set('YOUTUBE_TOKENS', JSON.stringify({ access_token: MARK.token, refresh_token: MARK.refresh, expires_at: Date.now() + 3600000, channel: { v: 2, id: 'UCsecurity1', title: 'Security Test Channel', handle: '@sectest', url: 'https://www.youtube.com/@sectest', thumbnail: null } }));
  vault.set('YOUTUBE_CLIENT_SECRET', MARK.client);
  vault.set('YOUTUBE_CLIENT_ID', 'mark-client.apps.googleusercontent.com');
  store.init();
  store.saveVideo({ id: VIDEO, status: 'ready', title: 'Security test video', story: MARK.story, format: 'shorts', mode: '2d-cartoon', language: 'en', createdAt: new Date().toISOString(), scenes: [], warnings: [], progress: 100, stage: 'Ready' });
  ok('test data written through the encrypted vault and database');
})();

/* ------------------------------------------------------------- database safety (separate processes) */
function runNode(code, dir, secret) {
  return spawnSync('node', ['-e', code], { cwd: ROOT, env: { ...process.env, DATA_DIR: dir, APP_SECRET: secret }, encoding: 'utf8' });
}
(function databaseChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiv-db-'));
  const secret = 'z'.repeat(40);
  // Round trip: saved encrypted, read back with the same secret.
  const save = runNode(`const s=require('./lib/store');s.init();s.saveVideo({id:'r1',status:'ready',createdAt:'2026-01-01T00:00:00Z',story:'ROUNDTRIP-9'});`, dir, secret);
  assert.strictEqual(save.status, 0, save.stderr);
  const raw = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
  assert(!raw.includes('ROUNDTRIP-9'), 'the database file must not hold plaintext');
  const read = runNode(`console.log(require('./lib/store').getVideo('r1').story)`, dir, secret);
  assert.strictEqual(read.stdout.trim(), 'ROUNDTRIP-9');
  ok('the database is encrypted on disk and reads back with the same secret');

  // A wrong secret stops the app and leaves the file untouched (no silent empty database).
  const before = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
  const wrong = runNode(`require('./lib/store').init()`, dir, 'w'.repeat(40));
  assert.notStrictEqual(wrong.status, 0);
  assert(/cannot be decrypted/.test(wrong.stderr), wrong.stderr);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), before);
  ok('a database that cannot be decrypted stops the app and is never overwritten');

  // A corrupted file is also refused, not replaced.
  const corrupt = fs.mkdtempSync(path.join(os.tmpdir(), 'aiv-db-'));
  fs.writeFileSync(path.join(corrupt, 'db.json'), '{"videos": {broken');
  const bad = runNode(`require('./lib/store').init()`, corrupt, secret);
  assert.notStrictEqual(bad.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(corrupt, 'db.json'), 'utf8'), '{"videos": {broken');
  ok('a corrupted database is refused and left as it was');

  // An older plaintext database is migrated to encrypted on start, with its data kept.
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'aiv-db-'));
  fs.writeFileSync(path.join(legacy, 'db.json'), JSON.stringify({ videos: { old1: { id: 'old1', status: 'ready', createdAt: '2026-01-02T00:00:00Z', story: 'LEGACY-STORY-5' } } }));
  const mig = runNode(`require('./lib/store').init()`, legacy, secret);
  assert.strictEqual(mig.status, 0, mig.stderr);
  assert(!fs.readFileSync(path.join(legacy, 'db.json'), 'utf8').includes('LEGACY-STORY-5'));
  const keep = runNode(`console.log(require('./lib/store').getVideo('old1').story)`, legacy, secret);
  assert.strictEqual(keep.stdout.trim(), 'LEGACY-STORY-5');
  ok('an older plaintext database is encrypted on start and its data is kept');
  for (const d of [dir, corrupt, legacy]) fs.rmSync(d, { recursive: true, force: true });
})();

/* ----------------------------------------------------------------------- live server */
let cookie = '';
let csrf = '';
async function call(method, p, body, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.noCookie ? {} : cookie ? { cookie } : {}) };
  if (csrf && method !== 'GET' && method !== 'HEAD' && opts.csrf !== false) headers['x-csrf-token'] = csrf;
  const res = await fetch(BASE + p, { method, redirect: 'manual', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    if (c.startsWith('aiv_session=') && !/Max-Age=0/.test(c)) cookie = c.split(';')[0];
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, data, headers: res.headers };
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

(async () => {
  const srv = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, APP_SECRET, ADMIN_PASSWORD: PASSWORD, BASE_URL: BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  srv.stdout.on('data', (d) => { serverOut += d; });
  srv.stderr.on('data', (d) => { serverOut += d; });
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${BASE}/api/session`)).status === 200) break; } catch { /* not up yet */ }
      await sleep(200);
    }

    // 1. Nothing is reachable without signing in.
    assert.strictEqual((await call('GET', '/api/videos', undefined, { noCookie: true })).status, 401);
    assert.strictEqual((await call('GET', '/api/keys', undefined, { noCookie: true })).status, 401);
    assert.strictEqual((await call('POST', '/api/videos', { story: 'x' }, { noCookie: true })).status, 401);
    assert.strictEqual((await call('GET', '/api/security/events', undefined, { noCookie: true })).status, 401);
    ok('every data and key endpoint refuses requests without a signed-in session');

    // 2. Login: wrong password refused and not echoed; correct password gives a session cookie with safe flags.
    const wrong = await call('POST', '/api/login', { password: 'not-the-password' }, { noCookie: true });
    assert.strictEqual(wrong.status, 401);
    assert(!wrong.text.includes(PASSWORD));
    const good = await call('POST', '/api/login', { password: PASSWORD }, { noCookie: true });
    assert.strictEqual(good.status, 200);
    csrf = good.data.csrf;
    assert(csrf && csrf.length > 10);
    const setCookie = good.headers.get('set-cookie') || '';
    assert(/aiv_session=/.test(setCookie) && /HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie), setCookie);
    assert((await call('GET', '/api/session')).data.authenticated === true);
    ok('login refuses a wrong password without echoing it; session cookie is HttpOnly and SameSite=Lax');

    // 3. CSRF: a change without the token is refused; with the token it is accepted.
    assert.strictEqual((await call('PUT', '/api/settings', { ttsProvider: 'auto' }, { csrf: false })).status, 403);
    assert.strictEqual((await call('PUT', '/api/settings', { ttsProvider: 'auto' })).status, 200);
    ok('changes without the CSRF token are refused; with it they go through');

    // 4. Response headers that stop framing, sniffing and script injection.
    const page = await fetch(`${BASE}/`);
    const csp = page.headers.get('content-security-policy') || '';
    assert(/script-src 'self'/.test(csp) && /object-src 'none'/.test(csp) && /frame-ancestors 'none'/.test(csp), csp);
    assert.strictEqual(page.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
    assert(page.headers.get('permissions-policy'));
    assert.strictEqual(page.headers.get('strict-transport-security'), null); // plain HTTP in this test
    ok('pages send a strict Content-Security-Policy, frame and sniffing protection, and a permissions policy');

    // 5. API keys are write-only: the value is stored encrypted and never returned.
    assert.strictEqual((await call('PUT', '/api/keys/ANTHROPIC_API_KEY', { value: MARK.key })).status, 200);
    const keys = await call('GET', '/api/keys');
    assert(!keys.text.includes(MARK.key));
    assert(keys.data.keys.find((k) => k.name === 'ANTHROPIC_API_KEY').configured);
    assert.strictEqual((await call('PUT', '/api/keys/NOT_A_KEY', { value: 'abc' })).status, 404);
    ok('API keys are saved, reported only as configured with a hint, and unknown key names are refused');

    // 6. The YouTube token and Google client secret never appear in any response.
    const yt = await call('GET', '/api/youtube/status');
    const overview = await call('GET', '/api/overview');
    for (const body of [yt.text, overview.text]) {
      for (const secret of [MARK.token, MARK.refresh, MARK.client]) assert(!body.includes(secret), 'a Google secret was returned');
    }
    assert(yt.text.includes('Security Test Channel'));
    ok('the YouTube access token, refresh token and client secret are never returned to the browser');

    // 7. Nothing sensitive is stored in plain text on disk (vault, database, security log).
    const files = walk(DATA);
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const secret of [MARK.token, MARK.refresh, MARK.key, MARK.client, MARK.story, PASSWORD]) {
        assert(!text.includes(secret), `plaintext secret found in ${path.basename(f)}`);
      }
    }
    ok('no password, token, API key, client secret or story text is stored in plain text');

    // 8. Public videos: a video cannot go public right away without the owner's separate confirmation.
    const noConsent = await call('POST', `/api/videos/${VIDEO}/approve`, { confirm: true, title: 'Security test video', privacy: 'public' });
    assert.strictEqual(noConsent.status, 400);
    assert(/Confirm that this video becomes public/.test(noConsent.text));
    assert.strictEqual((await call('GET', `/api/videos/${VIDEO}`)).data.video.status, 'ready');
    ok('an immediate public upload is refused without the separate public confirmation; the video stays ready');

    // 9. Input validation.
    assert.strictEqual((await call('POST', '/api/videos', { story: 'short', language: 'en', format: 'shorts' })).status, 400);
    assert.strictEqual((await call('PUT', '/api/settings', { dailyHour: 99 })).status, 400);
    assert.strictEqual((await call('GET', '/api/videos/not-a-real-id')).status, 404);
    ok('bad input (short story, out-of-range hour, malformed video id) is refused');

    // 9b. Google sign-in callback: refused without a dashboard session, and refused when the state does not match.
    const cbNoSession = await call('GET', '/auth/google/callback?code=abc&state=xyz', undefined, { noCookie: true });
    assert.strictEqual(cbNoSession.status, 302);
    assert(/youtube=error/.test(cbNoSession.headers.get('location') || ''));
    const cbBadState = await call('GET', '/auth/google/callback?code=abc&state=not-the-saved-state');
    assert.strictEqual(cbBadState.status, 302);
    assert(/youtube=error/.test(cbBadState.headers.get('location') || '') && /did%20not%20match|did\+not\+match/.test(cbBadState.headers.get('location')));
    ok('the Google callback is refused without a dashboard session, and when the sign-in state does not match');

    // 10. Path traversal is blocked.
    assert.strictEqual((await fetch(`${BASE}/..%2Fserver.js`)).status, 404);
    assert.strictEqual((await fetch(`${BASE}/%2e%2e%2fserver.js`)).status, 404);
    ok('requests that try to read files outside the public folder get 404');

    // 11. Deleting the app's data: needs the exact phrase; then removes videos, music and the YouTube connection, keeps API keys.
    assert.strictEqual((await call('POST', '/api/account/erase', { confirm: 'yes' })).status, 400);
    assert.strictEqual((await call('GET', `/api/videos/${VIDEO}`)).status, 200);
    const erased = await call('POST', '/api/account/erase', { confirm: 'DELETE MY DATA' });
    assert.strictEqual(erased.status, 200);
    assert.strictEqual(erased.data.videosDeleted, 1);
    assert.strictEqual((await call('GET', '/api/videos')).data.videos.length, 0);
    assert.strictEqual((await call('GET', '/api/youtube/status')).data.connected, false);
    assert((await call('GET', '/api/keys')).data.keys.find((k) => k.name === 'ANTHROPIC_API_KEY').configured, 'API keys must be kept');
    ok('deleting data needs the exact phrase; it removes videos and the YouTube connection and keeps API keys');

    // 12. Security log: records what happened, with no secrets.
    const events = await call('GET', '/api/security/events');
    const types = new Set(events.data.events.map((e) => e.type));
    for (const t of ['login_failed', 'login_ok', 'unauthorized_api', 'csrf_rejected', 'account_erased']) assert(types.has(t), `missing event ${t}`);
    for (const secret of [PASSWORD, MARK.token, MARK.refresh, MARK.key, MARK.client]) assert(!events.text.includes(secret));
    assert(!/Authorization|aiv_session=/.test(serverOut), 'secrets printed to the console');
    ok('the security log records failed and successful logins, refused access, CSRF failures and data deletion, with no secrets');

    // 13. Login throttle: after repeated failures, even the right password is refused for a while.
    for (let i = 0; i < 7; i++) assert.strictEqual((await call('POST', '/api/login', { password: 'guess-' + i }, { noCookie: true })).status, 401);
    const throttled = await call('POST', '/api/login', { password: PASSWORD }, { noCookie: true });
    assert.strictEqual(throttled.status, 429);
    ok('repeated wrong passwords lock login for a few minutes');

    // 14. General request limit (last: it slows every request from this address for a minute).
    let limited = 0;
    for (let i = 0; i < 320; i++) if ((await fetch(`${BASE}/api/session`)).status === 429) limited++;
    assert(limited > 0, 'the request limit never tripped');
    ok('a flood of API requests is slowed down with 429');

    console.log(`\n${passed} security checks passed`);
  } finally {
    srv.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error('FAILED:', e.stack || e.message);
  process.exit(1);
});
