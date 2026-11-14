'use strict';
/** External AI providers: scene planning (Anthropic), text-to-speech, optional AI images. */
const vault = require('./vault');
const store = require('./store');
const { LIMITS } = require('./config');
const { scrub } = require('./util');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

/** Free, offline Piper voice. Used for Hindi when a model file is installed (see Dockerfile). */
const PIPER_BIN = process.env.PIPER_BIN || 'piper';
const PIPER_MODEL = process.env.PIPER_MODEL || '/opt/piper/hi_IN-pratham-medium.onnx';

function piperStatus() {
  if (!fs.existsSync(PIPER_MODEL)) return { ok: false, reason: `Free Hindi voice model not found at ${PIPER_MODEL}.` };
  const bin = PIPER_BIN.includes('/') ? PIPER_BIN : null;
  if (bin && !fs.existsSync(bin)) return { ok: false, reason: `Piper binary not found at ${bin}.` };
  return { ok: true, reason: 'Free local Hindi voice (Piper) is available.' };
}

/* Free Microsoft Edge neural voices via the edge-tts CLI (no key, no credits). Needs outbound internet. */
const EDGE_BIN = process.env.EDGE_TTS_BIN || 'edge-tts';
const EDGE_VOICES = {
  hi: { male: 'hi-IN-MadhurNeural', female: 'hi-IN-SwaraNeural' },
  en: { male: 'en-US-GuyNeural', female: 'en-US-JennyNeural' },
};

function findEdgeBin() {
  if (EDGE_BIN.includes('/')) return fs.existsSync(EDGE_BIN) ? EDGE_BIN : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, EDGE_BIN);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch (_) { /* keep looking */ }
  }
  return null;
}

function edgeStatus() {
  if (!findEdgeBin()) return { ok: false, reason: `edge-tts is not installed (${EDGE_BIN} not found on PATH).` };
  return { ok: true, reason: 'Free Microsoft Edge neural voices (no key). Needs the server to reach Microsoft.' };
}

