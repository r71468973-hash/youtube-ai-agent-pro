'use strict';
/**
 * Story -> animated scenes.
 *
 *  - Lines written as "Name: dialogue" (or "नाम: संवाद") become character lines. A tag such as
 *    "Name [F]:" fixes the voice gender; without a tag it is guessed from the name.
 *  - Other sentences are narration, spoken by a voice-over while the main character acts on screen.
 *  - Every character keeps the same appearance in every scene (consistent cast).
 *  - Actions (walk, run, jump, wave) and expressions (happy, sad, surprised, angry) come from keywords
 *    in the line. This is a rule-based heuristic, not story understanding.
 *  - Timings come from the real voice-over durations, so lip-sync and subtitles follow the audio.
 */
const { splitSentences } = require('../providers');

const FPS = 24;
const ENTRANCE = 1.2; // seconds the cast walks onto the stage before the first line
const GAP = 0.25; // pause between lines
const TAIL = 0.45; // pause after the last line of a scene
const LIMITS = {
  maxWords: { shorts: 30, long: 60 },
  maxScenes: { shorts: 14, long: 40 },
};
const APPEARANCE = [
  { skin: '#f1c27d', hair: '#1b1b1b', shirt: '#ff7043', pants: '#1e3a8a' },
  { skin: '#8d5524', hair: '#3e2723', shirt: '#42a5f5', pants: '#37474f' },
  { skin: '#e0ac69', hair: '#212121', shirt: '#66bb6a', pants: '#5d4037' },
  { skin: '#c68642', hair: '#4e342e', shirt: '#ab47bc', pants: '#263238' },
  { skin: '#ffdbac', hair: '#795548', shirt: '#ffca28', pants: '#3949ab' },
  { skin: '#a16b3f', hair: '#101010', shirt: '#ef5350', pants: '#455a64' },
];
const ACTION_RULES = [
  ['run', /दौड़|भाग|रेस|\brun|race|rush|dash/i],
  ['jump', /कूद|उछल|\bjump|leap|hop/i],
  ['sow', /बीज|बोया|बो रहा|बो रही|बुवाई|बुआई|रोपाई|रोप|बोते|sow|seed|planting|plant/i],
  ['wave', /हाथ हिला|हाथ उठा|नमस्ते|हैलो|\bwave|hello|\bbye|अलविदा/i],
  ['walk', /चल|गया|गई|गए|आया|आई|आए|पहुंच|पहुँच|\bwalk|\bwent|\bcame|arriv|reached|\bgoes/i],
];
// Weather: rain or strong sun drawn over the scene. A scene that names none keeps the previous one.
const WEATHER_RULES = [
  ['rain', /बारिश|बरसात|बरस|बूंद|बूँद|मानसून|rain|monsoon|drizzle|storm/i],
  ['sun', /तेज़ धूप|तेज धूप|धूप|गर्मी|धूप में|sunshine|scorching|heat|sunny/i],
];
const inferWeather = (text) => {
  let best = null;
  for (const [name, re] of WEATHER_RULES) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) best = { name, index: m.index };
  }
  return best ? best.name : null;
};
const EXPR_RULES = [
  ['happy', /खुश|हंस|हँस|मुस्कुर|मज़ा|मज़े|मजे|happy|smile|laugh|joy|excit|yay|great/i],
  ['sad', /उदास|रोई|रोया|रोने|दुख|दुखी|आंसू|आँसू|\bsad|\bcry|tear|lonely/i],
  ['surprised', /अचानक|हैरान|हैरत|\bwow|surpris|suddenly/i],
  ['angry', /गुस्स|नाराज|\bangry|\bmad\b|shout/i],
];
// Backgrounds: village, forest, river, field, house courtyard, orchard, market, school, temple, indoor room.
const SETTING_RULES = [
  ['village', /गाँव|गांव|village/i],
  ['school', /स्कूल|school|कक्षा|classroom/i],
  ['temple', /मंदिर|मन्दिर|temple|mandir|पूजा|prayer/i],
  ['indoor', /कमरा|कमरे|रसोई|room|kitchen|bedroom/i],
  ['courtyard', /घर|आंगन|आँगन|house|home|courtyard/i],
  ['forest', /जंगल|वन\b|forest|jungle|woods/i],
  ['park', /पार्क|बगीचा|बगीचे|बाग|garden|park|orchard|आम का बाग|mango/i],
  ['river', /नदी|तालाब|झील|river|pond|lake|stream/i],
  ['field', /खेत|खेतों|फसल|field|farm|crops/i],
  ['market', /बाज़ार|बाजार|दुकान|market|shop/i],
];
// Time of day: sunrise, day, evening and night change the sky, the sun and the light.
const TIME_RULES = [
  ['sunrise', /सुबह|सूरज निकल|सूर्योदय|भोर|सवेरे|सूरज उग|sunrise|dawn|morning|sun rose|rising sun/i],
  ['evening', /शाम|सूर्यास्त|सूरज ढल|sunset|evening|dusk/i],
  ['night', /रात|रात्रि|चांद|चाँद|night|moon|stars/i],
];
const SHOTS = ['wide', 'medium', 'closeup', 'tracking'];

