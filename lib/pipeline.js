'use strict';
/**
 * Video generation jobs.
 *  - classic:      story -> scenes -> voice-over -> still images / gradients -> ffmpeg render
 *  - animated-3d:  story -> characters and dialogue -> per-line voices -> real animated 3D clips
 *                  (animation provider) -> voice + subtitles + music -> MP4
 * Both end at "ready" for review. Nothing is uploaded here: upload needs the owner's approval.
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
const { DATA_DIR, FORMATS } = require('./config');
const { ensureDir, run, mediaDuration, scrub } = require('./util');

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
async function finish(id, { dir, work, outFile, duration, warnings, hasVoice }) {
  await render.makeThumbnail(outFile, path.join(dir, 'thumb.jpg'), Math.min(1, duration / 2));
  fs.rmSync(work, { recursive: true, force: true });

  const size = fs.statSync(outFile).size;
  patch(id, { duration, size, warnings, hasVoice, progress: 0.94, stage: 'Saving to cloud' });

  let cloud = null;
  if (storage.isConfigured()) {
    try {
      cloud = await storage.putFile(`${id}.mp4`, outFile);
    } catch (e) {
      warnings.push(`Cloud upload failed: ${scrub(e.message).slice(0, 200)}. The video is kept on this server.`);
    }
  } else warnings.push('Cloud storage is not configured; the video is stored on this server only.');

  // The local file is kept until the owner has reviewed and (optionally) uploaded it.
  patch(id, { cloud, warnings });
  patch(id, { status: 'ready', progress: 1, stage: 'Ready for review' });
}

async function generate(id) {
  const v = store.getVideo(id);
  if (!v) return;
  if (v.mode === 'animated-3d') return generateAnimated(id, v);
  return generateClassic(id, v);
}

async function generateClassic(id, v) {
  const dir = videoDir(id);
  const work = path.join(dir, 'work');
  ensureDir(work);
  patch(id, { status: 'generating', error: null, progress: 0.02, stage: 'Planning scenes' });

  const warnings = [];
  const settings = store.getSettings();

  // 1. scenes
  const plan = await providers.planScenes({ story: v.story, language: v.language, format: v.format });
  if (plan.warning) warnings.push(plan.warning);
  let scenes = plan.scenes;
  if (!scenes.length) throw new Error('The story did not contain any usable text.');
  patch(id, { scenes: scenes.map((s) => ({ narration: s.narration, visual: s.visual })), progress: 0.08, stage: 'Recording voiceover' });

  // 2. voiceover per scene (with silent, reading-speed fallback)
  const provider = providers.pickTtsProvider();
  if (!provider) warnings.push('No text-to-speech key is configured, so this video has captions and music but no spoken voice. Add a key in Settings and regenerate.');
  const wpm = v.language === 'hi' ? 125 : 150;
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const mp3 = path.join(work, `voice_${i}.mp3`);
    let spoken = null;
    if (provider) {
      const audio = await providers.synthesize({ provider, text: sc.narration, language: v.language, gender: v.voiceGender });
      fs.writeFileSync(mp3, audio);
      spoken = await mediaDuration(mp3);
    }
    const words = sc.narration.split(/\s+/).length;
    const base = spoken != null ? spoken : Math.max(2, (words / wpm) * 60);
    sc.duration = Math.max(2, base + 0.4);
    sc.voiceFile = path.join(work, `voice_${i}.wav`);
    await toPaddedWav(spoken != null ? mp3 : null, sc.duration, sc.voiceFile);
    patch(id, { progress: 0.08 + ((i + 1) / scenes.length) * 0.22 });
  }

  // 3. visuals
  const useAi = settings.imageMode === 'ai' && vault.has('OPENAI_API_KEY');
  if (settings.imageMode === 'ai' && !useAi) warnings.push('AI images need an OpenAI key; used gradient backgrounds instead.');
  if (useAi) {
    patch(id, { stage: 'Generating images' });
    for (let i = 0; i < scenes.length; i++) {
      try {
        const img = await providers.generateImage({ prompt: scenes[i].visual, format: v.format });
        const f = path.join(work, `img_${i}.png`);
        fs.writeFileSync(f, img);
        scenes[i].image = f;
      } catch (e) {
        warnings.push(`Image for scene ${i + 1} failed; used a gradient. (${scrub(e.message).slice(0, 120)})`);
      }
      patch(id, { progress: 0.3 + ((i + 1) / scenes.length) * 0.2 });
    }
  }

  if (v.captions && !(await render.fontAvailableFor(v.language))) {
    warnings.push('No Devanagari font was found on this server, so Hindi captions may show as boxes. Install fonts-noto-core or set SUBTITLE_FONT_HI.');
  }

  // 4. music
  const { musicFile, musicKind } = resolveMusic(v, warnings);

  // 5. render
  patch(id, { stage: 'Rendering video', progress: 0.5 });
  const outFile = path.join(dir, 'video.mp4');
  const { duration } = await render.renderVideo({
    scenes, format: v.format, language: v.language, captions: v.captions,
    musicFile, musicKind, outFile, workDir: work,
    onProgress: (p) => patch(id, { progress: 0.5 + p * 0.42 }),
  });

  await finish(id, { dir, work, outFile, duration, warnings, hasVoice: !!provider });
}

/**
 * Animated 3D mode. Every stage either produces real output or fails the job with the reason.
 */
