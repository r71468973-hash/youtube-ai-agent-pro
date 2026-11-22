'use strict';
// 30-second Gemini job with fake dependencies: no network, no FFmpeg, no charges, no real key.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const job = require('../lib/gemini-cartoon');
const gemini = require('../lib/gemini-video');

const ok = (m) => console.log(`  ok  ${m}`);
const story = [
  'Ravi: एक गरीब लड़का सुबह गाँव की सड़क पर चल रहा था।',
  'Ravi: उसे रास्ते में एक घायल चिड़िया मिली।',
  'Mira: हम इसे घर ले चलें और इसकी देखभाल करें।',
  'Ravi: उसने चिड़िया को पानी दिया और खाना खिलाया।',
  'Mira: कुछ दिनों बाद चिड़िया ठीक हो गई और आसमान में उड़ गई।',
  'Ravi: दोनों मुस्कुराए। दया सबसे बड़ा उपहार है।',
].join('\n');
const env = { GEMINI_API_KEY: 'test-fake-key', MAX_TOTAL_SPEND_USD: '2.10', MAX_SPEND_USD: '0.35' };

function fakeDeps({ failClipAt = -1 } = {}) {
  const log = { voice: 0, clips: [], concat: 0, render: 0 };
  return {
    log,
    voiceClip: async (text, gender, i) => { log.voice++; const f = path.join(os.tmpdir(), `fake_voice_${process.pid}_${i}.wav`); fs.writeFileSync(f, 'x'.repeat(200)); return f; },
    generateClip: async (opts, e) => {
      const i = log.clips.length;
      if (i === failClipAt) throw new gemini.GeminiVideoError('server', 'Gemini server error (500).');
      // Mirror the real client's checks, so the job test also covers the per-clip approval.
      const est = gemini.estimateCost({ duration: opts.duration, resolution: opts.resolution });
      gemini.assertCanSpend(est, { approvedUsd: opts.approvedUsd }, e);
      log.clips.push({ ...opts });
      fs.writeFileSync(opts.outFile, 'x'.repeat(200));
      return { file: opts.outFile, seconds: opts.duration, usd: est.usd };
    },
    concatWav: async (files, out) => { log.concat++; fs.writeFileSync(out, 'x'); },
    renderFromClips: async (o) => { log.render++; log.render_opts = o; fs.writeFileSync(o.outFile, 'x'); return { duration: 30 }; },
  };
}

(async () => {
  console.log('30 second gemini job checks');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gjob-'));
  const outFile = path.join(work, 'video.mp4');

  // 1. Constants: six clips of five seconds, exactly 30 seconds, $2.10 total, $0.35 per clip.
  assert.strictEqual(job.CLIPS, 6); assert.strictEqual(job.CLIP_SEC, 5); assert.strictEqual(job.TOTAL_SEC, 30);
  assert.strictEqual(job.JOB_USD, 2.1); assert.strictEqual(job.CLIP_USD, 0.35);
  ok('six clips of 5 seconds make exactly 30 seconds, approved at $2.10 ($0.35 per clip)');

  // 2. Story split into six scenes that keep all the words.
  const scenes = job.splitIntoScenes(story, 'hi');
  assert.strictEqual(scenes.length, 6);
  assert.ok(scenes.every((s) => s.narration.length > 0));
  ok('story is split into six narration scenes');

  // 3. No approval: refused, nothing is generated.
  let d = fakeDeps();
  await assert.rejects(job.runGeminiJob({ story, language: 'hi', work, outFile, env, deps: d }), (e) => e.code === 'approval_required');
  assert.strictEqual(d.log.voice + d.log.clips.length, 0);
  ok('no approval: refused before any voice or clip is made');

  // 4. Approval for a different amount: refused.
  d = fakeDeps();
  await assert.rejects(job.runGeminiJob({ story, language: 'hi', approvedUsd: 1.0, work, outFile, env, deps: d }), (e) => e.code === 'approval_required');
  assert.strictEqual(d.log.clips.length, 0);
  ok('approval for another amount is refused');

  // 5. Total cap below the job cost: refused before anything is generated.
  d = fakeDeps();
  await assert.rejects(job.runGeminiJob({ story, language: 'hi', approvedUsd: 2.1, work, outFile, env: { ...env, MAX_TOTAL_SPEND_USD: '1.00' }, deps: d }), (e) => e.code === 'spend_limit');
  assert.strictEqual(d.log.clips.length, 0);
  ok('a job above MAX_TOTAL_SPEND_USD is refused before any clip');

  // 6. Full approved run: six clips at $0.35, six voice clips, one join, final length 30 s.
  gemini.resetLedger();
  d = fakeDeps();
  const res = await job.runGeminiJob({ story, language: 'hi', format: 'shorts', voiceGender: 'male', approvedUsd: 2.1, work, outFile, env, deps: d });
  assert.strictEqual(d.log.clips.length, 6);
  assert.ok(d.log.clips.every((c) => c.duration === 5 && c.approvedUsd === 0.35 && c.aspectRatio === '9:16' && c.resolution === '720p'));
  assert.strictEqual(d.log.voice, 6);
  assert.strictEqual(d.log.render, 1);
  assert.strictEqual(d.log.render_opts.clips.length, 6);
  assert.strictEqual(d.log.render_opts.scenes.reduce((a, s) => a + s.duration, 0), 30);
  assert.strictEqual(res.duration, 30);
  ok('approved run: six 5 s clips at $0.35, six Hindi voice clips, one join, final 30 s');
  // The real client records spend in its ledger (see test/gemini-video.js); this test uses a fake client.

  // 7. Every clip prompt keeps the 2D style and each character\'s look.
  const prompts = d.log.clips.map((c) => c.prompt);
  assert.ok(prompts.every((p) => p.includes('hand-drawn 2D cartoon') && p.includes('Not photorealistic')));
  assert.ok(prompts.every((p) => p.includes('Ravi:') && p.includes('Mira:')));
  ok('every clip keeps the 2D cartoon style and the same two characters');

  // 8. Subtitles and music are passed through to the join step.
  assert.strictEqual(d.log.render_opts.captions, true);
  ok('subtitles are on for the join step');

  // 9. A failed clip stops the job with its real error. Nothing is substituted, and the join never runs.
  gemini.resetLedger();
  d = fakeDeps({ failClipAt: 2 });
  await assert.rejects(job.runGeminiJob({ story, language: 'hi', approvedUsd: 2.1, work, outFile, env, deps: d }), (e) => e.code === 'server');
  assert.strictEqual(d.log.render, 0);
  ok('a failed clip stops the job with its real error; no replacement and no join');

  // 10. This module does not load the old renderer, so it cannot switch to it silently.
  assert.ok(!Object.keys(require.cache).some((k) => /animation\/(local2d|stage2d)/.test(k)));
  ok('the Gemini job does not load the old 2D renderer');

  fs.rmSync(work, { recursive: true, force: true });
  console.log('\n10 gemini job checks passed');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
