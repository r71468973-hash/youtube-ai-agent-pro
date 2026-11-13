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
  const characters = plan.characters || '';
  patch(id, { scenes: scenes.map((s) => ({ narration: s.narration, visual: s.visual })), planner: plan.method, progress: 0.08, stage: 'Recording voiceover' });

  // 2. voiceover per scene. Providers are tried in turn; one with a bad account (no credits, rate limit) is
  // dropped for the rest of this video instead of failing it. If all fail the scene falls back to silence.
  let providerList = providers.ttsProviders();
  const spokenBy = new Set();
  if (!providerList.length) warnings.push('No text-to-speech key is configured, so this video has captions and music but no spoken voice. Add a Gemini, OpenAI or ElevenLabs key in Settings and regenerate.');
  const wpm = v.language === 'hi' ? 125 : 150;
  const ttsErrors = [];
  const audioDir = path.join(dir, 'assets');
  ensureDir(audioDir);
  let silentScenes = 0;
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    let src = null;
    let spoken = null;
    while (providerList.length && !src) {
      const provider = providerList[0];
      try {
        const { data, ext } = await providers.synthesize({ provider, text: sc.narration, language: v.language, gender: v.voiceGender });
        src = path.join(audioDir, `voice_${i}.${ext}`);
        fs.writeFileSync(src, data);
        spoken = await mediaDuration(src);
        spokenBy.add(provider);
      } catch (e) {
        src = null;
        ttsErrors.push(`${provider}: ${scrub(e.message).replace(/\s+/g, ' ').slice(0, 140)}`);
        providerList = providerList.slice(1);
      }
    }
    if (!src) silentScenes++;
    const words = sc.narration.split(/\s+/).length;
    const base = spoken != null ? spoken : Math.max(2, (words / wpm) * 60);
    sc.duration = Math.max(2, base + 0.4);
    sc.voiceFile = path.join(work, `voice_${i}.wav`);
    await toPaddedWav(src, sc.duration, sc.voiceFile);
    patch(id, { progress: 0.08 + ((i + 1) / scenes.length) * 0.22 });
  }
  if (ttsErrors.length) warnings.push(`Voiceover provider problem: ${[...new Set(ttsErrors)].join(' | ')}.`);
  if (silentScenes && spokenBy.size) warnings.push(`${silentScenes} scene(s) have no voice because every voice provider failed for them.`);
  if (silentScenes && !spokenBy.size && providers.ttsProviders().length) warnings.push('This video has no voiceover: every configured voice provider failed (see above).');
  const provider = spokenBy.size ? [...spokenBy][0] : null;

  // 3. visuals: 3D cartoon scene images (Gemini or OpenAI), animated with camera moves at render time
  const imgProvider = providers.imageProvider();
  const useAi = settings.imageMode === 'ai' && !!imgProvider;
  if (settings.imageMode === 'ai' && !useAi) warnings.push('AI scene images need a Gemini or OpenAI key; used gradient backgrounds instead.');
  const imageDir = path.join(dir, 'assets');
  if (useAi) {
    patch(id, { stage: 'Generating 3D cartoon scenes' });
    let imgFailures = 0;
    for (let i = 0; i < scenes.length; i++) {
      try {
        const img = await providers.generateImage({ prompt: scenes[i].visual, format: v.format, characters, provider: imgProvider });
        const f = path.join(imageDir, `scene_${i}.png`);
        fs.writeFileSync(f, img);
        scenes[i].image = f;
      } catch (e) {
        imgFailures++;
        if (imgFailures <= 2) warnings.push(`Image for scene ${i + 1} failed; used a gradient. (${scrub(e.message).slice(0, 160)})`);
      }
      patch(id, { progress: 0.3 + ((i + 1) / scenes.length) * 0.2 });
    }
    if (imgFailures > 2) warnings.push(`${imgFailures} of ${scenes.length} scene images failed in total.`);
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
  if (spokenBy.size) {
    try { await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(work, 'voice.wav'), '-b:a', '128k', path.join(dir, 'voiceover.mp3')]); } catch { /* optional asset */ }
  }
  fs.rmSync(work, { recursive: true, force: true });

  const size = fs.statSync(outFile).size;
  patch(id, { duration, size, warnings, hasVoice: !!provider, progress: 0.94, stage: 'Saving to cloud' });

  // 6. cloud copy: video, voiceover audio, scene images and thumbnail. Local files are always kept as the fallback.
  let cloud = null;
  if (storage.isConfigured()) {
    try {
      cloud = await storage.putFile(`${id}/video.mp4`, outFile);
      cloud.assets = [];
      const extras = [[`${id}/thumb.jpg`, path.join(dir, 'thumb.jpg'), 'image/jpeg'], [`${id}/voiceover.mp3`, path.join(dir, 'voiceover.mp3'), 'audio/mpeg']];
      for (let i = 0; i < scenes.length; i++) if (scenes[i].image) extras.push([`${id}/images/scene_${i}.png`, scenes[i].image, 'image/png']);
      for (const [name, file, type] of extras) {
        if (!fs.existsSync(file)) continue;
        try { cloud.assets.push((await storage.putFile(name, file, type)).key); } catch (e) { warnings.push(`Cloud upload of ${path.basename(name)} failed: ${scrub(e.message).slice(0, 120)}`); break; }
      }
    } catch (e) {
      cloud = null;
      warnings.push(`Cloud upload failed: ${scrub(e.message).slice(0, 200)}. The video is kept on this server.`);
    }
  } else warnings.push('Cloud storage is not configured; files are stored on this server only.');

  patch(id, { cloud, warnings });
  patch(id, { status: 'ready', progress: 1, stage: 'Ready for review' });
}

function deleteArtifacts(id) {
  const v = store.getVideo(id);
  fs.rmSync(videoDir(id), { recursive: true, force: true });
  if (v && v.cloud) for (const k of [v.cloud.key, ...(v.cloud.assets || [])]) storage.deleteObject(k).catch(() => {});
}

module.exports = { enqueue, videoDir, deleteArtifacts, VIDEOS_DIR, MUSIC_DIR };
