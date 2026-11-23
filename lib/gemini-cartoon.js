'use strict';
/**
 * 30-second Gemini Omni video: six scenes of exactly five seconds each.
 *
 * Flow: story -> six narration chunks -> six 5 s Gemini clips -> six 5 s Hindi voice clips (Edge TTS)
 * -> one voice track -> renderFromClips (join, subtitles, music, final MP4) -> caller uploads to R2.
 *
 * Rules enforced here:
 *  - The job is refused unless the owner approved the exact total (JOB_USD) before it starts.
 *  - Each clip is refused by gemini-video.js unless it is approved for its own exact amount (CLIP_USD).
 *  - Any failed clip stops the job with its real error. Nothing is replaced by the old renderer here.
 * Dependencies (voice, clip generation, joining) are passed in, so tests run with fakes and no network.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const script = require('./animation/script');
const gemini = require('./gemini-video');
const characterRefs = require('./character-refs');

const CLIPS = 6;
const CLIP_SEC = 5;
const TOTAL_SEC = CLIPS * CLIP_SEC; // exactly 30 seconds
const CLIP_USD = gemini.estimateCost({ duration: CLIP_SEC, resolution: '720p' }).usd; // 0.35
const JOB_USD = Math.round(CLIPS * CLIP_USD * 100) / 100; // 2.10
const MAX_WORDS_PER_SCENE = 14; // about 5 seconds of Hindi narration at a normal pace
const SHOTS = ['medium', 'tracking', 'medium', 'closeup', 'tracking', 'wide'];

/** Words of the story, with speaker names removed, split evenly into six scenes. Pure. */
function splitIntoScenes(story, language) {
  const words = script.parseBlocks(story).flatMap((b) => b.text.split(/\s+/)).filter(Boolean);
  if (words.length < CLIPS) throw new Error(`The story is too short for a ${TOTAL_SEC} second video (needs at least ${CLIPS} words).`);
  if (words.length > CLIPS * MAX_WORDS_PER_SCENE) {
    throw new Error(`The story is too long for a ${TOTAL_SEC} second video (${words.length} words; the limit is ${CLIPS * MAX_WORDS_PER_SCENE}). Shorten it.`);
  }
  const size = Math.ceil(words.length / CLIPS);
  const scenes = [];
  for (let i = 0; i < CLIPS; i++) {
    const chunk = words.slice(i * size, (i + 1) * size);
    if (chunk.length) scenes.push({ index: i, narration: chunk.join(' '), language });
  }
  if (scenes.length !== CLIPS) throw new Error(`Could not split the story into ${CLIPS} scenes (got ${scenes.length}).`);
  return scenes;
}

/** One line per character, used in every scene prompt so the look stays the same. */
function castFor(story, language, voiceGender) {
  const plan = script.planAnimatedScenes({ story, language, format: 'shorts', voiceGender });
  return plan.characters.map((c) => ({
    name: c.name,
    description: `${c.gender === 'F' ? 'a girl' : 'a boy'} about 10 years old, ${c.shirt} shirt, ${c.pants} trousers, ${c.hair} hair, skin ${c.skin}`,
  }));
}

/** Checks the approval and the total cap before anything is generated. Throws on refusal. */
function assertJobApproved({ approvedUsd }, env = process.env) {
  if (approvedUsd === undefined || Math.abs(Number(approvedUsd) - JOB_USD) > 0.005) {
    throw new gemini.GeminiVideoError('approval_required',
      `Paid video needs your approval of exactly $${JOB_USD.toFixed(2)} (six 5-second clips at $${CLIP_USD.toFixed(2)} each). Approve that amount to continue.`);
  }
  const cap = gemini.totalCapUsd(env);
  if (JOB_USD > cap + 0.00001) {
    throw new gemini.GeminiVideoError('spend_limit', `The job costs $${JOB_USD.toFixed(2)}, above MAX_TOTAL_SPEND_USD ($${cap.toFixed(2)}).`);
  }
}

/** Signature of a clip request: the same prompt and settings always give the same signature. */
function clipSignature({ prompt, aspectRatio, refName }) {
  return crypto.createHash('sha256').update(`${prompt}|${aspectRatio}|${refName || ''}`).digest('hex');
}

