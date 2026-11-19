'use strict';
// Gemini Omni 1.2 Flash client checks. Uses a fake fetch, so no network calls and no charges.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('../lib/gemini-video');

const KEY = 'AIzaTESTKEY_do_not_print_1234567890';
const env = { GEMINI_API_KEY: KEY, MAX_SPEND_USD: '1' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-'));
const ok = (m) => console.log(`  ok  ${m}`);
const bigMp4 = Buffer.alloc(4096, 7).toString('base64');

function fakeFetch(steps) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const step = steps.shift();
    if (!step) throw new Error('unexpected extra request');
    return { ok: step.status ? step.status < 400 : true, status: step.status || 200,
      json: async () => step.json, text: async () => step.text || '', arrayBuffer: async () => Buffer.from(step.bytes || '') };
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  // 1. Missing key gives a clear message that names the variable and never shows a key.
  assert.strictEqual(g.configStatus({}).ok, false);
  assert(/GEMINI_API_KEY/.test(g.configStatus({}).message));
  ok('missing GEMINI_API_KEY gives a clear Railway instruction');

  // 2. Cost estimate uses the verified 720p price. Other resolutions and lengths are refused.
  assert.strictEqual(g.estimateCost({ duration: 10, resolution: '720p' }).usd, 0.7);
  assert.throws(() => g.estimateCost({ duration: 10, resolution: '1080p' }), /No verified price/);
  assert.throws(() => g.estimateCost({ duration: 2, resolution: '720p' }), /from 3 to 15/);
  assert.throws(() => g.estimateCost({ duration: 16, resolution: '720p' }), /from 3 to 15/);
  ok('cost: 10 s at 720p = $0.70; unverified resolutions and out-of-range lengths refused');

  // 3. Spending limit and approval are enforced before any request.
  const e10 = g.estimateCost({ duration: 10, resolution: '720p' });
  assert.throws(() => g.assertCanSpend(e10, { approvedUsd: 0.7 }, { MAX_SPEND_USD: '0.5' }), /above the limit/);
  assert.throws(() => g.assertCanSpend(e10, {}, env), /needs your approval/);
  assert.throws(() => g.assertCanSpend(e10, { approvedUsd: 0.1 }, env), /needs your approval/);
  g.assertCanSpend(e10, { approvedUsd: 0.7 }, env);
  ok('spend limit blocks over-cap; approval must match the exact estimate');

  // 4. Request body matches the documented schema.
  const text = g.buildRequest({ prompt: 'गाँव में बच्चा दौड़ता है', aspectRatio: '9:16', resolution: '720p', duration: 5 });
  assert.strictEqual(text.model, 'gemini-omni-1.2-flash');
  assert.strictEqual(typeof text.input, 'string');
  assert.deepStrictEqual(text.response_format, { type: 'video', aspect_ratio: '9:16', resolution: '720p', duration: '5s', delivery: 'uri' });
  const img = g.buildRequest({ prompt: 'x', imageBase64: 'QUJD', imageMime: 'image/png', duration: 4, task: 'image_to_video' });
  assert(Array.isArray(img.input) && img.input[1].type === 'image' && img.input[1].mime_type === 'image/png');
  assert.strictEqual(img.generation_config.video_config.task, 'image_to_video');
  assert.throws(() => g.buildRequest({ prompt: 'x', aspectRatio: '4:3' }), /Aspect ratio/);
  ok('request body: model ID, input forms, response_format, image part and task');

  // 5. No approval means no network request at all.
  const noApproval = fakeFetch([]);
  await assert.rejects(g.generateClip({ prompt: 'p', duration: 5, outFile: path.join(tmp, 'a.mp4'), fetchImpl: noApproval }, env), /needs your approval/);
  assert.strictEqual(noApproval.calls.length, 0);
  ok('without approval: zero network requests');

  // 6. Approved generation with inline video writes the file and sends the key only in a header.
  const f1 = fakeFetch([{ json: { steps: [{ content: { data: bigMp4, mime_type: 'video/mp4' } }] } }]);
  const out1 = path.join(tmp, 'b.mp4');
  const r1 = await g.generateClip({ prompt: 'p', duration: 5, approvedUsd: 0.35, outFile: out1, fetchImpl: f1 }, env);
  assert.strictEqual(fs.existsSync(out1), true);
  assert.strictEqual(f1.calls[0].init.headers['x-goog-api-key'], KEY);
  assert(!f1.calls[0].url.includes(KEY));
  assert.strictEqual(r1.usd, 0.35);
  ok('approved clip saved; key sent only in the x-goog-api-key header');

  // 7. Retry limits: rate limits are retried, bad requests and bad keys are not.
  const f2 = fakeFetch([{ status: 429, text: 'quota' }, { status: 503, text: '' }, { json: { data: bigMp4, mime_type: 'video/mp4' } }]);
  await g.generateClip({ prompt: 'p', duration: 5, approvedUsd: 0.35, outFile: path.join(tmp, 'c.mp4'), fetchImpl: f2 }, env);
  assert.strictEqual(f2.calls.length, 3);
  ok('429 and 503 are retried (3 attempts in total), then succeed');

  const f3 = fakeFetch([{ status: 400, text: 'bad request' }]);
  await assert.rejects(g.generateClip({ prompt: 'p', duration: 5, approvedUsd: 0.35, outFile: path.join(tmp, 'd.mp4'), fetchImpl: f3 }, env), (e) => e.code === 'request_failed');
  assert.strictEqual(f3.calls.length, 1);
  ok('400 is not retried');

  const f4 = fakeFetch([{ status: 401, text: 'API key not valid' }]);
  await assert.rejects(g.generateClip({ prompt: 'p', duration: 5, approvedUsd: 0.35, outFile: path.join(tmp, 'e.mp4'), fetchImpl: f4 }, env), (e) => {
    assert(e.code === 'invalid_key' && !e.message.includes(KEY));
    return true;
  });
  ok('invalid key gives a clear message without the key');

  const f5 = fakeFetch([{ status: 403, text: 'Billing account has insufficient balance' }]);
  await assert.rejects(g.generateClip({ prompt: 'p', duration: 5, approvedUsd: 0.35, outFile: path.join(tmp, 'f.mp4'), fetchImpl: f5 }, env), (e) => e.code === 'billing');
  ok('insufficient balance gives a clear billing message');

  // 8. URI path: poll the file until ACTIVE, then download.
  const f6 = fakeFetch([
    { json: { steps: [{ content: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123' } }] } },
    { json: { state: 'PROCESSING' } },
    { json: { state: 'ACTIVE' } },
    { bytes: Buffer.alloc(4096, 9) },
  ]);
  const out6 = path.join(tmp, 'g.mp4');
  await g.generateClip({ prompt: 'p', duration: 5, approvedUsd: 0.35, outFile: out6, fetchImpl: f6, timeoutMs: 5000 }, env);
  assert(f6.calls[3].url.endsWith('files/abc123:download?alt=media'));
  assert.strictEqual(fs.statSync(out6).size, 4096);
  ok('uri path: polls until ACTIVE, downloads the MP4');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n8 Gemini Omni checks passed (no network, no charges)');
})().catch((e) => { console.error(e); process.exit(1); });
