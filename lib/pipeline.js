'use strict';
/**
 * Video generation jobs (2D cartoon only).
 *  story -> characters and dialogue -> per-line Hindi/English voices -> 2D cartoon scenes drawn by the
 *  free local renderer -> voice + footsteps + music + subtitles -> MP4.
 * Ends at "ready" for review. Nothing is uploaded here: upload needs the owner's approval.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const storage = require('./storage');
const providers = require('./providers');
const render = require('./render');
const vault = require('./vault');
const animation = require('./animation');
const script = require('./animation/script');
const { DATA_DIR, FORMATS, renderSize } = require('./config');
const { ensureDir, run, mediaDuration, scrub } = require('./util');
const shortLength = require('./duration');
const sfx = require('./sfx');

const MODE = '2d-cartoon';

const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const MUSIC_DIR = path.join(DATA_DIR, 'music');
const videoDir = (id) => path.join(VIDEOS_DIR, id);

// One render at a time: ffmpeg and headless Chrome are CPU heavy.
const queue = [];
let running = false;
function enqueue(id) {
  queue.push(id);
  pump();
}
async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const id = queue.shift();
    try { await generate(id); } catch (e) { fail(id, e); }
  }
  running = false;
}

function patch(id, fields) {
  const v = store.getVideo(id);
  if (!v) return null;
  Object.assign(v, fields);
  return store.saveVideo(v);
}
function fail(id, e) {
  console.error(`[job ${id}]`, scrub(e && e.message));
  patch(id, { status: 'failed', error: scrub(e && e.message) || 'Unknown error', progress: 0 });
}

/** WAV, 44.1kHz mono, exactly `seconds` long (voice padded with silence at the end). */
async function toPaddedWav(input, seconds, out) {
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  if (input) args.push('-i', input);
  else args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono');
  args.push('-af', 'apad', '-ar', '44100', '-ac', '1', '-t', seconds.toFixed(3), out);
  await run('ffmpeg', args);
}

async function concatWav(files, out) {
  const list = `${out}.txt`;
  fs.writeFileSync(list, files.map((f) => `file '${path.resolve(f)}'`).join('\n'));
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
}

/** Records once when a paid voice failed and a free voice was used instead. */
function noteVoiceFallback(r, warnings) {
  if (!r.fallbackFrom || warnings.some((w) => w.includes('fell back to'))) return;
  warnings.push(`The ${r.fallbackFrom} voice failed (${r.reason}), so the free ${r.provider} voice was used instead.`);
}

function resolveMusic(v, warnings) {
  let musicFile = null;
  let musicKind = null;
  if (v.music && v.music !== 'none') {
    if (v.music.startsWith('upload:')) {
      const m = store.getMusic(v.music.slice(7));
      if (m && fs.existsSync(m.file)) musicFile = m.file;
      else warnings.push('The selected music track is missing; rendered without music.');
    } else musicKind = v.music;
  }
  return { musicFile, musicKind };
}

/** Shared ending for both modes: thumbnail, size, cloud copy, status "ready". */
/** Keeps the voice-over as one small AAC file (voice.m4a) so it can be saved with the video. Best effort. */
async function keepVoice(files, dir) {
  try {
    const wav = path.join(dir, 'voice.wav');
    await concatWav(files, wav);
    await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'aac', '-b:a', '96k', path.join(dir, 'voice.m4a')]);
    fs.rmSync(wav, { force: true });
  } catch { /* the voice copy is optional; the video itself does not depend on it */ }
}

/** Files saved per video, in the order they are uploaded. Missing files are skipped. */
const CLOUD_FILES = [
  { name: 'video.mp4', type: 'video/mp4', kind: 'video' },
  { name: 'thumb.jpg', type: 'image/jpeg', kind: 'thumbnail' },
  { name: 'voice.m4a', type: 'audio/mp4', kind: 'audio' },
  { name: 'subtitles.ass', type: 'text/plain; charset=utf-8', kind: 'subtitles' },
];

