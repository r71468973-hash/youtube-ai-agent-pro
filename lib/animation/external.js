'use strict';
/**
 * Generic HTTP video-generation provider (paid, optional).
 *
 * Contract (any service that implements it can be plugged in by setting its endpoint):
 *   POST {endpoint}            body {prompt, durationSec, width, height, fps}
 *                              -> {videoUrl}                       finished immediately, or
 *                              -> {jobId}                          then poll:
 *   GET  {endpoint}/{jobId}    -> {status: "queued"|"running"|"succeeded"|"failed", videoUrl?, error?}
 * Auth: "Authorization: Bearer <VIDEO_API_KEY>". The key never leaves the server.
 *
 * This adapter is NOT tied to a specific vendor and has not been verified against a live paid
 * service from this repository. Its contract is covered by test/animation.js with a mock server.
 */
const fs = require('fs');
const path = require('path');
const { run, sleep, scrub } = require('../util');

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

function status({ endpoint, key }) {
  if (!endpoint) return { id: 'external-http', ok: false, reason: 'No video API endpoint is set. Add it in Settings to use a paid animation service.' };
  if (!key) return { id: 'external-http', ok: false, reason: 'Video API key is missing. Add VIDEO_API_KEY in Settings > API keys.' };
  return { id: 'external-http', ok: true, reason: 'External video API is configured (not verified against a live service).' };
}

async function callApi(url, { method = 'GET', body, key, timeoutMs = 60000 }) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (attempt < 3) { await sleep(2000 * attempt); continue; }
      throw new Error(`Video API network error: ${scrub(e.message)}`);
    }
    if (res.ok) return res.json();
    const text = scrub(await res.text().catch(() => '')).slice(0, 300);
    if (res.status === 402 || /credit|quota|billing|insufficient/i.test(text)) {
      throw new Error(`Video API has no credits or quota left (HTTP ${res.status}). Add credits or switch to the free local 3D renderer.`);
    }
    if (RETRY_STATUS.has(res.status) && attempt < 3) { await sleep(2000 * attempt); continue; }
    throw new Error(`Video API HTTP ${res.status}: ${text}`);
  }
}

/** Short English prompt for the scene, built from the stage spec. */
function describeSpec(spec) {
  const cast = spec.characters.map((c) => `${c.longHair ? 'girl' : 'boy'} with ${c.shirt} shirt`).join(', ');
  const actions = [...new Set(spec.timeline.filter((t) => t.action !== 'idle').map((t) => t.action))].join(', ') || 'standing';
  return `3D animated cartoon, consistent characters, ${spec.setting} setting. Characters: ${cast}. Actions: ${actions}. Smooth motion, cinematic camera.`;
}

async function normalize(src, out, { width, height, fps, duration }) {
  await run('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
    '-an',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},tpad=stop_mode=clone:stop_duration=${duration + 1},trim=duration=${duration},setpts=PTS-STARTPTS`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out,
  ]);
}

async function renderScenes(specs, { endpoint, key, width, height, fps, workDir, onProgress = () => {} }) {
  const clips = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const created = await callApi(endpoint, {
      method: 'POST', key,
      body: { prompt: describeSpec(spec), durationSec: spec.duration, width, height, fps },
    });
    let videoUrl = created.videoUrl || null;
    if (!videoUrl) {
      if (!created.jobId) throw new Error('Video API returned neither a video nor a job id.');
      const t0 = Date.now();
      for (;;) {
        if (Date.now() - t0 > 20 * 60 * 1000) throw new Error('Video API job timed out after 20 minutes.');
        await sleep(5000);
        const job = await callApi(`${endpoint.replace(/\/+$/, '')}/${encodeURIComponent(created.jobId)}`, { key });
        if (job.status === 'succeeded' && job.videoUrl) { videoUrl = job.videoUrl; break; }
        if (job.status === 'failed') throw new Error(`Video API job failed: ${scrub(job.error || 'unknown error')}`);
        onProgress((i + 0.5) / specs.length);
      }
    }
    const res = await fetch(videoUrl, { signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error(`Could not download the generated clip (HTTP ${res.status}).`);
    const raw = path.join(workDir, `raw_${i}.mp4`);
    fs.writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
    const file = path.join(workDir, `clip_${i}.mp4`);
    await normalize(raw, file, { width, height, fps, duration: spec.duration });
    fs.rmSync(raw, { force: true });
    clips.push({ file, duration: spec.duration });
    onProgress((i + 1) / specs.length);
  }
  return clips;
}

module.exports = { status, renderScenes, describeSpec };