/** True when this clip was saved earlier for the same request (a finished file plus its done marker). */
function clipAlreadySaved(file, sig) {
  try {
    const mark = JSON.parse(fs.readFileSync(`${file}.done.json`, 'utf8'));
    return mark.sig === sig && fs.statSync(file).size > 1000;
  } catch (e) {
    return false;
  }
}

/** The first character in the cast that has a saved reference image, or null. */
function firstReference(refDir, cast) {
  for (const c of cast) {
    const r = characterRefs.loadRef(refDir, c.name);
    if (r) return r;
  }
  return null;
}

/**
 * Runs the whole 30-second job. deps: { voiceClip(text, gender, index) -> wav path of exactly 5 s,
 * generateClip(opts, env), concatWav(files, out), renderFromClips(opts) }.
 * Returns { file, duration } where duration is the verified length of the final MP4.
 */
async function runGeminiJob({ story, language = 'hi', format = 'shorts', voiceGender = 'male', approvedUsd, env = process.env,
  work, outFile, captions = true, musicFile = null, musicKind = null, onProgress = () => {}, deps,
  ledgerFile = null, jobKey = null, allowRetryFailed = false, refDir = null, useReferenceImages = false }) {
  assertJobApproved({ approvedUsd }, env);
  const scenes = splitIntoScenes(story, language);
  const cast = castFor(story, language, voiceGender);
  const aspectRatio = format === 'shorts' ? '9:16' : '16:9';
  const gender = voiceGender === 'male' ? 'M' : 'F';
  // One reference image is attached only when the job asks for it (see character-refs.js).
  const ref = useReferenceImages && refDir ? firstReference(refDir, cast) : null;

  const clips = [];
  const wavs = [];
  for (const s of scenes) {
    const i = s.index;
    onProgress(i / CLIPS, `Voice ${i + 1} of ${CLIPS}`);
    const wav = await deps.voiceClip(s.narration, gender, i);
    wavs.push(wav);
    onProgress((i + 0.5) / CLIPS, `Animating scene ${i + 1} of ${CLIPS} with Gemini Omni`);
    const prompt = gemini.buildScenePrompt({ narration: s.narration, characters: cast, shot: SHOTS[i % SHOTS.length] });
    const file = path.join(work, `gemini_clip_${i}.mp4`);
    const sig = clipSignature({ prompt, aspectRatio, refName: ref ? ref.name : null });
    // A clip already saved for this exact prompt is reused: it is never paid for twice.
    if (clipAlreadySaved(file, sig)) {
      clips.push({ file, duration: CLIP_SEC, reused: true });
      continue;
    }
    const opts = { outFile: file, prompt, aspectRatio, resolution: '720p', duration: CLIP_SEC, approvedUsd: CLIP_USD };
    if (ledgerFile) {
      opts.ledgerFile = ledgerFile;
      opts.ledgerKey = `${jobKey || path.basename(outFile)}:clip${i}`;
      opts.allowRetry = allowRetryFailed;
    }
    if (ref) { opts.imageBase64 = ref.base64; opts.imageMime = ref.mime; }
    // Each clip is checked again against its own exact amount and the spending limits.
    const res = await deps.generateClip(opts, env);
    fs.writeFileSync(`${file}.done.json`, JSON.stringify({ sig, key: res && res.ledgerKey ? res.ledgerKey : null }));
    clips.push({ file, duration: CLIP_SEC });
  }

  const voiceAll = path.join(work, 'gemini_voice_all.wav');
  await deps.concatWav(wavs, voiceAll);
  const sceneMeta = scenes.map((s) => ({ duration: CLIP_SEC, cues: [{ start: 0, end: CLIP_SEC, text: s.narration }], narration: s.narration }));
  onProgress(0.9, 'Joining scenes, voice, subtitles and music');
  const { duration } = await deps.renderFromClips({
    clips, scenes: sceneMeta, format, language, captions, musicFile, musicKind,
    voiceFile: voiceAll, outFile, workDir: work,
  });
  if (Math.abs(duration - TOTAL_SEC) > 0.5) throw new Error(`The final video is ${duration.toFixed(2)} s, not ${TOTAL_SEC} s.`);
  return { file: outFile, duration };
}

module.exports = { CLIPS, CLIP_SEC, TOTAL_SEC, CLIP_USD, JOB_USD, splitIntoScenes, castFor, assertJobApproved, runGeminiJob };