/** Metadata written next to the files: what was made, when, and any warnings. Secrets are never included. */
function writeMetadata(dir, id) {
  const v = store.getVideo(id) || {};
  const meta = {
    id, createdAt: v.createdAt, savedAt: new Date().toISOString(), title: v.title || null,
    format: v.format, language: v.language, mode: v.mode || MODE, engine: v.engine || null,
    duration: v.duration || null, size: v.size || null, scenes: (v.scenes || []).length,
    story: v.story || '', warnings: v.warnings || [],
  };
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(meta, null, 2), 'utf8');
}

/**
 * Uploads one video's files to cloud storage. Each file is verified in the bucket before it counts.
 * The video is "saved" only when the MP4 itself is verified.
 */
async function saveToCloud(id, dir) {
  const v = store.getVideo(id) || {};
  const folder = storage.videoFolder(id, v.createdAt);
  writeMetadata(dir, id);
  const items = CLOUD_FILES.concat([{ name: 'metadata.json', type: 'application/json', kind: 'metadata' }])
    .filter((it) => fs.existsSync(path.join(dir, it.name)));
  const files = [];
  const errors = [];
  for (const it of items) {
    try {
      const onProgress = it.kind === 'video'
        ? (f) => patch(id, { progress: 0.94 + 0.05 * f, stage: `Uploading video to cloud (${Math.round(f * 100)}%)` })
        : undefined;
      const r = await storage.putFile(`${folder}/${it.name}`, path.join(dir, it.name), it.type, { onProgress });
      files.push({ kind: it.kind, name: it.name, key: r.key, size: r.size });
    } catch (e) {
      errors.push(`${it.name}: ${scrub(e.message).slice(0, 160)}`);
    }
  }
  const video = files.find((f) => f.kind === 'video');
  // The permanent address is saved only when R2_PUBLIC_URL is set (the bucket's public address).
  const url = video ? storage.permanentUrl(video.key) : null;
  return {
    saved: !!video, bucket: storage.status().bucket, key: video ? video.key : null, url,
    savedAt: new Date().toISOString(), folder, files, errors,
  };
}

async function finish(id, { dir, work, outFile, duration, warnings, hasVoice, format }) {
  // A Short is never accepted outside 45–60 seconds. This uses the finished file's real length.
  if (format === 'shorts') shortLength.checkShortDuration(duration);
  await render.makeThumbnail(outFile, path.join(dir, 'thumb.jpg'), Math.min(1, duration / 2));

  const size = fs.statSync(outFile).size;
  patch(id, { duration, size, warnings, hasVoice, progress: 0.94, stage: 'Saving to cloud' });

  const cloud = storage.isConfigured() ? await saveToCloud(id, dir) : null;
  if (!storage.isConfigured()) {
    warnings.push('Cloud storage is not configured (R2 variables missing). This video is on this server only, NOT in the cloud.');
  } else if (!cloud.saved) {
    warnings.push(`NOT saved to cloud: ${cloud.errors.join('; ')}. This video is on this server only.`);
  } else if (!cloud.url) {
    warnings.push('Saved to cloud, but no permanent link was saved. Set R2_PUBLIC_URL in Railway to the bucket\'s public address.');
  } else if (cloud.errors.length) {
    warnings.push(`Saved to cloud, but some files were not: ${cloud.errors.join('; ')}`);
  }
  // Temporary working files are deleted only after the upload has succeeded (or when there is no upload).
  if (!cloud || cloud.saved) fs.rmSync(work, { recursive: true, force: true });

  // The local file is kept until the owner has reviewed and (optionally) uploaded it.
  patch(id, { cloud, warnings });
  patch(id, { status: 'ready', progress: 1, stage: 'Ready for review' });
}

