'use strict';
/**
 * Real 2D cartoon rendering checks (headless Chrome, Canvas 2D): backgrounds differ by setting,
 * a scene dissolves in from the last frame of the scene before it, and the characters move.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { renderClips, status } = require('../lib/animation/local2d');
const script = require('../lib/animation/script');

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

if (!status().ok) {
  console.log('  skip  2D stage rendering needs Chrome; the renderer reports: ' + status().reason);
  process.exit(0);
}

const W = 360;
const H = 640;
const chars = [{ id: 'c1', skin: '#c68642', hair: '#1b1b1b', shirt: '#ff7043', pants: '#1e3a8a', longHair: false }];
const scene = (setting, action) => ({
  setting, time: 'day', shot: 'medium', duration: 1, fov: 55,
  camera: script.cameraFor('medium', 1), characters: chars,
  timeline: [{ char: 'c1', start: 0, end: 1, action, expr: 'happy', speak: false, from: [-1, 0], to: [action === 'walk' ? 0.5 : -1, 0] }],
});

/** Grey pixels of one frame at time t (seconds) of an MP4. */
function grab(file, t) {
  return execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
}
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoon-stage-'));
  try {
    const A = scene('village', 'idle');
    const B = scene('river', 'walk');
    const built = [{ spec: A, duration: 1 }, { spec: JSON.parse(JSON.stringify(B)), duration: 1 }];
    script.linkTransitions(built);
    const clips = await renderClips([built[0].spec, built[1].spec], { width: W, height: H, fps: 24, workDir: work });
    assert.strictEqual(clips.length, 2);
    ok('two 2D cartoon scenes rendered through headless Chrome');

    const lastA = grab(clips[0].file, 0.95);
    const firstB = grab(clips[1].file, 0);
    const midB = grab(clips[1].file, 0.17);
    const lateB = grab(clips[1].file, 0.9);
    // The dissolve starts from the old scene's last frame, so the first frame of the new scene looks the same.
    assert(diff(firstB, lastA) < 6, 'dissolve starts from the last frame of the previous scene: ' + diff(firstB, lastA).toFixed(2));
    ok('a new scene dissolves in from the last frame of the scene before it');
    assert(diff(midB, firstB) > 0.5 && diff(midB, lateB) > 0.5, 'the dissolve is gradual');
    ok('the dissolve changes gradually (not a hard cut)');
    assert(diff(lateB, lastA) > 4, 'a river scene looks different from a village scene');
    ok('backgrounds differ by setting (village and river are not the same picture)');
    const stillA = grab(clips[0].file, 0.0);
    assert(diff(stillA, grab(clips[0].file, 0.9)) > 0.2, 'the scene moves over time');
    ok('the scene is animated over time (camera and characters move)');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(`\n${passed} 2D cartoon stage checks passed`);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
