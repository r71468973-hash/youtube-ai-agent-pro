'use strict';
// Gemini Omni client checks with a fake fetch. No network, no charges, no real key.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('../lib/gemini-video');

const ok = (m) => console.log(`  ok  ${m}`);
const KEY = 'test-fake-key-not-real';
const env = { GEMINI_API_KEY: KEY, MAX_SPEND_USD: '0.35', MAX_TOTAL_SPEND_USD: '0.35' };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-test-'));
const outFile = path.join(dir, 'clip.mp4');

// A fake fetch that records every call and never touches the network.
function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {} });
    const step = script.shift();
    if (!step) throw new Error('unexpected extra request in test: ' + url);
    if (step.throw) throw Object.assign(new Error(step.throw), { name: step.throw });
    return {
      ok: step.status < 400,
      status: step.status,
      json: async () => step.json,
      text: async () => step.text || '',
      arrayBuffer: async () => Buffer.alloc(step.bytes || 0, 1),
    };
  };
  fn.calls = calls;
  return fn;
}

const okRun = () => [
  { status: 200, json: { outputs: [{ type: 'video', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123' }] } },
  { status: 200, json: { name: 'files/abc123', state: 'ACTIVE' } },
  { status: 200, bytes: 4000 },
];

(async () => {
  console.log('gemini video checks');
  g.resetLedger();

  // 1. Request shape: 9:16, 5 seconds, 720p, model ID, delivery uri.
  const body = g.buildRequest({ prompt: 'boy walks', aspectRatio: '9:16', resolution: '720p', duration: 5 });
  assert.strictEqual(body.model, 'gemini-omni-1.2-flash');
  assert.deepStrictEqual(body.response_format, { type: 'video', aspect_ratio: '9:16', resolution: '720p', duration: '5s', delivery: 'uri' });
  ok('request is 9:16, 5 seconds, 720p, model gemini-omni-1.2-flash');

  // 2. Cost: 5 seconds at 720p is exactly $0.35.
  assert.strictEqual(g.estimateCost({ duration: 5, resolution: '720p' }).usd, 0.35);
  ok('5 seconds at 720p is estimated at $0.35');

  // 3. No key: refused before any network call.
  let f = fakeFetch([]);
  await assert.rejects(g.generateClip({ outFile, prompt: 'x', aspectRatio: '9:16', duration: 5, approvedUsd: 0.35, fetchImpl: f }, {}), /GEMINI_API_KEY/);
  assert.strictEqual(f.calls.length, 0);
  ok('missing key is refused with no request');

  // 4. No approval: refused before any network call.
  f = fakeFetch([]);
  await assert.rejects(g.generateClip({ outFile, prompt: 'x', aspectRatio: '9:16', duration: 5, fetchImpl: f }, env), (e) => e.code === 'approval_required');
  assert.strictEqual(f.calls.length, 0);
  ok('no approval means no request');

  // 5. Wrong approved amount: refused.
  f = fakeFetch([]);
  await assert.rejects(g.generateClip({ outFile, prompt: 'x', aspectRatio: '9:16', duration: 5, approvedUsd: 0.5, fetchImpl: f }, env), (e) => e.code === 'approval_required');
  assert.strictEqual(f.calls.length, 0);
  ok('an approval for a different amount is refused');

  // 6. Over the per-clip cap: a 6 second clip ($0.42) is refused when the cap is $0.35.
  f = fakeFetch([]);
  await assert.rejects(g.generateClip({ outFile, prompt: 'x', aspectRatio: '9:16', duration: 6, approvedUsd: 0.42, fetchImpl: f }, env), (e) => e.code === 'spend_limit');
  assert.strictEqual(f.calls.length, 0);
  ok('a clip above MAX_SPEND_USD is refused with no request');

  // 7. Total cap: after one $0.35 clip, a second one is refused.
  g.resetLedger();
  f = fakeFetch(okRun());
  await g.generateClip({ outFile, prompt: 'boy walks', aspectRatio: '9:16', duration: 5, approvedUsd: 0.35, fetchImpl: f }, env);
  assert.strictEqual(g.ledger.spentUsd, 0.35);
  const f2 = fakeFetch([]);
  await assert.rejects(g.generateClip({ outFile, prompt: 'again', aspectRatio: '9:16', duration: 5, approvedUsd: 0.35, fetchImpl: f2 }, env), (e) => e.code === 'spend_limit');
  assert.strictEqual(f2.calls.length, 0);
  ok('the total spend cap stops a second paid clip before any request');

  // 8. Successful flow: POST, wait for ACTIVE, download. The file is written and the spend recorded once.
  assert.ok(fs.existsSync(outFile) && fs.statSync(outFile).size === 4000);
  assert.strictEqual(f.calls[0].method, 'POST');
  assert.ok(f.calls[0].url.endsWith('/v1beta/interactions'));
  assert.ok(f.calls[2].url.includes('files/abc123:download?alt=media'));
  ok('successful run: POST interactions, file ACTIVE, download saved');

  // 9. Rate limit (not billed) is retried once, and the spend is recorded once.
  g.resetLedger();
  const outRetry = path.join(dir, 'retry.mp4');
  f = fakeFetch([{ status: 429, text: 'rate limited' }, ...okRun()]);
  await g.generateClip({ outFile: outRetry, prompt: 'x', aspectRatio: '9:16', duration: 5, approvedUsd: 0.35, fetchImpl: f, maxRetries: 2 }, env);
  assert.strictEqual(f.calls.filter((c) => c.method === 'POST').length, 2);
  assert.strictEqual(g.ledger.spentUsd, 0.35);
  ok('a rate limit is retried; the spend is still recorded once');

  // 10. Server error and timeout may already be billed: they are not retried.
  g.resetLedger();
  f = fakeFetch([{ status: 500, text: 'boom' }]);
  await assert.rejects(g.generateClip({ outFile: path.join(dir, 'x.mp4'), prompt: 'x', aspectRatio: '9:16', duration: 5, approvedUsd: 0.35, fetchImpl: f, maxRetries: 2 }, env), (e) => e.code === 'server');
  assert.strictEqual(f.calls.length, 1);
  ok('a server error is not retried (the request may already be billed)');

  g.resetLedger();
  f = fakeFetch([{ throw: 'AbortError' }]);
  await assert.rejects(g.generateClip({ outFile: path.join(dir, 'y.mp4'), prompt: 'x', aspectRatio: '9:16', duration: 5, approvedUsd: 0.35, fetchImpl: f, maxRetries: 2 }, env), (e) => e.code === 'timeout');
  assert.strictEqual(f.calls.length, 1);
  ok('a timeout is not retried');

  // 11. Billing and invalid key errors are mapped to clear messages.
  g.resetLedger();
  f = fakeFetch([{ status: 402, text: 'payment required' }]);
  await assert.rejects(g.generateClip({ outFile: path.join(dir, 'z.mp4'), prompt: 'x', aspectRatio: '9:16', duration: 5, approvedUsd: 0.35, fetchImpl: f }, env), (e) => e.code === 'billing' && /billing/i.test(e.message));
  ok('a 402 response is reported as a billing problem');

  // 12. The scene prompt keeps the 2D style and the same characters.
  const p = g.buildScenePrompt({ narration: 'Ravi walks to school.', setting: 'village road', time: 'morning', characters: [{ name: 'Ravi', description: 'a 10 year old boy in a white kurta' }] });
  assert.ok(p.includes('hand-drawn 2D cartoon') && p.includes('Ravi: a 10 year old boy') && p.includes('Not photorealistic'));
  ok('scene prompts keep the 2D cartoon style and the character description');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n12 gemini video checks passed');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
