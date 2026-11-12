'use strict';
/** Video generation job: story -> scenes -> voiceover -> images -> render -> thumbnail -> cloud copy. */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const storage = require('./storage');
const providers = require('./providers');
const render = require('./render');
const vault = require('./vault');
const { DATA_DIR, FORMATS } = require('./config');
const { ensureDir, run, mediaDuration, scrub } = require('./util');

const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const MUSIC_DIR = path.join(DATA_DIR, 'music');
const videoDir = (id) => path.join(VIDEOS_DIR, id);

// One render at a time: ffmpeg is CPU heavy.
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

async function generate(id) {
  const v = store.getVideo(id);
  if (!v) return;
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
  const cartoon = settings.imageMode === 'cartoon';
  const useAi = (cartoon || settings.imageMode === 'ai') && vault.has('OPENAI_API_KEY');
  if (cartoon && !useAi) throw new Error('3D cartoon mode needs an OpenAI API key (image generation). Add OPENAI_API_KEY in Settings > API keys, or switch Scene visuals to gradients.');
  if (settings.imageMode === 'ai' && !useAi) warnings.push('AI images need an OpenAI key; used gradient backgrounds instead.');
  if (useAi) {
    patch(id, { stage: cartoon ? 'Drawing cartoon scenes' : 'Generating images' });
    for (let i = 0; i < scenes.length; i++) {
      try {
        const img = await providers.generateImage({ prompt: scenes[i].visual, format: v.format, cartoon });
        const f = path.join(work, `img_${i}.png`);
        fs.writeFileSync(f, img);
        scenes[i].image = f;
      } catch (e) {
        // Cartoon mode never substitutes a placeholder: a failed scene fails the job.
        if (cartoon) throw new Error(`Image for scene ${i + 1} failed: ${scrub(e.message).slice(0, 200)}`);
        warnings.push(`Image for scene ${i + 1} failed; used a gradient. (${scrub(e.message).slice(0, 120)})`);
      }
      patch(id, { progress: 0.3 + ((i + 1) / scenes.length) * 0.2 });
    }
  }

  if (v.captions && !(await render.fontAvailableFor(v.language))) {
    warnings.push('No Devanagari font was found on this server, so Hindi captions may show as boxes. Install fonts-noto-core or set SUBTITLE_FONT_HI.');
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

  // 5. render
  patch(id, { stage: 'Rendering video', progress: 0.5 });
  const outFile = path.join(dir, 'video.mp4');
  const { duration } = await render.renderVideo({
    scenes, format: v.format, language: v.language, captions: v.captions,
    musicFile, musicKind, outFile, workDir: work,
    onProgress: (p) => patch(id, { progress: 0.5 + p * 0.42 }),
  });
  await render.makeThumbnail(outFile, path.join(dir, 'thumb.jpg'), Math.min(1, duration / 2));
  fs.rmSync(work, { recursive: true, force: true });

  const size = fs.statSync(outFile).size;
  patch(id, { duration, size, warnings, hasVoice: !!provider, progress: 0.94, stage: 'Saving to cloud' });

  // 6. cloud copy
  let cloud = null;
  if (storage.isConfigured()) {
    try {
      cloud = await storage.putFile(`${id}.mp4`, outFile);
    } catch (e) {
      warnings.push(`Cloud upload failed: ${scrub(e.message).slice(0, 200)}. The video is kept on this server.`);
    }
  } else warnings.push('Cloud storage is not configured; the video is stored on this server only.');

  if (cloud && settings.keepLocalCopy === false) {
    // Keep local until the user has approved/uploaded; only drop local if explicitly disabled.
    patch(id, { cloud, warnings });
  } else patch(id, { cloud, warnings });

  patch(id, { status: 'ready', progress: 1, stage: 'Ready for review' });
}

function deleteArtifacts(id) {
  const v = store.getVideo(id);
  fs.rmSync(videoDir(id), { recursive: true, force: true });
  if (v && v.cloud) storage.deleteObject(v.cloud.key).catch(() => {});
}

module.exports = { enqueue, videoDir, deleteArtifacts, VIDEOS_DIR, MUSIC_DIR };
