'use strict';
// Scene quality gate on real ffmpeg clips: a still scene fails, a moving scene passes, a repeated scene is caught.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const quality = require('../lib/quality');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-test-'));
const ff = (args) => execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args]);
const still = path.join(dir, 'still.mp4');
const moving = path.join(dir, 'moving.mp4');
const movingCopy = path.join(dir, 'moving_copy.mp4');
const other = path.join(dir, 'other.mp4');
ff(['-f', 'lavfi', '-i', 'color=c=0x5a7a3a:s=360x640:d=3:r=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', still]);
ff(['-f', 'lavfi', '-i', 'testsrc2=s=360x640:d=3:r=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', moving]);
fs.copyFileSync(moving, movingCopy);
ff(['-f', 'lavfi', '-i', 'mandelbrot=s=360x640:r=24', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', other]);

(async () => {
  // 1. A still scene is rejected as barely moving.
  const r1 = await quality.checkScenes([{ file: still }], [{ setting: 'village' }]);
  assert.strictEqual(r1.passed, false, 'still scene must fail');
  assert.ok(r1.problems[0].includes('barely moves'), r1.problems[0]);
  console.log('ok still scene is rejected');

  // 2. A moving scene passes, with its own scene number reported.
  const r2 = await quality.checkScenes([{ file: moving }, { file: other }], [{ setting: 'field' }, { setting: 'forest' }]);
  assert.strictEqual(r2.passed, true, 'moving, different scenes must pass: ' + r2.problems.join('; '));
  assert.ok(r2.scenes[0].motion >= quality.MIN_MOTION);
  console.log('ok moving scenes pass (motion', r2.scenes.map((s) => s.motion).join(', '), ')');

  // 3. A repeated scene (same picture twice) is caught with the scene numbers.
  const r3 = await quality.checkScenes([{ file: moving }, { file: movingCopy }], [{ setting: 'field' }, { setting: 'field' }]);
  assert.strictEqual(r3.passed, false, 'repeated scene must fail');
  assert.ok(r3.problems.some((p) => p.includes('scene 2 repeats scene 1')), r3.problems.join('; '));
  console.log('ok repeated scene is caught');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nquality checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