// The time mentioned first wins; scenes that name no time keep the previous one.
const inferTime = (text) => {
  let best = null;
  for (const [name, re] of TIME_RULES) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) best = { name, index: m.index };
  }
  return best ? best.name : null;
};

const inferAction = (text) => (ACTION_RULES.find(([, re]) => re.test(text)) || [null])[0] || 'idle';
const inferExpr = (text) => (EXPR_RULES.find(([, re]) => re.test(text)) || [null])[0] || 'neutral';
// The place mentioned first in the text wins, not the first rule in the list.
const inferSetting = (text) => {
  let best = null;
  for (const [name, re] of SETTING_RULES) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) best = { name, index: m.index };
  }
  return best ? best.name : null;
};

// "Name:", "Name [F]:", "नाम [महिला]:". Up to three words, so ordinary sentences with colons stay narration.
const SPEAKER_RE = /^([^:：[\]]{1,40}?)\s*(?:\[(F|M|female|male|महिला|पुरुष)\])?\s*[:：]\s*(.+)$/iu;
function parseSpeaker(line) {
  const m = SPEAKER_RE.exec(line);
  if (!m) return null;
  const name = m[1].trim();
  if (!name || name.split(/\s+/).length > 3) return null;
  const tag = m[2] ? (/^(F|female|महिला)$/i.test(m[2]) ? 'F' : 'M') : null;
  return { name, gender: tag, text: m[3].trim() };
}

/** Lines -> ordered blocks {speaker, gender, text}, one block per sentence. */
function parseBlocks(story) {
  const blocks = [];
  for (const raw of story.replace(/\r/g, '').split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const sp = parseSpeaker(line);
    const parts = sp ? splitSentences(sp.text) : splitSentences(line);
    for (const text of parts) {
      blocks.push({ speaker: sp ? sp.name : null, gender: sp ? sp.gender : null, text });
    }
  }
  return blocks;
}

/**
 * Plan the scenes (no timing yet).
 * Returns {scenes:[{setting, utterances:[{speaker, gender, text, action, expr, isDialogue}]}],
 *          characters:[{id,name,gender,skin,hair,shirt,pants,longHair}], protagonistId, truncated}
 */
