'use strict';
// Engine routing with a fake Gemini fetch (no network, no charges) and real ffmpeg clips.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { renderScene } = require('../lib/video-engine');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-'));
const ff = (args) => execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args]);
const mk = (name, src) => { const f = path.join(dir, name); ff(['-f', 'lavfi', '-i', src, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]); return f; };
const movingMp4 = mk('moving.mp4', 'testsrc2=s=320x568:r=24:d=5');
const stillMp4 = mk('still.mp4', 'color=c=teal:s=320x568:r=24:d=5');
const b64 = (f) => fs.readFileSync(f).toString('base64');
const KEY = 'AIzaTESTKEY_engine_1234567890';
const withKey = { GEMINI_API_KEY: KEY, MAX_SPEND_USD: '1' };
const ok = (m) => console.log(`  ok  ${m}`);
const fakeFetch = (bodies) => {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); const b = bodies.shift(); return { ok: true, status: 200, json: async () => b, text: async () => '' }; };
  fn.calls = calls; return fn;
};
const local = async () => mk(`local_${Math.random().toString(36).slice(2)}.mp4`, 'testsrc2=s=320x568:r=24:d=5');
const base = { index: 0, prompt: 'बच्चा गाँव में दौड़ता है', duration: 5, aspectRatio: '9:16', resolution: '720p', localRender: local };

(async () => {
  // 1. No key: free renderer, labelled, no network.
  const r1 = await renderScene({ ...base, outFile: path.join(dir, 'r1.mp4') }, {});
  assert.strictEqual(r1.engine, 'local');
  assert(/GEMINI_API_KEY is missing/.test(r1.reason));
  ok('no key: free renderer, with the reason stated');

  // 2. Key but no approval: no paid request at all.
  const f2 = fakeFetch([]);
  const r2 = await renderScene({ ...base, outFile: path.join(dir, 'r2.mp4'), fetchImpl: f2 }, withKey);
  assert.strictEqual(f2.calls.length, 0);
  assert.strictEqual(r2.engine, 'local');
  assert(/no approval/.test(r2.reason));
  ok('key present but not approved: zero paid requests, free renderer used');

  // 3. Approved, but Gemini returns a still picture: rejected by the gate, falls back to local.
  const f3 = fakeFetch([{ steps: [{ content: { data: b64(stillMp4), mime_type: 'video/mp4' } }] }]);
  const r3 = await renderScene({ ...base, approvedUsd: 0.35, outFile: path.join(dir, 'r3.mp4'), fetchImpl: f3 }, withKey);
  assert.strictEqual(r3.engine, 'local');
  assert(/no real motion|Gemini clip rejected/.test(r3.reason), r3.reason);
  ok('approved but still picture from Gemini: rejected, falls back, never labelled as Gemini');

  // 4. Approved and moving footage: Gemini clip accepted and labelled gemini.
  const f4 = fakeFetch([{ steps: [{ content: { data: b64(movingMp4), mime_type: 'video/mp4' } }] }]);
  const r4 = await renderScene({ ...base, approvedUsd: 0.35, outFile: path.join(dir, 'r4.mp4'), fetchImpl: f4 }, withKey);
  assert.strictEqual(r4.engine, 'gemini');
  assert.strictEqual(f4.calls.length, 1);
  assert(!JSON.stringify(r4).includes(KEY));
  ok('approved and real motion: Gemini clip used, key not in the result');

  // 5. Gemini error (bad key): falls back, reason says so, key not echoed.
  const f5 = { calls: [], fn: null };
  const badFetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'API key not valid' });
  const r5 = await renderScene({ ...base, approvedUsd: 0.35, outFile: path.join(dir, 'r5.mp4'), fetchImpl: badFetch }, withKey);
  assert.strictEqual(r5.engine, 'local');
  assert(/Gemini failed: Gemini rejected the API key/.test(r5.reason));
  assert(!r5.reason.includes(KEY));
  ok('invalid key: falls back to local with a clear reason, key never echoed');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n5 engine routing checks passed (no network, no charges)');
})().catch((e) => { console.error(e); process.exit(1); });
