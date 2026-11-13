'use strict';
/** Video job: story -> scenes -> voiceover -> animation/images -> edit+render -> thumbnail -> cloud copy. */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const storage = require('./storage');
const providers = require('./providers');
const render = require('./render');
const stories = require('./stories');
const vault = require('./vault');
const { DATA_DIR } = require('./config');
const { ensureDir, run, mediaDuration, scrub } = require('./util');

const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const MUSIC_DIR = path.join(DATA_DIR, 'music');
const videoDir = (id) => path.join(VIDEOS_DIR, id);

// One render at a time: ffmpeg and the animator are CPU heavy.
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

/** Try each candidate engine on the first line; the first that works is used for the whole video. */
async function chooseVoice(candidates, firstText, language, gender, warnings, work) {
  for (const provider of candidates) {
    try {
      const probe = await providers.synthesize({ provider, text: firstText, language, gender });
      const f = path.join(work, `probe.${probe.ext}`);
      fs.writeFileSync(f, probe.data);
      await mediaDuration(f);
      return provider;
    } catch (e) {
      warnings.push(`Voice engine "${provider}" failed and was skipped: ${scrub(e.message).slice(0, 220)}`);
    }
  }
  return null;
}

async function generate(id) {
  const v = store.getVideo(id);
  if (!v) return;
  const dir = videoDir(id);
  const work = path.join(dir, 'work');
  fs.rmSync(work, { recursive: true, force: true });
  ensureDir(work);
  patch(id, { status: 'generating', error: null, progress: 0.02, stage: 'Planning scenes' });

  const warnings = [];
  const settings = store.getSettings();
  const language = v.language;

  // 1. scenes: built-in animated story template, or planned from the story text
  let scenes;
  if (v.template) {
    scenes = stories.buildScenes(v.template);
    if (!scenes) throw new Error(`Unknown story template "${v.template}".`);
    const problem = await render.animatorProblem();
    if (problem) throw new Error(problem);
  } else {
    const plan = await providers.planScenes({ story: v.story, language, format: v.format });
    if (plan.warning) warnings.push(plan.warning);
    scenes = plan.scenes;
  }
  if (!scenes.length) throw new Error('The story did not contain any usable text.');
  patch(id, { scenes: scenes.map((s) => ({ narration: s.narration || (s.card ? s.card.title : ''), visual: s.visual || '' })), progress: 0.06, stage: 'Preparing voice engine' });

  // 2. voiceover
  const spoken = scenes.filter((s) => s.narration);
  const candidates = providers.ttsCandidates(language);
  let provider = null;
  if (candidates.length) {
    provider = await chooseVoice(candidates, spoken[0].narration, language, v.voiceGender, warnings, work);
  }
  if (!provider) {
    const ps = providers.piperStatus(language);
    warnings.push(
      candidates.length
        ? 'No working voice engine, so this video has no spoken voice.'
        : `No voice engine is available, so this video has captions and music but NO spoken voice. Free option: Piper is ${ps.available ? 'ready' : 'not installed on this server'}${ps.available ? '' : ` (binary ${ps.binOk ? 'found' : 'missing'}, voice model ${ps.modelOk ? 'found' : 'missing'})`}.`
    );
  } else if (provider === 'piper') {
    warnings.push('Voice: Piper (free, local). Piper has no emotion control, so tone stays calm and even.');
  }
  const wpm = language === 'hi' ? 150 : 160;
  let n = 0;
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    sc.voiceFile = path.join(work, `voice_${i}.wav`);
    if (sc.silent || !sc.narration) {
      sc.duration = sc.duration || 3;
      await toPaddedWav(null, sc.duration, sc.voiceFile);
      continue;
    }
    n++;
    patch(id, { stage: `Recording voice ${n} of ${spoken.length}` });
    let spokenSec = null;
    let src = null;
    if (provider) {
      const a = await providers.synthesize({ provider, text: sc.narration, language, gender: v.voiceGender });
      src = path.join(work, `voice_${i}.${a.ext}`);
      fs.writeFileSync(src, a.data);
      spokenSec = await mediaDuration(src);
    }
    const words = sc.narration.split(/\s+/).length;
    const base = spokenSec != null ? spokenSec : Math.max(2, (words / wpm) * 60);
    sc.duration = Math.max(2.5, base + 0.4);
    await toPaddedWav(src, sc.duration, sc.voiceFile);
    patch(id, { progress: 0.06 + (n / spoken.length) * 0.2 });
  }

  // 3. visuals
  let visuals = 'gradient backgrounds';
  if (v.template) visuals = 'animated cartoon scenes (procedural 2.5D, not AI-generated)';
  else if (settings.imageMode === 'ai' && vault.has('OPENAI_API_KEY')) {
    visuals = 'AI images (OpenAI)';
    for (let i = 0; i < scenes.length; i++) {
      patch(id, { stage: `Generating image ${i + 1} of ${scenes.length}`, progress: 0.26 + (i / scenes.length) * 0.2 });
      try {
        const img = await providers.generateImage({ prompt: scenes[i].visual, format: v.format });
        const f = path.join(work, `img_${i}.png`);
        fs.writeFileSync(f, img);
        scenes[i].image = f;
      } catch (e) {
        warnings.push(`Image for scene ${i + 1} failed; used a gradient. (${scrub(e.message).slice(0, 120)})`);
      }
    }
  } else if (settings.imageMode === 'ai') warnings.push('AI images need an OpenAI key; used gradient backgrounds instead.');

  if (v.captions && !(await render.fontAvailableFor(language))) {
    warnings.push('No Devanagari font was found on this server, so Hindi text may show as boxes. Install fonts-noto-core or set SUBTITLE_FONT_HI.');
  }

  // 4. music
  let musicFile = null;
  let musicKind = null;
  if (v.music && v.music !== 'none') {
    if (v.music.startsWith('upload:')) {
      const m = store.getMusic(v.music.slice(7));
      if (m && fs.existsSync(m.file)) musicFile = m.file;
      else warnings.push('The selected music track is missing; rendered without music.');
    } else musicKind = v.music;
  }

  // 5. animate + edit + render
  patch(id, { stage: 'Rendering', progress: 0.3 });
  const outFile = path.join(dir, 'video.mp4');
  const { duration } = await render.renderVideo({
    scenes, format: v.format, language, captions: v.captions,
    musicFile, musicKind, outFile, workDir: work,
    onProgress: (p) => patch(id, { progress: 0.3 + p * 0.62 }),
    onStage: (stage) => patch(id, { stage }),
  });
  await render.makeThumbnail(outFile, path.join(dir, 'thumb.jpg'), v.template ? 1.3 : Math.min(1, duration / 2), v.format);
  fs.rmSync(work, { recursive: true, force: true });

  const size = fs.statSync(outFile).size;
  patch(id, { duration, size, warnings, hasVoice: !!provider, voiceEngine: provider, visuals, progress: 0.94, stage: 'Saving to cloud' });

  // 6. cloud copy
  let cloud = null;
  if (storage.isConfigured()) {
    try {
      cloud = await storage.putFile(`${id}.mp4`, outFile);
    } catch (e) {
      warnings.push(`Cloud upload failed: ${scrub(e.message).slice(0, 200)}. The video is kept on this server.`);
    }
  } else warnings.push('Cloud storage is not configured; the video is stored on this server only.');

  patch(id, { cloud, warnings, status: 'ready', progress: 1, stage: 'Ready for review' });
}

function deleteArtifacts(id) {
  const v = store.getVideo(id);
  fs.rmSync(videoDir(id), { recursive: true, force: true });
  if (v && v.cloud) storage.deleteObject(v.cloud.key).catch(() => {});
}

module.exports = { enqueue, videoDir, deleteArtifacts, VIDEOS_DIR, MUSIC_DIR };