function planAnimatedScenes({ story, language, format, voiceGender }) {
  const blocks = parseBlocks(story);
  if (!blocks.length) throw new Error('The story did not contain any usable text.');

  // Cast: one character per distinct speaker, in order of first appearance.
  const cast = new Map();
  for (const b of blocks) {
    if (!b.speaker || cast.has(b.speaker)) continue;
    const g = b.gender || (/([aā]|[ाी])$/i.test(b.speaker) ? 'F' : 'M');
    const look = APPEARANCE[cast.size % APPEARANCE.length];
    cast.set(b.speaker, { id: `c${cast.size + 1}`, name: b.speaker, gender: g, ...look, longHair: g === 'F' });
  }
  if (!cast.size) {
    const name = language === 'hi' ? 'नन्हा' : 'Little Friend';
    cast.set(name, { id: 'c1', name, gender: voiceGender === 'male' ? 'M' : 'F', ...APPEARANCE[0], longHair: voiceGender !== 'male' });
  }
  const characters = [...cast.values()];
  const protagonist = characters[0];

  // Group blocks into scenes by word budget.
  const maxWords = LIMITS.maxWords[format];
  const groups = [];
  let cur = null;
  let words = 0;
  for (const b of blocks) {
    const n = b.text.split(/\s+/).length;
    if (!cur || (words + n > maxWords && cur.length)) {
      cur = [];
      groups.push(cur);
      words = 0;
    }
    cur.push(b);
    words += n;
  }
  const maxScenes = LIMITS.maxScenes[format];
  const truncated = groups.length > maxScenes;
  // A scene that names no place keeps the previous scene's setting, so the location does not jump.
  let lastSetting = 'village'; // Indian village is the default background for a story with no place named
  let lastTime = 'day';
  let lastWeather = null;
  const scenes = groups.slice(0, maxScenes).map((group) => {
    const text = group.map((b) => b.text).join(' ');
    const setting = inferSetting(text) || lastSetting;
    lastSetting = setting;
    const time = inferTime(text) || lastTime;
    lastTime = time;
    const weather = inferWeather(text) || lastWeather;
    lastWeather = weather;
    return {
      setting,
      time,
      weather,
      utterances: group.map((b) => {
        const who = b.speaker ? cast.get(b.speaker) : null;
        return {
          speaker: who ? who.id : null,
          gender: who ? who.gender : voiceGender === 'male' ? 'M' : 'F',
          text: b.text,
          isDialogue: !!who,
          action: inferAction(b.text),
          expr: inferExpr(b.text),
        };
      }),
    };
  });
  return { scenes, characters, protagonistId: protagonist.id, truncated };
}

const xSlots = (n) => {
  if (n <= 1) return [0];
  if (n === 2) return [-1.4, 1.4];
  if (n === 3) return [-2.4, 0, 2.4];
  return Array.from({ length: n }, (_, i) => -3.6 + (7.2 * i) / (n - 1));
};

/**
 * Turn planned scenes plus measured utterance durations into render specs.
 * Each utterance must have `dur` (seconds). Returns scenes with:
 *   spec (stage input), layout (voice-track parts), cues (subtitle timings), duration, narration.
 */
/** Camera path for one shot. Moves are large enough to read on a phone screen. */
function cameraFor(shot, n) {
  if (shot === 'wide') return { from: [0, 2.6, 13], to: [0, 2.2, 11.2], look: [0, 1.1, 0] };
  if (shot === 'closeup' && n <= 1) return { from: [0.4, 1.9, 4.6], to: [0.2, 1.85, 3.8], look: [0, 1.6, 0] };
  if (shot === 'tracking') return { from: [-7, 1.4, 7], to: [7, 1.4, 7], look: [0, 1.1, 0] };
  // medium (and close-up with more than one character)
  return { from: [-1.8, 1.7, 5.2], to: [1.2, 1.6, 4.4], look: [0, 1.25, 0] };
}

