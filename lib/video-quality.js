'use strict';
/**
 * Quality gate for scene clips, run before the scenes are joined.
 *  - duration: each clip must be a real video of about the planned length
 *  - motion: consecutive frames must differ (a repeated still image is rejected)
 *  - duplicates: two scenes must not share the same picture
 * Uses ffmpeg/ffprobe only; no network.
 */
const crypto = require('crypto');
const { execFile } = require('child_process');

const SAMPLE_W = 64;
const SAMPLE_H = 64;
const SAMPLE_FPS = 6;
const STATIC_MEAN_DIFF = 0.6; // mean change per pixel (0–255) between samples; below this counts as still

function run(cmd, args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr || '') }));
      resolve(stdout);
    });
  });
}

async function probeDuration(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const d = Number(out.toString().trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error('clip has no readable duration');
  return d;
}

/** Decodes a small grayscale copy of the clip. Returns { frames: Buffer[] } with one buffer per sampled frame. */
async function sampleFrames(file) {
  const raw = await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', file,
    '-vf', `fps=${SAMPLE_FPS},scale=${SAMPLE_W}:${SAMPLE_H},format=gray`, '-f', 'rawvideo', '-']);
  const size = SAMPLE_W * SAMPLE_H;
  const frames = [];
  for (let i = 0; i + size <= raw.length; i += size) frames.push(raw.subarray(i, i + size));
  return frames;
}

/** Average change per pixel between consecutive sampled frames. 0 means a still picture. */
function motionFromFrames(frames) {
  if (frames.length < 2) return 0;
  let total = 0;
  for (let f = 1; f < frames.length; f++) {
    const a = frames[f - 1];
    const b = frames[f];
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    total += s / a.length;
  }
  return total / (frames.length - 1);
}

function frameHash(frame) {
  return crypto.createHash('sha1').update(frame).digest('hex');
}

/**
 * Checks one clip. Returns { ok, duration, motion, frames, problems[] }.
 * expectedSec: the planned scene length; a clip must be within 35% of it (or 0.6 s, whichever is larger).
 */
async function checkClip(file, { expectedSec } = {}) {
  const problems = [];
  let duration = 0;
  let frames = [];
  try {
    duration = await probeDuration(file);
    frames = await sampleFrames(file);
  } catch (e) {
    return { ok: false, duration: 0, motion: 0, frames: [], problems: [`clip could not be decoded: ${e.message}`] };
  }
  if (expectedSec) {
    const tol = Math.max(0.6, expectedSec * 0.35);
    if (Math.abs(duration - expectedSec) > tol) problems.push(`duration ${duration.toFixed(2)}s, expected about ${expectedSec}s`);
  }
  const motion = motionFromFrames(frames);
  if (motion < STATIC_MEAN_DIFF) problems.push(`no real motion (${motion.toFixed(2)}); looks like a still image`);
  return { ok: problems.length === 0, duration, motion, frames: frames.length, problems, hash: frames.length ? frameHash(frames[Math.floor(frames.length / 2)]) : null };
}

/**
 * Finds scenes whose middle frame matches another scene's middle frame (a repeated picture).
 * checks: array of checkClip results in scene order. Returns the indices of duplicate scenes.
 */
function findDuplicateScenes(checks) {
  const seen = new Map();
  const dupes = [];
  checks.forEach((c, i) => {
    if (!c.hash) return;
    if (seen.has(c.hash)) dupes.push(i);
    else seen.set(c.hash, i);
  });
  return dupes;
}

module.exports = { checkClip, findDuplicateScenes, motionFromFrames, probeDuration, sampleFrames, STATIC_MEAN_DIFF };
