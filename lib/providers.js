'use strict';
/** External AI providers: scene planning (Anthropic), text-to-speech, optional AI images. */
const vault = require('./vault');
const store = require('./store');
const { LIMITS } = require('./config');
const { scrub, sleep } = require('./util');

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

const GEMINI_BASE = () => (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
const GEMINI_TEXT_MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_IMAGE_MODEL = () => process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const GEMINI_TTS_MODEL = () => process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';

/** POST to a Gemini model. The key travels in a header, never in the URL. Retries rate limits. */
async function gemini(model, body, label) {
  const url = `${GEMINI_BASE()}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': vault.get('GEMINI_API_KEY') }, body: JSON.stringify(body) }, label);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (!/HTTP (429|503)/.test(e.message) || attempt === 2) break;
      await sleep(attempt === 0 ? 8000 : 20000);
    }
  }
  throw lastErr;
}
const geminiParts = (data) => ((data.candidates || [])[0] || {}).content?.parts || [];

function planSystemPrompt({ language, format, style }) {
  const maxScenes = LIMITS.maxScenes[format];
  const maxWords = LIMITS.maxSceneWords[format];
  const langName = language === 'hi' ? 'Hindi (Devanagari script)' : 'English';
  const look = style === '3d-cartoon'
    ? 'Every "visual" must describe a 3D animated cartoon scene (Pixar-style, soft lighting, expressive rounded characters, vivid colours).'
    : 'Every "visual" must describe a cinematic illustration.';
  return (
    'You turn a story into a scene list for a narrated video. Reply with ONLY a JSON object, no prose: ' +
    '{"characters": string, "scenes": [{"narration": string, "visual": string}]}. ' +
    '"characters" is one short English paragraph fixing the look of every recurring character and the setting, so images stay consistent. ' +
    `"narration" is the voiceover in ${langName}, at most ${maxWords} words, preserving the story's meaning and order. ` +
    `"visual" is a short English description of one image for the scene (no text or letters in the image). ${look} ` +
    `Use at most ${maxScenes} scenes. If the input is only an idea or a few lines, expand it into a complete short story first.`
  );
}

function parsePlan(text, format) {
  const maxScenes = LIMITS.maxScenes[format];
  let obj;
  const o0 = text.indexOf('{');
  const a0 = text.indexOf('[');
  if (o0 !== -1 && (a0 === -1 || o0 < a0)) obj = JSON.parse(text.slice(o0, text.lastIndexOf('}') + 1));
  else obj = { scenes: JSON.parse(text.slice(a0, text.lastIndexOf(']') + 1)) };
  const characters = String(obj.characters || '').slice(0, 600);
  const scenes = (obj.scenes || [])
    .filter((s) => s && typeof s.narration === 'string' && s.narration.trim())
    .slice(0, maxScenes)
    .map((s) => ({ narration: s.narration.trim(), visual: String(s.visual || s.narration).slice(0, 300) }));
  if (!scenes.length) throw new Error('empty plan');
  return { scenes, characters };
}

async function planWithGemini({ story, language, format, style }) {
  const data = await gemini(GEMINI_TEXT_MODEL(), {
    systemInstruction: { parts: [{ text: planSystemPrompt({ language, format, style }) }] },
    contents: [{ role: 'user', parts: [{ text: story }] }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8000 },
  }, 'Gemini scene planner');
  return parsePlan(geminiParts(data).map((p) => p.text || '').join(''), format);
}

async function planWithAnthropic({ story, language, format, style }) {
  const res = await request(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': vault.get('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        max_tokens: 6000,
        system: planSystemPrompt({ language, format, style }),
        messages: [{ role: 'user', content: story }],
      }),
    },
    'Anthropic scene planner'
  );
  const data = await res.json();
  return parsePlan((data.content || []).map((c) => c.text || '').join(''), format);
}

/** Which AI planners can run, in order of preference, given the saved choice and available keys. */
function plannerOrder() {
  const pref = store.getSettings().aiProvider || 'auto';
  const have = { gemini: vault.has('GEMINI_API_KEY'), anthropic: vault.has('ANTHROPIC_API_KEY') };
  if (pref === 'gemini' || pref === 'anthropic') return have[pref] ? [pref] : [];
  return ['gemini', 'anthropic'].filter((p) => have[p]);
}

async function planScenes({ story, language, format }) {
  const order = plannerOrder();
  if (!order.length) return { scenes: ruleBasedScenes(story, format), method: 'rule-based' };
  const style = store.getSettings().visualStyle || '3d-cartoon';
  const warnings = [];
  for (const provider of order) {
    try {
      const fn = provider === 'gemini' ? planWithGemini : planWithAnthropic;
      const plan = await fn({ story, language, format, style });
      return { ...plan, method: provider, warning: warnings.join(' ') || undefined };
    } catch (e) {
      warnings.push(`${provider === 'gemini' ? 'Gemini' : 'Anthropic'} scene planning failed (${scrub(e.message).slice(0, 160)}).`);
    }
  }
  return { scenes: ruleBasedScenes(story, format), method: 'rule-based', warning: `${warnings.join(' ')} Used simple splitting.` };
}