function buildSpecs({ scenes, characters, protagonistId, format }) {
  const fov = format === 'shorts' ? 55 : 38;
  const fixedDur = (sec) => Math.ceil(sec * FPS) / FPS; // whole frames only

  return scenes.map((sc, k) => {
    // Cast = speakers in order; narration-only scenes show the protagonist.
    const castIds = [];
    for (const u of sc.utterances) if (u.speaker && !castIds.includes(u.speaker)) castIds.push(u.speaker);
    if (!castIds.length) castIds.push(protagonistId);
    const xs = xSlots(castIds.length);
    const pos = new Map(castIds.map((id, i) => [id, xs[i]]));

    // Timeline of utterance windows. Each window is followed by a short gap.
    const windows = [];
    let cursor = ENTRANCE;
    const cues = [];
    for (const u of sc.utterances) {
      const owner = u.speaker && castIds.includes(u.speaker) ? u.speaker : castIds[0];
      windows.push({ start: cursor, end: cursor + u.dur, owner, u });
      cues.push({ start: cursor, end: cursor + u.dur, text: u.text });
      cursor += u.dur + GAP;
    }
    const end = cursor - GAP; // end of the last spoken line
    const duration = fixedDur(end + TAIL);
    // Voice track: lead-in, then each line separated by GAP, then a tail so the track is exactly `duration`.
    const utterTotal = sc.utterances.reduce((a, u) => a + u.dur, 0);
    const tail = duration - ENTRANCE - utterTotal - GAP * (sc.utterances.length - 1);
    const finalLayout = [{ silence: ENTRANCE }];
    sc.utterances.forEach((u, i) => {
      finalLayout.push({ file: u.wav });
      finalLayout.push({ silence: i === sc.utterances.length - 1 ? tail : GAP });
    });

    const timeline = [];
    // Entrance: visible cast walks in from the left.
    for (const id of castIds) {
      const x = pos.get(id);
      timeline.push({ char: id, start: 0, end: ENTRANCE, action: 'walk', expr: 'happy', speak: false, from: [x - 4.5, 0], to: [x, 0] });
    }
    for (const w of windows) {
      const { owner, u } = w;
      const mover = u.action === 'walk' || u.action === 'run';
      for (const id of castIds) {
        const x0 = pos.get(id);
        const isOwner = id === owner;
        let x1 = x0;
        // A walker steps away from the group, so characters never walk into each other.
        if (isOwner && mover) {
          const outward = x0 === 0 ? (id === castIds[0] ? -1 : 1) : Math.sign(x0);
          x1 = Math.max(-4.5, Math.min(4.5, x0 + outward * 0.6));
        }
        timeline.push({
          char: id,
          start: w.start,
          end: w.end,
          action: isOwner ? u.action : 'idle',
          expr: isOwner ? u.expr : 'neutral',
          speak: isOwner && u.isDialogue,
          from: [x0, 0],
          to: [x1, 0],
        });
        pos.set(id, x1);
      }
      // Gap after the line: everyone idles, nobody speaks.
      const gapStart = w.end;
      for (const id of castIds) {
        timeline.push({ char: id, start: gapStart, end: gapStart + GAP, action: 'idle', expr: 'neutral', speak: false, from: [pos.get(id), 0], to: [pos.get(id), 0] });
      }
    }
    // Pad every visible character to the end of the scene.
    // The last gap already ends at `cursor`, so padding starts there (no overlapping segments).
    for (const id of castIds) {
      timeline.push({ char: id, start: cursor, end: duration, action: 'idle', expr: 'neutral', speak: false, from: [pos.get(id), 0], to: [pos.get(id), 0] });
    }
    // Off-stage characters stay out of frame for this scene.
    for (const c of characters) {
      if (castIds.includes(c.id)) continue;
      timeline.push({ char: c.id, start: 0, end: duration, action: 'idle', expr: 'neutral', speak: false, from: [40, 0], to: [40, 0] });
    }

    // Shots rotate per scene (wide, medium, close-up, tracking) so the camera keeps moving between scenes.
    const n = castIds.length;
    const camera = cameraFor(SHOTS[k % SHOTS.length], n);

    const spec = {
      setting: sc.setting,
      time: sc.time || 'day',
      weather: sc.weather || null,
      shot: SHOTS[k % SHOTS.length],
      duration,
      fov,
      camera,
      characters: characters.map((c) => ({ id: c.id, skin: c.skin, hair: c.hair, shirt: c.shirt, pants: c.pants, longHair: c.longHair })),
      timeline: timeline.map((t) => ({ ...t, start: round(t.start), end: round(t.end), from: t.from.map(round), to: t.to.map(round) })),
    };
    const narration = sc.utterances.map((u) => u.text).join(' ');
    return { spec, duration, layout: finalLayout, cues, narration };
  });
}

const round = (v) => Math.round(v * 1000) / 1000;

const TRANSITION_SEC = 0.35; // how long a new scene dissolves in from the last frame of the scene before it

/**
 * Adds a dissolve to every scene after the first: the new scene starts from the final frame of the
 * previous one. Only the stage draws it; the clips keep exactly their scene lengths, so the voice stays in sync.
 */
function linkTransitions(built) {
  built.forEach((b, k) => {
    delete b.spec.transition;
    if (k === 0) return;
    const prev = built[k - 1];
    const { transition, ...prevSpec } = prev.spec; // no nesting: the previous scene's own dissolve is not needed
    b.spec.transition = { seconds: TRANSITION_SEC, fromT: round(Math.max(0, prev.duration - 1 / FPS)), from: prevSpec };
  });
  return built;
}

module.exports = { planAnimatedScenes, buildSpecs, linkTransitions, parseBlocks, parseSpeaker, inferAction, inferExpr, inferSetting, inferTime, inferWeather, cameraFor, FPS, GAP, ENTRANCE, LIMITS, TRANSITION_SEC };
