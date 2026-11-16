'use strict';
/**
 * Length rules for Shorts. Target 55 seconds; accepted 45–60 seconds.
 *  1. Before generation: the story text is lengthened or shortened so its spoken length is close to the target.
 *  2. After voice recording: if the measured length is still outside the accepted window, the voice is sped up or
 *     slowed down a little (at most ±15%, pitch unchanged) so the total lands on the target.
 *  3. After rendering: the finished file's real length is checked. A Short outside 45–60 seconds is never accepted.
 */
const { run } = require('./util');

const TARGET_SEC = 55;
const MIN_SEC = 45;
const MAX_SEC = 60;
const MAX_TEMPO_CHANGE = 0.15; // voice speed may change by at most 15%
const WPM = { hi: 125, en: 150 }; // the reading speed the rest of the app already assumes
const LESSON_PREFIX = 'इस कहानी से हमें सीख मिलती है कि';

// Neutral closing and connecting lines, used only to lengthen a story that is too short. No speaker, so they are narration.
const FILLERS = {
  hi: [
    'सभी बच्चे इस बात से बहुत खुश हुए।',
    'गाँव में उस दिन हर तरफ़ हँसी और खुशी का माहौल था।',
    'सबने मिलकर बैठकर उस दिन की बातें कीं।',
    'कुछ समय बाद सब फिर से उसी जगह इकट्ठा हुए।',
    'गाँव के लोग इस नई आदत से बहुत प्रभावित हुए।',
    'सबने मिलकर वादा किया कि वे हमेशा ऐसे ही मिल-जुलकर रहेंगे।',
  ],
  en: [
    'Everyone in the village was very happy that day.',
    'Everyone gathered again to share what they had learned.',
    'Later, the whole family sat together and talked about the day.',
    'Soon, they all gathered at the same place again.',
    'The villagers noticed the change and were proud of the children.',
    'They promised each other to keep helping one another always.',
    'The old well at the edge of the field was full of cool, clear water.',
    'Birds sang from the tall trees while the children played nearby.',
    'Grandmother smiled and told them a story from her own childhood.',
    'Everyone listened carefully, because the story was full of kindness.',
  ],
};

const round1 = (n) => Math.round(n * 10) / 10;

/** Estimated spoken length in seconds, from the word count and the reading speed for the language. */
function estimateSeconds(text, language = 'hi') {
  const words = String(text).split(/\s+/).filter(Boolean).length;
  return (words / (WPM[language] || WPM.hi)) * 60;
}

/**
 * Lengthens or shortens a story so its estimated spoken length is near TARGET_SEC. The first line and the
 * lesson (last) line are never removed. Returns the new story and the before/after estimates.
 */
function fitStory(story, language = 'hi') {
  let lines = String(story).split('\n').map((s) => s.trim()).filter(Boolean);
  const fillers = FILLERS[language] || FILLERS.hi;
  const before = estimateSeconds(lines.join(' '), language);
  const est = () => estimateSeconds(lines.join(' '), language);
  let changed = false;

  // Too long: remove lines from the middle, starting next to the lesson, until the estimate is at most target + 2.
  while (est() > TARGET_SEC + 2 && lines.length > 3) { // each pass removes one line, so this always ends
    let idx = lines.length - 2;
    while (idx > 0 && lines[idx].startsWith(LESSON_PREFIX)) idx--; // keep every lesson line
    if (idx <= 0) break; // only the opening and last lines are left
    lines.splice(idx, 1);
    changed = true;
  }

  // Too short: add neutral lines just before the lesson until the estimate reaches the target.
  let added = 0;
  while (est() < TARGET_SEC - 3 && added < fillers.length) {
    const filler = fillers[added++];
    if (lines.includes(filler)) continue;
    lines.splice(Math.max(1, lines.length - 1), 0, filler); // after the opening line, before the lesson/last line
    changed = true;
  }

  return { story: lines.join('\n'), before: round1(before), after: round1(est()), changed };
}

/** The multiplier for voice speed that moves a measured total toward the target, or 1 if it is already in range. */
function tempoFor(totalSeconds) {
  if (totalSeconds >= MIN_SEC + 1 && totalSeconds <= MAX_SEC - 1) return 1;
  const raw = totalSeconds / TARGET_SEC;
  return Math.min(1 + MAX_TEMPO_CHANGE, Math.max(1 - MAX_TEMPO_CHANGE, raw));
}

/** Changes the speed of an audio file without changing its pitch. `tempo` 1.1 = 10% faster. */
async function changeTempo(input, tempo, output) {
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-filter:a', `atempo=${tempo.toFixed(4)}`, '-ar', '44100', '-ac', '1', output]);
  return output;
}

/** Throws unless a Short's length is within 45–60 seconds. Used on the finished file's real length. */
function checkShortDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < MIN_SEC || seconds > MAX_SEC) {
    throw new Error(`The rendered Short is ${Number.isFinite(seconds) ? seconds.toFixed(1) : 'unknown'} seconds long. Shorts must be ${MIN_SEC}–${MAX_SEC} seconds, so this video was not accepted. Regenerate it.`);
  }
  return seconds;
}

module.exports = { TARGET_SEC, MIN_SEC, MAX_SEC, MAX_TEMPO_CHANGE, estimateSeconds, fitStory, tempoFor, changeTempo, checkShortDuration, FILLERS };
