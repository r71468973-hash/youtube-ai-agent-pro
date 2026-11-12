'use strict';
/** External AI providers: scene planning (Anthropic), text-to-speech, optional AI images. */
const vault = require('./vault');
const store = require('./store');
const { LIMITS } = require('./config');
const { scrub } = require('./util');

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
    `an image prompt for the scene (no text in the image). Describe each recurring character with the same fixed ` +
    `appearance (species/age, hair, skin tone, clothes, colours) in EVERY scene so they look identical across images, ` +
    `and state setting, action and camera framing. Use at most ${maxScenes} scenes.`;
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

function pickTtsProvider() {
  const pref = store.getSettings().ttsProvider;
  if (pref === 'none') return null;
  const avail = {
    openai: vault.has('OPENAI_API_KEY'),
    elevenlabs: vault.has('ELEVENLABS_API_KEY'),
    google: vault.has('GOOGLE_TTS_API_KEY'),
  };
  if (pref !== 'auto') return avail[pref] ? pref : null;
  return ['elevenlabs', 'openai', 'google'].find((p) => avail[p]) || null;
}

const GOOGLE_VOICES = {
  en: { female: ['en-US', 'en-US-Neural2-F'], male: ['en-US', 'en-US-Neural2-D'] },
  hi: { female: ['hi-IN', 'hi-IN-Neural2-A'], male: ['hi-IN', 'hi-IN-Neural2-B'] },
};

/** Returns an mp3 Buffer. */
async function synthesize({ provider, text, language, gender }) {
  const s = store.getSettings();
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

const CARTOON_STYLE =
  'Stylised 3D animated cartoon film still, Pixar-like soft global illumination, rounded expressive characters with big eyes, ' +
  'vibrant colours, clean depth of field, family friendly. No text, letters, captions or watermarks.';

async function generateImage({ prompt, format, cartoon = false }) {
  const res = await request(
    'https://api.openai.com/v1/images/generations',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${vault.get('OPENAI_API_KEY')}` },
      body: JSON.stringify({
        model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
        prompt: cartoon ? `${CARTOON_STYLE} Scene: ${prompt}` : `${prompt}. Cinematic illustration, no text or letters in the image.`,
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

module.exports = { planScenes, ruleBasedScenes, pickTtsProvider, synthesize, generateImage, splitSentences };