async function generateAnimated(id, v) {
  const dir = videoDir(id);
  const work = path.join(dir, 'work');
  ensureDir(work);
  patch(id, { status: 'generating', error: null, progress: 0.02, stage: 'Writing scenes', engine: animation.config().id });

  const status = animation.current();
  if (!status || !status.ok) throw new Error(`3D animation is not available: ${status ? status.reason : 'unknown provider'}`);

  const warnings = [];
  const plan = script.planAnimatedScenes({ story: v.story, language: v.language, format: v.format, voiceGender: v.voiceGender });
  if (plan.truncated) warnings.push(`The story is longer than the scene limit, so only the first ${script.LIMITS.maxScenes[v.format]} scenes were animated.`);
  patch(id, {
    scenes: plan.scenes.map((s) => ({ narration: s.utterances.map((u) => u.text).join(' '), visual: s.setting })),
    characters: plan.characters.map((c) => ({ name: c.name, gender: c.gender })),
    progress: 0.05,
  });

  // 1. Voices, one clip per line, with the speaker's gender.
  const provider = providers.pickTtsProvider();
  if (!provider) warnings.push('No text-to-speech key is configured, so the animation has no spoken voice. Add a key in Settings and regenerate.');
  patch(id, { stage: 'Recording voices' });
  const lines = plan.scenes.flatMap((s) => s.utterances);
  let n = 0;
  for (const u of lines) {
    const wav = path.join(work, `line_${n}.wav`);
    if (provider) {
      const audio = await providers.synthesize({ provider, text: u.text, language: v.language, gender: u.gender });
      const mp3 = path.join(work, `line_${n}.mp3`);
      fs.writeFileSync(mp3, audio);
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
  const built = script.buildSpecs({ scenes: plan.scenes, characters: plan.characters, protagonistId: plan.protagonistId, format: v.format });

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

  // 4. Real 3D animation through the selected provider.
  const { w, h } = FORMATS[v.format];
  const scale = Number(process.env.RENDER_3D_SCALE) || 1;
  const width = Math.round((w * scale) / 2) * 2;
  const height = Math.round((h * scale) / 2) * 2;
  patch(id, { stage: 'Animating characters', progress: 0.3, engine: status.id });
  const clips = await animation.renderScenes(built.map((b) => b.spec), {
    width, height, fps: script.FPS, workDir: work,
    onProgress: (p) => patch(id, { progress: 0.3 + 0.5 * Math.min(1, p) }),
  });
  const expected = built.reduce((a, b) => a + b.duration, 0);
  const got = clips.reduce((a, c) => a + c.duration, 0);
  if (Math.abs(got - expected) > 0.05) throw new Error(`Animation length mismatch (${got.toFixed(2)}s vs ${expected.toFixed(2)}s).`);

  // 5. Join clips with voice, subtitles and music.
  patch(id, { stage: 'Editing video', progress: 0.82 });
  const { musicFile, musicKind } = resolveMusic(v, warnings);
  const outFile = path.join(dir, 'video.mp4');
  const scenesMeta = built.map((b) => ({ duration: b.duration, cues: b.cues, narration: b.narration }));
  const { duration } = await render.renderFromClips({
    clips, scenes: scenesMeta, format: v.format, language: v.language, captions: v.captions,
    musicFile, musicKind, voiceFile: voiceAll, outFile, workDir: work,
    onProgress: (p) => patch(id, { progress: 0.82 + 0.1 * p }),
  });

  await finish(id, { dir, work, outFile, duration, warnings, hasVoice: !!provider });
}

function deleteArtifacts(id) {
  const v = store.getVideo(id);
  fs.rmSync(videoDir(id), { recursive: true, force: true });
  if (v && v.cloud) storage.deleteObject(v.cloud.key).catch(() => {});
}

module.exports = { enqueue, videoDir, deleteArtifacts, VIDEOS_DIR, MUSIC_DIR };
