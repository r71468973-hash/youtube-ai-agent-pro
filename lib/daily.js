'use strict';
/**
 * Daily automation: once per day (India time, from settings.dailyHour) it writes one new original
 * Hindi story, makes one 3D cartoon Short from it, and leaves the video "ready" for your approval.
 * Nothing is uploaded here: YouTube upload still needs your explicit approval in the dashboard.
 *
 * Duplicate protection: every story has a content key. Keys of past daily stories and of every
 * saved video are checked before a story is used.
 */
const crypto = require('crypto');
const store = require('./store');
const { generateHindiStory } = require('./story');

const TZ = 'Asia/Kolkata';
const MAX_ATTEMPTS_PER_DAY = 3;
const KEY_HISTORY = 1000;
const TICK_MS = 60 * 1000;

/** Today's date (YYYY-MM-DD) and hour (0-23) in India time. */
function localParts(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(now)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

/** Stable content key for a story: whitespace and case do not matter. */
function storyKey(story) {
  return crypto.createHash('sha256').update(String(story).replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 24);
}

/** Every story key already used: past daily runs plus all saved videos. */
function usedKeys() {
  const keys = new Set(store.getSettings().dailyStoryKeys || []);
  for (const v of store.listVideos()) if (v.story) keys.add(storyKey(v.story));
  return keys;
}

/** Returns a story that has not been used yet, or throws if the offline generator is exhausted. */
function pickNewStory(dateSeed, used) {
  for (let i = 0; i < 200; i++) {
    const story = generateHindiStory(dateSeed + i * 7919);
    const key = storyKey(story);
    if (!used.has(key)) return { story, key };
  }
  throw new Error('No new original story is left in the offline story list. Add more story templates to lib/story.js.');
}

/** Title, description and hashtags written from the story, to be reviewed at approval. */
function metadataFor(story) {
  const title = (story.split(/[।.!?\n]/)[0] || 'नई कहानी').trim().slice(0, 70);
  const tags = ['Shorts', 'Hindi', 'Cartoon', '3DAnimation', 'HindiStory'];
  const description = `${story.slice(0, 300)}\n\n${tags.map((t) => `#${t}`).join(' ')}`;
  return { title, description, tags };
}

function recordFailure(date, message) {
  const s = store.getSettings();
  const attempts = s.dailyAttempts && s.dailyAttempts.date === date ? s.dailyAttempts.count + 1 : 1;
  store.setSettings({ dailyAttempts: { date, count: attempts }, dailyLastError: { at: new Date().toISOString(), message: String(message).slice(0, 300) } });
}

/**
 * One scheduler tick. Returns a short result string (for logs and tests).
 * `createVideo(body)` must create and queue the video, returning its id.
 */
async function tick({ createVideo, now = new Date() }) {
  const s = store.getSettings();
  if (!s.dailyEnabled) return 'disabled';
  const { date, hour } = localParts(now);
  if (hour < (s.dailyHour ?? 9)) return 'waiting for the daily hour';
  if (s.dailyLastDate === date) return 'already created today';
  if (s.dailyAttempts && s.dailyAttempts.date === date && s.dailyAttempts.count >= MAX_ATTEMPTS_PER_DAY) return 'gave up for today after repeated failures';
  if (store.listVideos().some((v) => ['queued', 'generating', 'uploading'].includes(v.status))) return 'waiting for another video to finish';

  try {
    const seed = Math.floor(now.getTime() / 86400000) * 13;
    const { story, key } = pickNewStory(seed, usedKeys());
    const meta = metadataFor(story);
    const id = await createVideo({ story, title: meta.title, language: 'hi', format: 'shorts', mode: 'animated-3d', voiceGender: 'male', captions: true, music: 'none' });
    const keys = [...(store.getSettings().dailyStoryKeys || []), key].slice(-KEY_HISTORY);
    store.setSettings({ dailyLastDate: date, dailyStoryKeys: keys, dailyAttempts: null, dailyLastError: null, dailyLastVideo: { id, date, title: meta.title, tags: meta.tags, description: meta.description } });
    return `created ${id} for ${date}`;
  } catch (e) {
    recordFailure(date, e.message);
    return `failed: ${e.message}`;
  }
}

let timer = null;
/** Starts the once-a-minute check. Safe to call more than once. */
function start(createVideo) {
  if (timer) return;
  timer = setInterval(() => {
    tick({ createVideo }).then((r) => { if (r.startsWith('failed')) console.log(`[daily] ${r}`); }).catch((e) => console.log(`[daily] ${e.message}`));
  }, TICK_MS);
}

module.exports = { tick, start, storyKey, localParts, metadataFor, pickNewStory };
