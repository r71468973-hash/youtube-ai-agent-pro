'use strict';
// Free tests: no network, no paid calls. Covers the persistent ledger, duplicate blocking,
// clip resume, reference-image storage and the request shape with a reference image.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ledger = require('../lib/gemini-ledger');
const g = require('../lib/gemini-video');
const job = require('../lib/gemini-cartoon');
const refs = require('../lib/character-refs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gem-persist-'));
const L = path.join(tmp, 'ledger.json');
let n = 0;
async function check(name, fn) {
  await fn();
  n += 1;
  console.log(`  ok  ${name}`);
}

const okResponse = () => ({
  ok: true,
  json: async () => ({ outputs: [{ mime_type: 'video/mp4', data: 'A'.repeat(2000) }] }),
  text: async () => '',
});
const env = { GEMINI_API_KEY: 'test-key-not-real', MAX_TOTAL_SPEND_USD: '5', MAX_SPEND_USD: '1' };

(async () => {
  await check('ledger: reservation is written to disk and totals persist', () => {
    ledger.reserve(L, 'a', 0.35, 5);
    assert.strictEqual(ledger.totalUsd(L), 0.35);
    ledger.settle(L, 'a', 'done');
    assert.strictEqual(ledger.statusOf(L, 'a'), 'done');
    assert.strictEqual(ledger.totalUsd(L), 0.35); // still counted after settle
  });

  await check('ledger: a finished clip cannot be reserved again (no duplicate charge)', () => {
    assert.throws(() => ledger.reserve(L, 'a', 0.35, 5), (e) => e.code === 'already_generated');
    assert.strictEqual(ledger.totalUsd(L), 0.35);
  });

  await check('ledger: an unfinished reservation blocks a silent re-send', () => {
    ledger.reserve(L, 'crash', 0.35, 5); // simulates a crash after reserving, before settling
    assert.throws(() => ledger.reserve(L, 'crash', 0.35, 5), (e) => e.code === 'duplicate_pending');
  });

  await check('ledger: a failed clip needs an explicit retry approval', () => {
    ledger.settle(L, 'crash', 'failed');
    assert.throws(() => ledger.reserve(L, 'crash', 0.35, 5), (e) => e.code === 'previous_failure');
    ledger.reserve(L, 'crash', 0.35, 5, { allowRetry: true });
    assert.strictEqual(ledger.statusOf(L, 'crash'), 'reserved');
    assert.strictEqual(ledger.totalUsd(L), 0.7); // a retry replaces its own old amount, never adds to it
  });

  await check('ledger: the cap is enforced from the file total, so a restart cannot reset it', () => {
    // total now 0.35 (a) + 0.35 (crash) = 0.70; a cap of 0.90 refuses a further 0.35
    assert.throws(() => ledger.reserve(L, 'third', 0.35, 0.9), (e) => e.code === 'spend_limit');
    assert.strictEqual(ledger.statusOf(L, 'third'), null);
  });

  await check('ledger: a damaged file blocks spending instead of assuming zero', () => {
    const bad = path.join(tmp, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    assert.throws(() => ledger.reserve(bad, 'x', 0.35, 5), (e) => e.code === 'ledger_unreadable');
  });

  await check('client: with a ledger file, a paid clip is saved, recorded, and never sent twice', async () => {
    const lf = path.join(tmp, 'client-ledger.json');
    let calls = 0;
    const f = async () => { calls += 1; return okResponse(); };
    const out = path.join(tmp, 'c1.mp4');
    await g.generateClip({ outFile: out, prompt: 'boy walks', aspectRatio: '9:16', duration: 5, approvedUsd: 0.35, fetchImpl: f, ledgerFile: lf, ledgerKey: 'video:t1:clip0' }, env);
    assert.ok(fs.statSync(out).size > 1000);
    assert.strictEqual(ledger.statusOf(lf, 'video:t1:clip0'), 'done');
    await assert.rejects(
      g.generateClip({ outFile: path.join(tmp, 'c1b.mp4'), prompt: 'boy walks', aspectRatio: '9:16', duration: 5, approvedUsd: 0.35, fetchImpl: f, ledgerFile: lf, ledgerKey: 'video:t1:clip0' }, env),
      (e) => e.code === 'already_generated'
    );
    assert.strictEqual(calls, 1, 'the second call must not reach the network');
  });

  await check('client: a failed paid request is recorded as failed and not re-sent by default', async () => {
    const lf = path.join(tmp, 'fail-ledger.json');
    let calls = 0;
    const bad = async () => { calls += 1; return { ok: false, status: 400, text: async () => 'bad request' }; };
    const out = path.join(tmp, 'f.mp4');
    await assert.rejects(g.generateClip({ outFile: out, prompt: 'x', aspectRatio: '9:16', duration: 5, approvedUsd: 0.35, fetchImpl: bad, ledgerFile: lf, ledgerKey: 'k1' }, env));
    assert.strictEqual(ledger.statusOf(lf, 'k1'), 'failed');
    await assert.rejects(
      g.generateClip({ outFile: out, prompt: 'x', aspectRatio: '9:16', duration: 5, approvedUsd: 0.35, fetchImpl: bad, ledgerFile: lf, ledgerKey: 'k1' }, env),
      (e) => e.code === 'previous_failure'
    );
    assert.strictEqual(calls, 1);
  });

  await check('client: a bad prompt is refused before anything is recorded', async () => {
    const lf = path.join(tmp, 'none-ledger.json');
    await assert.rejects(g.generateClip({ outFile: path.join(tmp, 'n.mp4'), prompt: '', aspectRatio: '9:16', duration: 5, approvedUsd: 0.35, fetchImpl: async () => okResponse(), ledgerFile: lf, ledgerKey: 'n1' }, env), (e) => e.code === 'invalid_prompt');
    assert.ok(!fs.existsSync(lf));
  });

  await check('request: a reference image is sent as an image part alongside the prompt', () => {
    const body = g.buildRequest({ prompt: 'boy walks', aspectRatio: '9:16', duration: 5, imageBase64: 'QUJD', imageMime: 'image/png' });
    assert.ok(Array.isArray(body.input));
    assert.deepStrictEqual(body.input[1], { type: 'image', data: 'QUJD', mime_type: 'image/png' });
    assert.strictEqual(body.model, g.MODEL_ID);
  });

  await check('references: a PNG saves, loads back, lists and deletes; text files are refused', () => {
    const dir = path.join(tmp, 'refs');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000, 1)]);
    const saved = refs.saveRef(dir, 'Ravi (Boy)', png);
    assert.strictEqual(saved.name, 'ravi-boy');
    const back = refs.loadRef(dir, 'Ravi (Boy)');
    assert.strictEqual(back.mime, 'image/png');
    assert.strictEqual(Buffer.from(back.base64, 'base64').length, png.length);
    assert.deepStrictEqual(refs.listRefs(dir).map((r) => r.name), ['ravi-boy']);
    assert.throws(() => refs.saveRef(dir, 'x', Buffer.from('hello world, this is plain text, not an image at all, just words padded out to be long enough to pass the size check. '.repeat(3))), (e) => e.code === 'bad_image');
    assert.throws(() => refs.saveRef(dir, 'x', Buffer.alloc(100)), (e) => e.code === 'bad_image');
    assert.strictEqual(refs.deleteRef(dir, 'Ravi (Boy)'), true);
    assert.strictEqual(refs.loadRef(dir, 'Ravi (Boy)'), null);
  });

  await check('job: a crash after clip 3 resumes at clip 4 without paying again for clips 1-3', async () => {
    const work = path.join(tmp, 'work');
    fs.mkdirSync(work, { recursive: true });
    const story = 'Ram gaon mein chala. Usne chidiya dekhi. Woh uske paas gaya. Usne chidiya ko uthaya. Chidiya ne aankh kholi. Dono dost ban gaye.';
    const lf = path.join(tmp, 'job-ledger.json');
    const paidFor = [];
    let failAt = 3;
    const deps = {
      voiceClip: async (text, gender, i) => path.join(work, `v${i}.wav`),
      generateClip: async (opts) => {
        const idx = Number(opts.outFile.match(/gemini_clip_(\d+)/)[1]);
        if (idx === failAt) { failAt = -1; throw Object.assign(new Error('server down'), { code: 'server' }); }
        fs.writeFileSync(opts.outFile, Buffer.alloc(2000, 7));
        paidFor.push(idx);
        return { file: opts.outFile, ledgerKey: opts.ledgerKey };
      },
      concatWav: async () => {},
      renderFromClips: async () => ({ duration: 30 }),
    };
    const base = { story, language: 'hi', format: 'shorts', voiceGender: 'male', approvedUsd: 2.1, env: { ...env, MAX_TOTAL_SPEND_USD: '5' }, work, outFile: path.join(tmp, 'final.mp4'), deps, ledgerFile: lf, jobKey: 'video:t9' };
    await assert.rejects(job.runGeminiJob(base), (e) => e.code === 'server');
    assert.deepStrictEqual(paidFor, [0, 1, 2]);
    const res = await job.runGeminiJob(base);
    assert.strictEqual(res.duration, 30);
    assert.deepStrictEqual(paidFor.slice(3), [3, 4, 5], 'the second run paid only for clips 3, 4 and 5');
  });

  console.log(`\n${n} gemini persistence checks passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
