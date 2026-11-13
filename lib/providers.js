'use strict';
/** External AI providers: scene planning (Anthropic), text-to-speech, optional AI images. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const vault = require('./vault');
const store = require('./store');
const { LIMITS } = require('./config');
const { scrub, newId } = require('./util');

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

/* Piper: free, open-source, runs locally on the server (no API, no credits). */
function onPath(bin) {
  if (bin.includes('/')) return fs.existsSync(bin);
  return (process.env.PATH || '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));
}
function piperModel(language, gender) {
  if (language === 'hi') return (gender === 'female' && process.env.PIPER_MODEL_HI_FEMALE) || process.env.PIPER_MODEL_HI || '/opt/piper/voices/hi_IN-pratham-medium.onnx';
  if (language === 'en') return (gender === 'female' && process.env.PIPER_MODEL_EN_FEMALE) || process.env.PIPER_MODEL_EN || '';
  return '';
}
const piperBin = () => process.env.PIPER_BIN || '/opt/piper/venv/bin/piper';
function piperStatus(language = 'hi') {
  const model = piperModel(language, 'male');
  const bin = piperBin();
  const binOk = onPath(bin) || onPath('piper');
  const modelOk = !!model && fs.existsSync(model);
  return { available: binOk && modelOk, binOk, modelOk, model: model ? path.basename(model) : null };
}

/** Free-first policy: "auto" only ever picks Piper. Paid providers are used only when chosen explicitly in Settings. */
function pickTtsProvider(language = 'hi') {
  const pref = store.getSettings().ttsProvider;
  if (pref === 'none') return null;
  const avail = {
    piper: piperStatus(language).available,
    openai: vault.has('OPENAI_API_KEY'),
    elevenlabs: vault.has('ELEVENLABS_API_KEY'),
    google: vault.has('GOOGLE_TTS_API_KEY'),
  };
  if (pref === 'auto') return avail.piper ? 'piper' : null;
  return avail[pref] ? pref : null;
}

/** Ordered providers to try for a job: the chosen one, then free Piper as a fallback (never another paid one). */
function ttsCandidates(language = 'hi') {
  const first = pickTtsProvider(language);
  const list = first ? [first] : [];
  if (first !== 'piper' && piperStatus(language).available) list.push('piper');
  return list;
}

const GOOGLE_VOICES = {
  en: { female: ['en-US', 'en-US-Neural2-F'], male: ['en-US', 'en-US-Neural2-D'] },
  hi: { female: ['hi-IN', 'hi-IN-Neural2-A'], male: ['hi-IN', 'hi-IN-Neural2-B'] },
};

/** Returns an mp3 Buffer. */
async function synthesize({ provider, text, language, gender }) {
  const r = await synthesizeRaw({ provider, text, language, gender });
  return Buffer.isBuffer(r) ? { data: r, ext: 'mp3' } : r;
}

function runPiper(text, language, gender) {
  return new Promise((resolve, reject) => {
    const model = piperModel(language, gender);
    const out = path.join(os.tmpdir(), `piper_${newId(6)}.wav`);
    const p = spawn(piperBin(), ['-m', model, '-f', out, '--sentence-silence', '0.3'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 120000);
    p.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`Piper could not start: ${scrub(e.message)}`)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0 || !fs.existsSync(out)) throw new Error(`Piper failed (${code}): ${scrub(err).slice(-300)}`);
        const data = fs.readFileSync(out);
        fs.rmSync(out, { force: true });
        resolve({ data, ext: 'wav' });
      } catch (e) { fs.rmSync(out, { force: true }); reject(e); }
    });
    p.stdin.end(text.replace(/\s+/g, ' ').trim() + '\n');
  });
}

async function synthesizeRaw({ provider, text, language, gender }) {
  const s = store.getSettings();
  if (provider === 'piper') return runPiper(text, language, gender);
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

module.exports = { planScenes, ruleBasedScenes, pickTtsProvider, ttsCandidates, piperStatus, synthesize, generateImage, splitSentences };