async function generate(id) {
  const v = store.getVideo(id);
  if (!v) return;
  // Shorts: lengthen or shorten the story text toward 55 seconds of narration before any voice is recorded.
  let fitNote = null;
  if (v.format === 'shorts') {
    const fit = shortLength.fitStory(v.story, v.language);
    if (fit.changed) {
      v.story = fit.story;
      store.saveVideo(v);
      fitNote = `The story was adjusted for length (about ${fit.before} s before, ${fit.after} s estimated now; target ${shortLength.TARGET_SEC} s).`;
    }
  }
  return generateCartoon(id, v, fitNote);
}

/**
 * 2D cartoon mode. Every stage either produces real output or fails the job with the reason.
 */
async function generateCartoon(id, v, fitNote = null) {
  const dir = videoDir(id);
  const work = path.join(dir, 'work');
  ensureDir(work);
  patch(id, { status: 'generating', error: null, progress: 0.02, stage: 'Writing scenes', engine: animation.config().id, mode: MODE });

  const status = animation.current();
  if (!status || !status.ok) throw new Error(`2D cartoon renderer is not available: ${status ? status.reason : 'unknown renderer'}`);

  const warnings = fitNote ? [fitNote] : [];
  const plan = script.planAnimatedScenes({ story: v.story, language: v.language, format: v.format, voiceGender: v.voiceGender });
  if (plan.truncated) warnings.push(`The story is longer than the scene limit, so only the first ${script.LIMITS.maxScenes[v.format]} scenes were animated.`);
  patch(id, {
    scenes: plan.scenes.map((s) => ({ narration: s.utterances.map((u) => u.text).join(' '), visual: s.setting })),
    characters: plan.characters.map((c) => ({ name: c.name, gender: c.gender })),
    progress: 0.05,
  });

  // 1. Voices, one clip per line, with the speaker's gender.
  const provider = providers.pickTtsProvider(v.language);
  if (!provider) warnings.push('No text-to-speech voice is configured, so the animation has no spoken voice. Add a key in Settings and regenerate.');
  patch(id, { stage: 'Recording voices' });
  const lines = plan.scenes.flatMap((s) => s.utterances);
  let n = 0;
  for (const u of lines) {
    const wav = path.join(work, `line_${n}.wav`);
    if (provider) {
      const r = await providers.synthesizeWithFallback({ provider, text: u.text, language: v.language, gender: u.gender });
      noteVoiceFallback(r, warnings);
      const mp3 = path.join(work, `line_${n}.mp3`);
      fs.writeFileSync(mp3, r.audio);
      u.dur = await mediaDuration(mp3);
      await toPaddedWav(mp3, u.dur, wav);
    } else {
      u.dur = Math.max(1.5, (u.text.split(/\s+/).length / (v.language === 'hi' ? 125 : 150)) * 60);
      await toPaddedWav(null, u.dur, wav);
    }
    u.wav = wav;
    n++;
    patch(id, { progress: 0.05 + 0.2 * (n / lines.length) });
  }

  // 2. Timeline and stage specs from the measured durations.
  let built = script.buildSpecs({ scenes: plan.scenes, characters: plan.characters, protagonistId: plan.protagonistId, format: v.format });
  if (v.format === 'shorts') {
    // Speed the voice up or down a little (pitch unchanged, at most 15%) so the total lands near 55 seconds.
    for (let pass = 0; pass < 2; pass++) {
      const total = built.reduce((a, b) => a + b.duration, 0);
      const tempo = shortLength.tempoFor(total);
      if (tempo === 1) break;
      for (let i = 0; i < lines.length; i++) {
        const tuned = path.join(work, `tuned_${pass}_${i}.wav`);
        await shortLength.changeTempo(lines[i].wav, tempo, tuned);
        lines[i].dur = await mediaDuration(tuned);
        lines[i].wav = tuned;
      }
      built = script.buildSpecs({ scenes: plan.scenes, characters: plan.characters, protagonistId: plan.protagonistId, format: v.format });
    }
  }

  // 3. Scene voice tracks (lead-in, lines, gaps, tail), joined into one track.
  patch(id, { stage: 'Mixing voices', progress: 0.27 });
  const sceneVoices = [];
  for (let i = 0; i < built.length; i++) {
    const parts = [];
    let k = 0;
    for (const p of built[i].layout) {
      if (p.file) parts.push(p.file);
      else if (p.silence > 0.0005) {
        const sil = path.join(work, `sil_${i}_${k++}.wav`);
        await toPaddedWav(null, p.silence, sil);
        parts.push(sil);
      }
    }
    const out = path.join(work, `voice_${i}.wav`);
    await concatWav(parts, out);
    sceneVoices.push(out);
  }
  const voiceAll = path.join(work, 'voice_all.wav');
  await concatWav(sceneVoices, voiceAll);
  await keepVoice([voiceAll], dir);

  // 4. Footsteps and jumps from the same timeline that moves the characters, mixed under the voice-over.
  const expectedTotal = built.reduce((a, b) => a + b.duration, 0);
  script.linkTransitions(built); // scene-to-scene dissolves (drawn by the stage; lengths unchanged)
  const sfxFile = path.join(work, 'sfx.wav');
  const sfxCount = sfx.buildSfxTrack(built, expectedTotal, sfxFile);
  const voiceFx = path.join(work, 'voice_fx.wav');
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', voiceAll, '-i', sfxFile,
    '-filter_complex', '[1:a]volume=0.6[s];[0:a][s]amix=inputs=2:duration=first:normalize=0',
    '-ar', '44100', '-ac', '1', voiceFx]);

  // 5. 2D cartoon scenes through the free local renderer.
  const { w, h } = renderSize(v.format);
  const scale = Number(process.env.RENDER_SCALE) || 1;
  const width = Math.round((w * scale) / 2) * 2;
  const height = Math.round((h * scale) / 2) * 2;
  patch(id, { stage: 'Drawing 2D cartoon scenes', progress: 0.3, engine: status.id, soundEffects: sfxCount });
  const clips = await animation.renderScenes(built.map((b) => b.spec), {
    width, height, fps: script.FPS, workDir: work,
    onProgress: (p) => patch(id, { progress: 0.3 + 0.5 * Math.min(1, p) }),
  });
  const got = clips.reduce((a, c) => a + c.duration, 0);
  if (Math.abs(got - expectedTotal) > 0.05) throw new Error(`Animation length mismatch (${got.toFixed(2)}s vs ${expectedTotal.toFixed(2)}s).`);

  // 6. Join clips with voice, effects, subtitles and music.
  patch(id, { stage: 'Editing video', progress: 0.82 });
  const { musicFile, musicKind } = resolveMusic(v, warnings);
  const outFile = path.join(dir, 'video.mp4');
  const scenesMeta = built.map((b) => ({ duration: b.duration, cues: b.cues, narration: b.narration }));
  const { duration } = await render.renderFromClips({
    clips, scenes: scenesMeta, format: v.format, language: v.language, captions: v.captions,
    musicFile, musicKind, voiceFile: voiceFx, outFile, workDir: work,
    onProgress: (p) => patch(id, { progress: 0.82 + 0.1 * p }),
  });

  if (v.format === 'long' && (duration < 60 || duration > 300)) warnings.push(`The long video is ${Math.round(duration)} seconds; long videos are meant to be 1 to 5 minutes.`);
  await finish(id, { dir, work, outFile, duration, warnings, hasVoice: !!provider, format: v.format });
}

function deleteArtifacts(id) {
  const v = store.getVideo(id);
  fs.rmSync(videoDir(id), { recursive: true, force: true });
  if (v && v.cloud) {
    const keys = (v.cloud.files && v.cloud.files.length ? v.cloud.files.map((f) => f.key) : [v.cloud.key]).filter(Boolean);
    for (const k of keys) storage.deleteObject(k).catch(() => {}); // failures are recorded in the storage error log
  }
}

module.exports = { enqueue, videoDir, deleteArtifacts, VIDEOS_DIR, MUSIC_DIR };
