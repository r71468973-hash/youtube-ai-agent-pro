'use strict';
// Quality gate checks with real ffmpeg clips: a still picture must fail, moving footage must pass,
// repeated pictures must be found, and a real scene rendered by the current engine is measured.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const q = require('../lib/video-quality');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vq-'));
const ff = (args) => execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args]);
const still = path.join(dir, 'still.mp4');
const moving = path.join(dir, 'moving.mp4');
const still2 = path.join(dir, 'still2.mp4');
ff(['-f', 'lavfi', '-i', 'color=c=orange:s=320x568:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', still]);
ff(['-f', 'lavfi', '-i', 'color=c=orange:s=320x568:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', still2]);
ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x568:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', moving]);
const ok = (m) => console.log(`  ok  ${m}`);

(async () => {
  const s = await q.checkClip(still, { expectedSec: 3 });
  assert.strictEqual(s.ok, false);
  assert(s.problems.some((p) => /still image/.test(p)));
  ok('a still picture is rejected');

  const m = await q.checkClip(moving, { expectedSec: 3 });
  assert.strictEqual(m.ok, true, m.problems.join('; '));
  assert(Math.abs(m.duration - 3) < 0.2);
  ok(`moving footage passes (motion ${m.motion.toFixed(2)}, duration ${m.duration.toFixed(2)}s)`);

  const wrong = await q.checkClip(moving, { expectedSec: 8 });
  assert(wrong.problems.some((p) => /duration/.test(p)));
  ok('wrong clip length is rejected');

  const dupes = q.findDuplicateScenes([m, s, await q.checkClip(still2, { expectedSec: 3 })]);
  assert.deepStrictEqual(dupes, [2]);
  ok('a repeated picture is detected as a duplicate scene');

  // Real scenes rendered by the current free engine (stage motion), measured with the same gate.
  const { renderClips } = require('../lib/animation/local2d');
  const script = require('../lib/animation/script');
  const chars = [{ id: 'c1', skin: '#c68642', hair: '#1b1b1b', shirt: '#ff7043', pants: '#1e3a8a', longHair: false }];
  const mk = (action, shot) => ({ setting: 'village', time: 'day', shot, duration: 2, fov: 55, camera: script.cameraFor(shot, 1), characters: chars,
    timeline: [{ char: 'c1', start: 0, end: 2, action, expr: 'happy', speak: false, from: [-1, 0], to: [action === 'walk' ? 1 : 0, 0] }] });
  const work = path.join(dir, 'render');
  fs.mkdirSync(work);
  const clips = await renderClips([mk('walk', 'wide'), mk('wave', 'closeup')], { width: 360, height: 640, fps: 24, workDir: work });
  const reports = [];
  for (const c of clips) reports.push(await q.checkClip(c.file, { expectedSec: 2 }));
  console.log('  info  real engine scene motion:', reports.map((r) => `${r.motion.toFixed(2)} (${r.ok ? 'pass' : r.problems.join('; ')})`).join(' | '));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n4 quality-gate checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
