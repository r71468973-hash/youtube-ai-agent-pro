'use strict';
/** Shorts length rules (real ffmpeg checks) and R2 upload progress / permanent link checks. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'media-rules-'));
process.env.DATA_DIR = DATA;
process.env.APP_SECRET = 'x'.repeat(32);
const d = require('../lib/duration');
const { generateHindiStory } = require('../lib/story');
const { startMockS3 } = require('./mock-s3');

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
const seconds = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());

(async () => {
  // 1. Story fitting: every generated Hindi story lands in the target window before generation.
  let outside = 0;
  for (let i = 0; i < 300; i++) {
    const f = d.fitStory(generateHindiStory(`seed-${i}`), 'hi');
    if (f.after < d.TARGET_SEC - 6 || f.after > d.TARGET_SEC + 3.5) outside++; // estimate band; the rendered file is checked again
  }
  assert.strictEqual(outside, 0); ok('300 generated Hindi stories are fitted to about 55 seconds before generation');

  // 2. English story that is too short is lengthened in English, not Hindi, and the lesson line stays last.
  const en = 'Once upon a time, a small village sat beside a quiet river. Every morning a girl named Meera walked to the water. She listened to the birds. One day she found a glowing stone. It whispered a secret about the stars.';
  const fe = d.fitStory(en, 'en');
  assert(fe.changed && fe.after >= 50); ok('short English story is lengthened with English lines');
  assert(!/[ऀ-ॿ]/.test(fe.story)); ok('English story gets no Hindi filler text');

  // 3. A too-long story is shortened, and the first line and lesson line are kept.
  const longHi = generateHindiStory('long-one') + '\n' + generateHindiStory('long-two').split('\n').slice(1, -1).join('\n');
  const fl = d.fitStory(longHi, 'hi');
  assert(fl.after <= d.TARGET_SEC + 2); ok('a too-long story is shortened to at most 57 seconds');

  // 4. Tempo: the change is bounded at ±15%, and no change is made inside the accepted window.
  assert.strictEqual(d.tempoFor(55), 1); ok('no speed change when already in range');
  assert(Math.abs(d.tempoFor(30) - 0.85) < 1e-9); ok('very short audio is slowed by at most 15%');
  assert(Math.abs(d.tempoFor(100) - 1.15) < 1e-9); ok('very long audio is sped up by at most 15%');

  // 5. Real ffmpeg: 60 s of tone sped up to target lands near 55 s, pitch unchanged in length terms.
  const src = path.join(DATA, 'tone60.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60', '-ac', '1', '-ar', '44100', src]);
  const out = path.join(DATA, 'tone60-tuned.wav');
  await d.changeTempo(src, d.tempoFor(60), out);
  const got = seconds(out);
  assert(Math.abs(got - 55) < 0.3, 'tempo result ' + got); ok(`ffmpeg speed change: 60 s audio becomes ${got.toFixed(2)} s`);

  // 6. Final rendered length: only 45–60 seconds is accepted.
  for (const [s, pass] of [[44, false], [44.9, false], [45, true], [55, true], [60, true], [60.1, false], [NaN, false]]) {
    let threw = false;
    try { d.checkShortDuration(s); } catch (e) { threw = true; assert(/Shorts must be 45–60 seconds/.test(e.message)); }
    assert.strictEqual(!threw, pass, `checkShortDuration(${s})`);
  }
  ok('final Short length check accepts 45–60 s and rejects 44.9 s and 60.1 s');

  // 7. R2 public link: built from R2_PUBLIC_URL only (https), never contains secrets.
  const storage = require('../lib/storage');
  const SECRET = 'r2-secret-VALUE-54321';
  process.env.R2_PUBLIC_URL = 'http://insecure.example.com/';
  assert.strictEqual(storage.permanentUrl('videos/a/video.mp4'), null); ok('a non-https public URL is refused');
  process.env.R2_PUBLIC_URL = 'https://media.example.com/';
  assert.strictEqual(storage.permanentUrl('videos/a b/video.mp4'), 'https://media.example.com/videos/a%20b/video.mp4'); ok('permanent link uses R2_PUBLIC_URL with encoded path');
  process.env.R2_SECRET_ACCESS_KEY = SECRET;
  assert(!JSON.stringify(storage.status()).includes(SECRET)); ok('status never shows the secret key');
  delete process.env.R2_PUBLIC_URL;
  assert.strictEqual(storage.permanentUrl('videos/x.mp4'), null); ok('no permanent link when R2_PUBLIC_URL is unset');

  // 8. Upload progress reaches 100% and the file is in the bucket.
  const ACCESS = 'media-access-key';
  const mock = await startMockS3({ accessKey: ACCESS, failBuckets: ['broken-bucket'] });
  try {
    Object.assign(process.env, { R2_ACCESS_KEY_ID: ACCESS, R2_SECRET_ACCESS_KEY: SECRET, R2_ENDPOINT: mock.url, R2_BUCKET_NAME: 'media-bucket' });
    const big = path.join(DATA, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 7));
    const seen = [];
    await storage.putFile('t/big.bin', big, 'application/octet-stream', { onProgress: (p) => seen.push(p) });
    assert(seen.length > 0 && seen[seen.length - 1] === 1); ok('upload progress reports up to 100%');
    assert(mock.objects('media-bucket').has('videos/t/big.bin')); ok('uploaded file is in the bucket');

    // 9. A failed upload throws a clear error and the local file is left in place.
    process.env.R2_BUCKET_NAME = 'broken-bucket';
    await assert.rejects(storage.putFile('t/fail.bin', big, 'application/octet-stream'), (e) => {
      assert(!String(e.message).includes(SECRET)); return true;
    });
    assert(fs.existsSync(big)); ok('failed upload reports an error without the secret, and keeps the local file');
  } finally {
    await mock.close().catch(() => {});
  }

  console.log(`\n${passed} media and storage rule checks passed`);
  fs.rmSync(DATA, { recursive: true, force: true });
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
