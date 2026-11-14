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

/** Finds the edge-tts executable: an explicit path, or a name looked up on PATH. */
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

/** Returns an mp3 Buffer from edge-tts. Text goes through a file, so long scenes are safe. */
function synthesizeEdge({ text, language, gender }) {
  const voice = (EDGE_VOICES[language] || EDGE_VOICES.en)[gender === 'male' ? 'male' : 'female'];
  const base = path.join(os.tmpdir(), `edge-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const txt = base + '.txt';
  const out = base + '.mp3';
  fs.writeFileSync(txt, text.replace(/\s+/g, ' ').trim());
  return new Promise((resolve, reject) => {
    const child = spawn(findEdgeBin() || EDGE_BIN, ['--voice', voice, '--file', txt, '--write-media', out], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); cleanup(); reject(new Error(`edge-tts could not start: ${scrub(e.message)}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) {
          return reject(new Error(`edge-tts failed (exit ${code}): ${scrub(err).slice(-300)}`));
        }
        resolve(fs.readFileSync(out));
      } finally { cleanup(); }
    });
    function cleanup() { fs.rmSync(txt, { force: true }); fs.rmSync(out, { force: true }); }
  });
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

/** Deterministic fallback: group sentences into scenes of roughly N words. */
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
  // Free local voice first for Hindi, so paid TTS is never needed for narration.
  return ['edge', 'piper', 'elevenlabs', 'openai', 'google'].find((p) => avail[p]) || null;
}

/** Runs Piper offline: text on stdin, WAV bytes out. Male voice is the installed Hindi model. */
function synthesizePiper(text) {
  return new Promise((resolve, reject) => {
    const out = path.join(os.tmpdir(), `piper-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    const child = spawn(PIPER_BIN, ['--model', PIPER_MODEL, '--output_file', out], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(new Error(`Piper could not start: ${scrub(e.message)}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Piper failed (exit ${code}): ${scrub(err).slice(-300)}`));
      try { resolve(fs.readFileSync(out)); } finally { fs.rmSync(out, { force: true }); }
    });
    child.stdin.end(text.replace(/\s+/g, ' ').trim());
  });
}

const GOOGLE_VOICES = {
  en: { female: ['en-US', 'en-US-Neural2-F'], male: ['en-US', 'en-US-Neural2-D'] },
  hi: { female: ['hi-IN', 'hi-IN-Neural2-A'], male: ['hi-IN', 'hi-IN-Neural2-B'] },
};

const FREE_PROVIDERS = ['edge', 'piper'];

/**
 * Synthesises one line with the chosen provider. If it fails (for example OpenAI returns 429
 * insufficient_quota), the line falls back to a free local or Microsoft voice and the caller is told.
 * Returns { audio, provider, fallbackFrom, reason }.
 */
async function synthesizeWithFallback({ provider, text, language, gender }) {
  try {
    return { audio: await synthesize({ provider, text, language, gender }), provider };
  } catch (e) {
    // Any failing voice (paid, or Edge when Microsoft refuses) falls back to a free voice that is available.
    const freeOrder = FREE_PROVIDERS.filter((p) => p !== provider && (p === 'edge' ? edgeStatus().ok && (language === 'hi' || language === 'en') : piperStatus().ok && language === 'hi'));
    if (!freeOrder.length) throw e;
    for (const alt of freeOrder) {
      try {
        const audio = await synthesize({ provider: alt, text, language, gender });
        return { audio, provider: alt, fallbackFrom: provider, reason: scrub(e.message).slice(0, 200) };
      } catch (_) { /* try the next free voice */ }
    }
    throw e;
  }
}

/** Returns an mp3 Buffer. */
async function synthesize({ provider, text, language, gender }) {
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
    return Buffer.from(data.audioContent, 'base64');
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