/* ------------------------------------------------------------------- TTS */

/** Ordered list of usable voiceover providers. The pipeline tries them in turn, so one broken account does not kill a video. */
function ttsProviders() {
  const pref = store.getSettings().ttsProvider;
  if (pref === 'none') return [];
  const avail = {
    gemini: vault.has('GEMINI_API_KEY'),
    openai: vault.has('OPENAI_API_KEY'),
    elevenlabs: vault.has('ELEVENLABS_API_KEY'),
    google: vault.has('GOOGLE_TTS_API_KEY'),
  };
  const all = ['elevenlabs', 'gemini', 'openai', 'google'].filter((p) => avail[p]);
  if (pref !== 'auto') return avail[pref] ? [pref, ...all.filter((p) => p !== pref)] : all;
  return all;
}
const pickTtsProvider = () => ttsProviders()[0] || null;

/** Wrap raw 16-bit mono PCM in a WAV container. */
function pcmToWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const GOOGLE_VOICES = {
  en: { female: ['en-US', 'en-US-Neural2-F'], male: ['en-US', 'en-US-Neural2-D'] },
  hi: { female: ['hi-IN', 'hi-IN-Neural2-A'], male: ['hi-IN', 'hi-IN-Neural2-B'] },
};

/** Returns {data: Buffer, ext: 'mp3'|'wav'}. */
async function synthesize({ provider, text, language, gender }) {
  const s = store.getSettings();
  if (provider === 'gemini') {
    const data = await gemini(GEMINI_TTS_MODEL(), {
      contents: [{ parts: [{ text: `${language === 'hi' ? 'Say in natural, warm Hindi, like a storyteller' : 'Say in a warm storytelling voice'}: ${text}` }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: gender === 'male' ? 'Charon' : 'Kore' } } },
      },
    }, 'Gemini TTS');
    const part = geminiParts(data).find((p) => p.inlineData && p.inlineData.data);
    if (!part) throw new Error('Gemini TTS returned no audio');
    const rate = parseInt(/rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1] || '24000', 10);
    return { data: pcmToWav(Buffer.from(part.inlineData.data, 'base64'), rate), ext: 'wav' };
  }
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
    return { data: Buffer.from(await res.arrayBuffer()), ext: 'mp3' };
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
    return { data: Buffer.from(await res.arrayBuffer()), ext: 'mp3' };
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
    return { data: Buffer.from(data.audioContent, 'base64'), ext: 'mp3' };
  }
  throw new Error('No TTS provider');
}

/* ---------------------------------------------------------------- images */

function imageProvider() {
  if (vault.has('GEMINI_API_KEY')) return 'gemini';
  if (vault.has('OPENAI_API_KEY')) return 'openai';
  return null;
}

/** Returns a PNG/JPEG Buffer. `characters` keeps recurring characters consistent across scenes. */
async function generateImage({ prompt, format, characters, provider = imageProvider() }) {
  const style = store.getSettings().visualStyle || '3d-cartoon';
  const look = style === '3d-cartoon'
    ? '3D animated cartoon style, Pixar-like render, soft cinematic lighting, expressive rounded characters, vibrant colours'
    : 'Cinematic illustration';
  const full = `${look}. ${characters ? `Characters and setting: ${characters}. ` : ''}Scene: ${prompt}. No text, letters or watermarks in the image.`;
  if (provider === 'gemini') {
    const data = await gemini(GEMINI_IMAGE_MODEL(), {
      contents: [{ parts: [{ text: full }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: format === 'shorts' ? '9:16' : '16:9' } },
    }, 'Gemini image');
    const part = geminiParts(data).find((p) => (p.inlineData || p.inline_data));
    const b64 = part && (part.inlineData || part.inline_data).data;
    if (!b64) throw new Error('Gemini returned no image');
    return Buffer.from(b64, 'base64');
  }
  const res = await request(
    'https://api.openai.com/v1/images/generations',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${vault.get('OPENAI_API_KEY')}` },
      body: JSON.stringify({
        model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
        prompt: full,
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

/** Cheap live check of the Gemini key. */
async function testGemini() {
  const data = await gemini(GEMINI_TEXT_MODEL(), { contents: [{ parts: [{ text: 'Reply with the single word: ok' }] }], generationConfig: { maxOutputTokens: 20 } }, 'Gemini test');
  return geminiParts(data).map((p) => p.text || '').join('').trim().slice(0, 40) || 'ok';
}

module.exports = { planScenes, ruleBasedScenes, pickTtsProvider, ttsProviders, imageProvider, testGemini, plannerOrder, pcmToWav, synthesize, generateImage, splitSentences };