const positiveEnvInt = (name, fallback, max) => {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rejects empty, corrupt, or non-decodable audio before any caller can save/use it. */
async function validateAudio(audio, label = 'TTS') {
  if (!Buffer.isBuffer(audio) || audio.length < 128) throw new Error(`${label} returned empty or incomplete audio.`);
  const file = path.join(os.tmpdir(), `tts-check-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.audio`);
  fs.writeFileSync(file, audio, { flag: 'wx', mode: 0o600 });
  try {
    const duration = await new Promise((resolve, reject) => {
      const child = spawn(process.env.FFPROBE_BIN || 'ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10000);
      child.stdout.on('data', (d) => { if (stdout.length < 1024) stdout += d.toString(); });
      child.stderr.on('data', (d) => { if (stderr.length < 2048) stderr += d.toString(); });
      child.on('error', (e) => { clearTimeout(timer); reject(new Error(`${label} audio validation could not start ffprobe: ${scrub(e.message)}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new Error(`${label} audio validation timed out.`));
        const seconds = Number.parseFloat(stdout.trim());
        if (code !== 0 || !Number.isFinite(seconds) || seconds <= 0) {
          return reject(new Error(`${label} returned invalid audio${stderr ? `: ${scrub(stderr).slice(-200)}` : '.'}`));
        }
        resolve(seconds);
      });
    });
    return duration;
  } finally { fs.rmSync(file, { force: true }); }
}

/** Edge-TTS is retried up to three times after the first attempt; each attempt has a hard timeout. */
async function synthesizeEdge({ text, language, gender }) {
  const voice = (EDGE_VOICES[language] || EDGE_VOICES.en)[gender === 'male' ? 'male' : 'female'];
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleanText) throw new Error('Edge-TTS cannot synthesize empty text.');
  const retries = positiveEnvInt('EDGE_TTS_RETRIES', 3, 10);
  const timeoutMs = positiveEnvInt('EDGE_TTS_TIMEOUT_MS', 60000, 180000);
  const retryDelay = positiveEnvInt('EDGE_TTS_RETRY_DELAY_MS', 500, 10000);
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const base = path.join(os.tmpdir(), `edge-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const txt = `${base}.txt`;
    const out = `${base}.mp3`;
    fs.writeFileSync(txt, cleanText, { mode: 0o600 });
    try {
      const audio = await new Promise((resolve, reject) => {
        const bin = findEdgeBin() || EDGE_BIN;
        const child = spawn(bin, ['--voice', voice, '--file', txt, '--write-media', out], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        child.stderr.on('data', (d) => { if (err.length < 8192) err += d.toString(); });
        child.on('error', (e) => { clearTimeout(timer); reject(new Error(`edge-tts could not start: ${scrub(e.message)}`)); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (timedOut) return reject(new Error(`edge-tts timed out after ${timeoutMs}ms.`));
          if (code !== 0) return reject(new Error(`edge-tts failed (exit ${code}): ${scrub(err).slice(-300) || 'No audio received.'}`));
          try {
            if (!fs.existsSync(out) || fs.statSync(out).size < 128) return reject(new Error('edge-tts returned an empty or incomplete MP3.'));
            resolve(fs.readFileSync(out));
          } catch (e) { reject(e); }
        });
      });
      await validateAudio(audio, `Edge-TTS (${voice})`);
      return audio;
    } catch (e) {
      lastError = e;
      if (attempt < retries) await sleep(retryDelay * (attempt + 1));
    } finally {
      fs.rmSync(txt, { force: true });
      fs.rmSync(out, { force: true });
    }
  }
  throw new Error(`Edge-TTS failed after ${retries + 1} attempts: ${scrub(lastError && lastError.message)}`);
}

/** True for quota, credit or rate-limit failures from a paid provider. */
function isQuotaError(e) {
  return /HTTP (402|429)|insufficient_quota|quota|credit/i.test(String(e && e.message));
}

async function request(url, init, label) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(120000) });
  } catch (e) {
    throw new Error(`${label}: network error (${scrub(e.message)})`);
  }
  if (!res.ok) {
    const body = scrub(await res.text().catch(() => ''));
    throw new Error(`${label}: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return res;
}

/* ---------------------------------------------------------------- scenes */

function splitSentences(text) {
  return text
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .flatMap((para) => para.replace(/\s+/g, ' ').trim().split(/(?<=[.!?।॥…])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function ruleBasedScenes(story, format) {
  const target = LIMITS.maxSceneWords[format];
  const scenes = [];
  let cur = [];
  let words = 0;
  for (const s of splitSentences(story)) {
    const n = s.split(/\s+/).length;
    if (cur.length && words + n > target) {
      scenes.push(cur.join(' '));
      cur = [];
      words = 0;
    }
    cur.push(s);
    words += n;
  }
  if (cur.length) scenes.push(cur.join(' '));
  return scenes.slice(0, LIMITS.maxScenes[format]).map((narration) => ({ narration, visual: narration.slice(0, 200) }));
}

async function planScenes({ story, language, format }) {
  const apiKey = vault.get('ANTHROPIC_API_KEY');
  if (!apiKey) return { scenes: ruleBasedScenes(story, format), method: 'rule-based' };

  const maxScenes = LIMITS.maxScenes[format];
  const maxWords = LIMITS.maxSceneWords[format];
  const langName = language === 'hi' ? 'Hindi (Devanagari script)' : 'English';
  const system =
    'You turn a story into a scene list for a narrated video. Reply with ONLY a JSON array, no prose. ' +
    `Each item: {"narration": string, "visual": string}. "narration" is the voiceover in ${langName}, ` +
    `at most ${maxWords} words, preserving the story's meaning and order. "visual" is a short English description of ` +
    `an image that fits the scene (no text in the image). Use at most ${maxScenes} scenes.`;
  try {
    const res = await request(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
          max_tokens: 4000,
          system,
          messages: [{ role: 'user', content: story }],
        }),
      },
      'Scene planner'
    );
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || '').join('');
    const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    const scenes = arr
      .filter((s) => s && typeof s.narration === 'string' && s.narration.trim())
      .slice(0, maxScenes)
      .map((s) => ({ narration: s.narration.trim(), visual: String(s.visual || s.narration).slice(0, 300) }));
    if (!scenes.length) throw new Error('empty plan');
    return { scenes, method: 'ai' };
  } catch (e) {
    return { scenes: ruleBasedScenes(story, format), method: 'rule-based', warning: `AI scene planning failed (${scrub(e.message)}); used simple splitting.` };
  }
}

/* ------------------------------------------------------------------- TTS */

function pickTtsProvider(language) {
  const pref = store.getSettings().ttsProvider;
  if (pref === 'none') return null;
  const avail = {
    edge: (language === 'hi' || language === 'en') && edgeStatus().ok,
    piper: language === 'hi' && piperStatus().ok,
    openai: vault.has('OPENAI_API_KEY'),
    elevenlabs: vault.has('ELEVENLABS_API_KEY'),
    google: vault.has('GOOGLE_TTS_API_KEY'),
  };
  if (pref !== 'auto') return avail[pref] ? pref : null;
  return ['edge', 'piper', 'elevenlabs', 'openai', 'google'].find((p) => avail[p]) || null;
}

/** Runs Piper offline with a hard timeout; its WAV output is validated by synthesize(). */
function synthesizePiper(text) {
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleanText) return Promise.reject(new Error('Piper cannot synthesize empty text.'));
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `piper-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    const child = spawn(PIPER_BIN, ['--model', PIPER_MODEL, '--output_file', out], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, positiveEnvInt('PIPER_TIMEOUT_MS', 60000, 180000));
    child.stderr.on('data', (d) => { if (err.length < 8192) err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); fs.rmSync(out, { force: true }); reject(new Error(`Piper could not start: ${scrub(e.message)}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (timedOut) return reject(new Error('Piper timed out.'));
        if (code !== 0) return reject(new Error(`Piper failed (exit ${code}): ${scrub(err).slice(-300)}`));
        if (!fs.existsSync(out) || fs.statSync(out).size < 128) return reject(new Error('Piper returned empty or incomplete audio.'));
        resolve(fs.readFileSync(out));
      } catch (e) { reject(e); }
      finally { fs.rmSync(out, { force: true }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(cleanText);
  });
}

const GOOGLE_VOICES = {
  en: { female: ['en-US', 'en-US-Neural2-F'], male: ['en-US', 'en-US-Neural2-D'] },
  hi: { female: ['hi-IN', 'hi-IN-Neural2-A'], male: ['hi-IN', 'hi-IN-Neural2-B'] },
};
const FREE_PROVIDERS = ['edge', 'piper'];

async function synthesizeWithFallback({ provider, text, language, gender }) {
  try {
    return { audio: await synthesize({ provider, text, language, gender }), provider };
  } catch (e) {
    const freeOrder = FREE_PROVIDERS.filter((p) => p !== provider && (p === 'edge' ? edgeStatus().ok && (language === 'hi' || language === 'en') : piperStatus().ok && language === 'hi'));
    if (!freeOrder.length) throw e;
    const failures = [`${provider}: ${scrub(e.message)}`];
    for (const alt of freeOrder) {
      try {
        const audio = await synthesize({ provider: alt, text, language, gender });
        return { audio, provider: alt, fallbackFrom: provider, reason: scrub(e.message).slice(0, 200) };
      } catch (altErr) {
        // Keep every engine's error so the job's failure message names the real cause.
        failures.push(`${alt}: ${scrub(altErr.message)}`);
      }
    }
    throw new Error(`No voice could be generated (${failures.join(' | ')})`);
  }
}

/** Public synthesis validates every provider's bytes before returning audio. */
async function synthesize({ provider, text, language, gender }) {
  const audio = await synthesizeRaw({ provider, text, language, gender });
  await validateAudio(audio, `${provider} TTS`);
  return audio;
}

async function synthesizeRaw({ provider, text, language, gender }) {
  const s = store.getSettings();
  if (provider === 'edge') return synthesizeEdge({ text, language, gender });
  if (provider === 'piper') return synthesizePiper(text);
  if (provider === 'openai') {
    const res = await request(
      'https://api.openai.com/v1/audio/speech',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${vault.get('OPENAI_API_KEY')}` },
        body: JSON.stringify({
          model: s.openaiTtsModel,
          voice: gender === 'male' ? 'onyx' : 'nova',
          input: text,
          response_format: 'mp3',
          instructions: language === 'hi' ? 'Speak natural, clear Hindi with a warm storytelling tone.' : 'Speak with a warm storytelling tone.',
        }),
      },
      'OpenAI TTS'
    );
    return Buffer.from(await res.arrayBuffer());
  }
  if (provider === 'elevenlabs') {
    const voice = gender === 'male' ? s.elevenVoiceMale : s.elevenVoiceFemale;
    const res = await request(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'xi-api-key': vault.get('ELEVENLABS_API_KEY') },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
      },
      'ElevenLabs TTS'
    );
    return Buffer.from(await res.arrayBuffer());
  }
  if (provider === 'google') {
    const [languageCode, name] = GOOGLE_VOICES[language][gender === 'male' ? 'male' : 'female'];
    const res = await request(
      'https://texttospeech.googleapis.com/v1/text:synthesize',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': vault.get('GOOGLE_TTS_API_KEY') },
        body: JSON.stringify({ input: { text }, voice: { languageCode, name }, audioConfig: { audioEncoding: 'MP3' } }),
      },
      'Google TTS'
    );
    const data = await res.json();
    return Buffer.from(data.audioContent || '', 'base64');
  }
  throw new Error('No TTS provider');
}

/* ---------------------------------------------------------------- images */

async function generateImage({ prompt, format }) {
  const res = await request(
    'https://api.openai.com/v1/images/generations',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${vault.get('OPENAI_API_KEY')}` },
      body: JSON.stringify({
        model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
        prompt: `${prompt}. Cinematic illustration, no text or letters in the image.`,
        size: format === 'shorts' ? '1024x1536' : '1536x1024',
        n: 1,
      }),
    },
    'Image generation'
  );
  const data = await res.json();
  const b64 = data.data && data.data[0] && data.data[0].b64_json;
  if (!b64) throw new Error('Image generation returned no image');
  return Buffer.from(b64, 'base64');
}

module.exports = { planScenes, ruleBasedScenes, pickTtsProvider, synthesize, synthesizeWithFallback, isQuotaError, generateImage, splitSentences, piperStatus, edgeStatus };
