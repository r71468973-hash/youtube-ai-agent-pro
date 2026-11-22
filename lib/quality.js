'use strict';
/**
 * Free scene quality gate. It reads real frames from each rendered scene clip (ffmpeg, no paid services) and checks:
 *   1. Motion: the scene visibly changes over its length (a still or near-still scene fails).
 *   2. Repetition: no two scenes of one video share nearly the same picture (a repeated background or scene fails).
 * A failed check is reported with the scene number and reason. It never substitutes a still image.
 */
const { spawn } = require('child_process');

const SAMPLE_FPS = 8;
const SAMPLE_W = 64;
const SAMPLE_H = 114;
const FRAME_BYTES = SAMPLE_W * SAMPLE_H;

// Thresholds: mean absolute gray difference (0-255) between sampled frames. Set from real renders (see test).
const MIN_MOTION = Number(process.env.QUALITY_MIN_MOTION) || 1.5;
const MIN_SCENE_DIFF = Number(process.env.QUALITY_MIN_SCENE_DIFF) || 6.0;

/** Reads sampled gray frames from a clip. Resolves to an array of Buffers (one per frame). */
function sampleFrames(file, ffmpegBin = 'ffmpeg', timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file,
      '-vf', `fps=${SAMPLE_FPS},scale=${SAMPLE_W}:${SAMPLE_H},format=gray`, '-f', 'rawvideo', '-'];
    const child = spawn(ffmpegBin, args);
    const chunks = [];
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('quality check timed out reading a scene')); }, timeoutMs);
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', () => {});
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg could not read the scene clip (exit ${code})`));
      const all = Buffer.concat(chunks);
      const frames = [];
      for (let o = 0; o + FRAME_BYTES <= all.length; o += FRAME_BYTES) frames.push(all.subarray(o, o + FRAME_BYTES));
      resolve(frames);
    });
  });
}

/** Mean absolute difference between two gray frames. */
function frameDiff(a, b) {
  let s = 0;
  for (let i = 0; i < FRAME_BYTES; i++) s += Math.abs(a[i] - b[i]);
  return s / FRAME_BYTES;
}

/** Motion of one scene: mean difference between consecutive sampled frames. */
function motionOf(frames) {
  if (frames.length < 2) return 0;
  let s = 0;
  for (let i = 1; i < frames.length; i++) s += frameDiff(frames[i - 1], frames[i]);
  return s / (frames.length - 1);
}

/**
 * Checks every scene. `clips` = [{file}], `specs` = scene specs (for names in the report).
 * Returns { passed, scenes: [{index, motion, setting, time, shot, mid}], problems: [string] }.
 */
async function checkScenes(clips, specs, { ffmpegBin, minMotion = MIN_MOTION, minSceneDiff = MIN_SCENE_DIFF } = {}) {
  const scenes = [];
  const problems = [];
  for (let i = 0; i < clips.length; i++) {
    const frames = await sampleFrames(clips[i].file, ffmpegBin);
    const motion = motionOf(frames);
    const mid = frames[Math.floor(frames.length / 2)];
    const spec = specs[i] || {};
    scenes.push({ index: i + 1, motion: Math.round(motion * 100) / 100, setting: spec.setting, time: spec.time, shot: spec.shot, mid });
    if (motion < minMotion) problems.push(`scene ${i + 1} barely moves (motion ${motion.toFixed(2)} < ${minMotion})`);
  }
  // Repetition: two scenes with almost the same middle picture.
  for (let i = 0; i < scenes.length; i++) {
    for (let j = i + 1; j < scenes.length; j++) {
      const d = frameDiff(scenes[i].mid, scenes[j].mid);
      if (d < minSceneDiff) problems.push(`scene ${scenes[j].index} repeats scene ${scenes[i].index} (picture difference ${d.toFixed(2)} < ${minSceneDiff})`);
    }
  }
  const report = scenes.map(({ mid, ...rest }) => rest);
  return { passed: problems.length === 0, scenes: report, problems };
}

module.exports = { checkScenes, sampleFrames, frameDiff, motionOf, MIN_MOTION, MIN_SCENE_DIFF };
