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

const LESSON_PREFIX = 'इस कहानी से हमें सीख मिलती है कि';
const HASHTAGS = ['Shorts', 'HindiStory', 'Hindi', 'Motivation', 'Cartoon', '3DAnimation'];
const TAGS = ['Hindi story', 'Hindi motivational', 'Hindi cartoon', 'Shorts', '3D animation', 'kids story', 'moral story',
  'village story', 'हिंदी कहानी', 'प्रेरक कहानी', 'नैतिक कहानी', 'गाँव की कहानी'];

/**
 * SEO-friendly title, description, hashtags and tags, written from the story and its lesson.
 * Title is at most 90 characters (YouTube allows 100); description is at most 4500.
 */
function metadataFor(story) {
  const lines = String(story).split('\n').map((s) => s.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  const lesson = last.startsWith(LESSON_PREFIX) ? last.slice(LESSON_PREFIX.length).replace(/[।.\s]+$/, '').trim() : '';
  const firstLine = (lines[0] || 'नई कहानी').replace(/[।.!?]+$/, '');
  const title = Array.from((lesson ? `सीख: ${lesson}` : firstLine).replace(/[<>]/g, '')).slice(0, 90).join('');
  const description = [
    lines.slice(0, 3).join(' '),
    lesson ? `आज की सीख: ${lesson}` : '',
    'यह कहानी नई और मूल है। इसका वीडियो AI की मदद से 3D कार्टून में बनाया गया है।',
    HASHTAGS.map((t) => `#${t}`).join(' '),
  ].filter(Boolean).join('\n\n');
  return { title, description: Array.from(description).slice(0, 4500).join(''), tags: TAGS.slice(0, 12) };
}

/** Next occurrence of hour:minute India time that is at least `leadMs` after `now`, as an ISO UTC string. */
function nextPublishAt(hour, minute, now = new Date(), leadMs = 30 * 60 * 1000) {
  const { date } = localParts(now);
  const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  for (let n = 0; n < 3; n++) {
    const t = Date.parse(`${addDays(date, n)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`);
    if (t >= now.getTime() + leadMs) return new Date(t).toISOString();
  }
  throw new Error('Could not find the next publish time');
}

/**
 * What the daily video does at upload. Public only when the owner turned on daily public publishing
 * AND gave the one-time consent (dailyPublicConsentAt). Otherwise PRIVATE with no publish time.
 */
function dailyPublishPlan(s, now = new Date()) {
  if (!s.dailyPublic || !s.dailyPublicConsentAt) return { privacy: 'private', publishAt: null };
  return { privacy: 'public', publishAt: nextPublishAt(s.dailyPublishHour ?? 18, s.dailyPublishMinute ?? 30, now) };
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

const MAX_UPLOAD_ATTEMPTS = 3;
const UPLOAD_RETRY_GAP_MS = 10 * 60 * 1000;

/**
 * Uploads today's finished daily video to YouTube, as PRIVATE, when the owner has turned on
 * dailyAutoUpload. It runs at most once per video: a published video is never uploaded again,
 * and a failed upload is retried only after a gap, up to MAX_UPLOAD_ATTEMPTS times.
 * `upload(id, meta)` must resolve true only when YouTube confirmed the upload.
 */
async function autoUploadTick({ upload, isYouTubeReady, getVideo = (id) => store.getVideo(id), now = new Date() }) {
  const s = store.getSettings();
  if (!s.dailyAutoUpload) return 'auto-upload off';
  const last = s.dailyLastVideo;
  if (!last || !last.id) return 'no daily video yet';
  if (last.uploadedAt) return 'already uploaded';
  if ((last.uploadAttempts || 0) >= MAX_UPLOAD_ATTEMPTS) return 'gave up uploading after repeated failures';
  if (last.lastUploadAt && now.getTime() - Date.parse(last.lastUploadAt) < UPLOAD_RETRY_GAP_MS) return 'waiting before retrying the upload';

  let v = null;
  try { v = getVideo(last.id); } catch (_) { v = null; }
  if (!v) return 'daily video is missing';
  if (v.status === 'published') {
    store.setSettings({ dailyLastVideo: { ...last, uploadedAt: (v.youtube && v.youtube.uploadedAt) || now.toISOString() } });
    return 'already uploaded';
  }
  if (v.status !== 'ready') return `waiting for the video (${v.status})`;
  if (!isYouTubeReady()) return 'YouTube is not connected';

  store.setSettings({ dailyLastVideo: { ...last, lastUploadAt: now.toISOString(), uploadAttempts: (last.uploadAttempts || 0) + 1 } });
  // PRIVATE unless the owner turned on daily public publishing and gave consent; then YouTube itself makes it public at publishAt.
  const plan = dailyPublishPlan(s, now);
  const ok = await upload(v.id, { title: last.title, description: last.description, tags: last.tags || [], ...plan });
  const latest = store.getSettings().dailyLastVideo || last;
  if (ok) {
    let after = null;
    try { after = getVideo(v.id); } catch (_) { after = null; }
    store.setSettings({ dailyLastVideo: { ...latest, uploadedAt: now.toISOString(), youtubeUrl: after && after.youtube ? after.youtube.url : null } });
    return `uploaded ${v.id} as ${plan.privacy}`;
  }
  return 'upload failed; will retry';
}

let timer = null;
/**
 * Starts the once-a-minute checks: create today's video, then upload it when auto-upload is on.
 * Safe to call more than once. `upload(id, meta)` resolves true only when YouTube confirmed it.
 */
function start(createVideo, upload) {
  if (timer) return;
  timer = setInterval(() => {
    tick({ createVideo })
      .then((r) => { if (r.startsWith('failed')) console.log(`[daily] ${r}`); })
      .catch((e) => console.log(`[daily] ${e.message}`));
    if (upload) {
      autoUploadTick({ upload, isYouTubeReady: () => require('./youtube').status().connected })
        .then((r) => { if (r.startsWith('upload failed')) console.log(`[daily] ${r}`); })
        .catch((e) => console.log(`[daily] ${e.message}`));
    }
  }, TICK_MS);
}

module.exports = { tick, autoUploadTick, start, storyKey, localParts, metadataFor, pickNewStory, nextPublishAt, dailyPublishPlan };
