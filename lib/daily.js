'use strict';
/**
 * Daily automation (India time), two slots a day:
 *   morning: makes one new Hindi 2D cartoon Short from 04:00 IST, publishes at 06:30 IST
 *   evening: makes one new Hindi 2D cartoon Short from 16:00 IST, publishes at 18:30 IST
 * Each slot keeps its own state (lastDate, lastVideo, attempts, regen, upload attempts) in settings.dailySlots,
 * and every run is written to settings.dailyHistory with its slot, so morning and evening history stay apart.
 *
 * Duplicate protection: every story has a content key. The keys of past daily stories and of every saved video
 * are checked before a story is used, so no story repeats. A video whose YouTube id is already saved is never
 * uploaded again, and each video gets its own publish slot, so two videos never share a publish time.
 * Upload retries are limited and spaced out; a failed upload is never marked done.
 */
const crypto = require('crypto');
const store = require('./store');
const { generateHindiStory } = require('./story');

const TZ = 'Asia/Kolkata';
const SLOT_IDS = ['morning', 'evening'];
const MAX_ATTEMPTS_PER_DAY = 3;
const MAX_REGENS_PER_DAY = 2; // a failed daily video is made again at most this many times per day
const MAX_UPLOAD_ATTEMPTS = 3;
const UPLOAD_RETRY_GAP_MS = 10 * 60 * 1000;
const KEY_HISTORY = 1000;
const HISTORY_KEEP = 500;
const TICK_MS = 60 * 1000;
const PUBLISH_LEAD_MS = 30 * 60 * 1000;

/** Today's date (YYYY-MM-DD) and hour (0-23) in India time. */
function localParts(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(now)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

const pad2 = (n) => String(n).padStart(2, '0');
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** UTC ISO string for hour:minute on an India date (YYYY-MM-DD). */
const istInstant = (date, hour, minute) => new Date(Date.parse(`${date}T${pad2(hour)}:${pad2(minute)}:00+05:30`)).toISOString();

/** Create and publish times of a slot, from settings (India time). Morning keeps the original settings names. */
function slotConfig(slot, s = store.getSettings()) {
  if (slot === 'evening') {
    return { slot, label: 'Evening', createHour: s.dailyEveningHour ?? 16, publishHour: s.dailyEveningPublishHour ?? 18, publishMinute: s.dailyPublishMinute ?? 30 };
  }
  return { slot: 'morning', label: 'Morning', createHour: s.dailyHour ?? 4, publishHour: s.dailyPublishHour ?? 6, publishMinute: s.dailyPublishMinute ?? 30 };
}

/** Stored state of one slot (empty object when the slot has never run). */
function slotState(s, slot) {
  return (s.dailySlots && s.dailySlots[slot]) || {};
}

/** Merges a patch into one slot's state, leaving the other slot untouched. */
function patchSlot(slot, patch) {
  const cur = store.getSettings();
  const slots = cur.dailySlots || {};
  store.setSettings({ dailySlots: { ...slots, [slot]: { ...(slots[slot] || {}), ...patch } } });
}

/** Appends one run to the history, keeping the newest HISTORY_KEEP entries. */
function addHistory(entry) {
  const cur = store.getSettings();
  store.setSettings({ dailyHistory: [...(cur.dailyHistory || []), entry].slice(-HISTORY_KEEP) });
}

/** Updates the history entry of one video (matched by its video id). */
function updateHistory(videoId, patch) {
  const cur = store.getSettings();
  const history = (cur.dailyHistory || []).map((h) => (h.videoId === videoId ? { ...h, ...patch } : h));
  store.setSettings({ dailyHistory: history });
}

/** Stable content key for a story: whitespace and case do not matter. */
function storyKey(story) {
  return crypto.createHash('sha256').update(String(story).replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 24);
}

/** Every story key already used: past daily runs of both slots plus all saved videos. */
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
const HASHTAGS = ['Shorts', 'HindiStory', 'Hindi', 'Motivation', 'Cartoon', '2DAnimation'];
const TAGS = ['Hindi story', 'Hindi motivational', 'Hindi cartoon', 'Shorts', '2D animation', 'kids story', 'moral story',
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
    'यह कहानी नई और मूल है। इसका वीडियो AI की मदद से 2D कार्टून में बनाया गया है।',
    HASHTAGS.map((t) => `#${t}`).join(' '),
  ].filter(Boolean).join('\n\n');
  return { title, description: Array.from(description).slice(0, 4500).join(''), tags: TAGS.slice(0, 12) };
}

/** Next occurrence of hour:minute India time that is at least `leadMs` after `now`, as an ISO UTC string. */
function nextPublishAt(hour, minute, now = new Date(), leadMs = PUBLISH_LEAD_MS) {
  const { date } = localParts(now);
  for (let n = 0; n < 3; n++) {
    const t = Date.parse(`${addDays(date, n)}T${pad2(hour)}:${pad2(minute)}:00+05:30`);
    if (t >= now.getTime() + leadMs) return new Date(t).toISOString();
  }
  throw new Error('Could not find the next publish time');
}

/**
 * The first hour:minute India time, at least `leadMs` after now, that no other video already uses.
 * Each video gets its own slot, so two videos never share a publish time.
 */
function nextFreeSlot(hour, minute, now = new Date(), taken = new Set(), leadMs = PUBLISH_LEAD_MS) {
  const { date } = localParts(now);
  for (let n = 0; n < 10; n++) {
    const iso = istInstant(addDays(date, n), hour, minute);
    if (Date.parse(iso) >= now.getTime() + leadMs && !taken.has(iso)) return iso;
  }
  throw new Error('No free publish time was found in the next 10 days.');
}

/** Publish times already reserved by other videos. The daily video itself is excluded, so its slot can be kept on a retry. */
function reservedPublishTimes(exceptId = null) {
  return new Set(store.listVideos()
    .filter((v) => v.id !== exceptId && v.schedule && v.schedule.publishAt && v.status !== 'failed')
    .map((v) => v.schedule.publishAt));
}


/**
 * What a slot's video does at upload. Public only when the owner turned on daily public publishing
 * AND gave the one-time consent (dailyPublicConsentAt). Otherwise PRIVATE with no publish time.
 */
function dailyPublishPlan(s, now = new Date(), taken = new Set(), slot = 'morning') {
  if (!s.dailyPublic && s.dailyPrivacy === 'unlisted') return { privacy: 'unlisted', publishAt: null };
  if (!s.dailyPublic || !s.dailyPublicConsentAt) return { privacy: 'private', publishAt: null };
  const cfg = slotConfig(slot, s);
  return { privacy: 'public', publishAt: nextFreeSlot(cfg.publishHour, cfg.publishMinute, now, taken) };
}

function recordFailure(date, message, slot) {
  const st = slotState(store.getSettings(), slot);
  const attempts = st.attempts && st.attempts.date === date ? st.attempts.count + 1 : 1;
  patchSlot(slot, { attempts: { date, count: attempts } });
  store.setSettings({ dailyLastError: { at: new Date().toISOString(), message: String(message).slice(0, 300), slot } });
}

/**
 * One scheduler tick for one slot. Returns a short result string (for logs and tests).
 * `createVideo(body)` must create and queue the video, returning its id.
 * The slot's video is made once a day. It is made again only if it failed (for example, the server restarted
 * while it was rendering), at most MAX_REGENS_PER_DAY times a day.
 */
async function tick({ createVideo, now = new Date(), slot = 'morning', getVideo = (id) => store.getVideo(id) }) {
  const s = store.getSettings();
  if (!s.dailyEnabled) return 'disabled';
  const cfg = slotConfig(slot, s);
  const { date, hour } = localParts(now);
  if (hour < cfg.createHour) return `waiting for the ${cfg.label.toLowerCase()} hour`;
  const st = slotState(s, slot);
  const regenerating = st.lastDate === date;
  if (regenerating) {
    const last = st.lastVideo;
    const lv = last && last.id ? getVideo(last.id) : null;
    const failed = !!lv && lv.status === 'failed' && !(lv.youtube && lv.youtube.videoId);
    if (!failed) return 'already created today';
    const regens = st.regen && st.regen.date === date ? st.regen.count : 0;
    if (regens >= MAX_REGENS_PER_DAY) return 'gave up making today\'s video after failures';
  }
  if (st.attempts && st.attempts.date === date && st.attempts.count >= MAX_ATTEMPTS_PER_DAY) return 'gave up for today after repeated failures';
  if (store.listVideos().some((v) => ['queued', 'generating', 'uploading'].includes(v.status))) return 'waiting for another video to finish';

  try {
    // The slot is part of the seed, so the morning and evening stories of one day differ.
    const seed = Math.floor(now.getTime() / 86400000) * 13 + (cfg.slot === 'evening' ? 1 : 0);
    const { story, key } = pickNewStory(seed, usedKeys());
    const meta = metadataFor(story);
    const id = await createVideo({ story, title: meta.title, language: 'hi', format: 'shorts', mode: '2d-cartoon', voiceGender: 'male', captions: true, music: 'none' });
    const cur = store.getSettings();
    const keys = [...(cur.dailyStoryKeys || []), key].slice(-KEY_HISTORY);
    const lastVideo = { id, date, title: meta.title, tags: meta.tags, description: meta.description };
    const patch = { lastDate: date, attempts: null, lastVideo };
    if (regenerating) patch.regen = { date, count: (st.regen && st.regen.date === date ? st.regen.count : 0) + 1 };
    patchSlot(cfg.slot, patch);
    store.setSettings({ dailyStoryKeys: keys, dailyLastError: null });
    addHistory({ slot: cfg.slot, date, videoId: id, title: meta.title, storyKey: key, status: 'created', privacy: null, youtubeUrl: null, createdAt: new Date().toISOString() });
    return `${regenerating ? 'made again' : 'created'} ${id} for ${date}`;
  } catch (e) {
    recordFailure(date, e.message, slot);
    return `failed: ${e.message}`;
  }
}

/** Marks a slot's video as uploaded (from YouTube's own record) so it is never uploaded again. */
function markUploaded(slot, last, v, now) {
  const uploadedAt = (v.youtube && v.youtube.uploadedAt) || now.toISOString();
  patchSlot(slot, { lastVideo: { ...last, uploadedAt, youtubeUrl: v.youtube && v.youtube.url ? v.youtube.url : null } });
  updateHistory(v.id, { status: 'uploaded', privacy: (v.youtube && v.youtube.privacy) || null, youtubeUrl: v.youtube && v.youtube.url ? v.youtube.url : null, uploadedAt });
}

/**
 * Uploads a slot's finished video to YouTube, when the owner has turned on dailyAutoUpload.
 * It runs at most once per video: a video that already has a YouTube id is never sent again, and a failed upload
 * is retried only after a gap, up to MAX_UPLOAD_ATTEMPTS times.
 * `upload(id, meta)` must resolve true only when YouTube confirmed the upload.
 */
async function autoUploadTick({ upload, isYouTubeReady, getVideo = (id) => store.getVideo(id), now = new Date(), slot = 'morning' }) {
  const s = store.getSettings();
  if (!s.dailyAutoUpload) return 'auto-upload off';
  const last = slotState(s, slot).lastVideo;
  if (!last || !last.id) return 'no daily video yet';
  if (last.uploadedAt) return 'already uploaded';
  if ((last.uploadAttempts || 0) >= MAX_UPLOAD_ATTEMPTS) return 'gave up uploading after repeated failures';
  if (last.lastUploadAt && now.getTime() - Date.parse(last.lastUploadAt) < UPLOAD_RETRY_GAP_MS) return 'waiting before retrying the upload';

  let v = null;
  try { v = getVideo(last.id); } catch (_) { v = null; }
  if (!v) return 'daily video is missing';
  if ((v.youtube && v.youtube.videoId) || v.status === 'published' || v.status === 'scheduled') {
    markUploaded(slot, last, v, now);
    return 'already uploaded';
  }
  if (v.status === 'uploading') return 'upload in progress';
  if (v.status !== 'ready') return `waiting for the video (${v.status})`;
  if (!isYouTubeReady()) return 'YouTube is not connected';

  patchSlot(slot, { lastVideo: { ...last, lastUploadAt: now.toISOString(), uploadAttempts: (last.uploadAttempts || 0) + 1 } });
  // PRIVATE unless the owner turned on daily public publishing and gave consent; then this slot gets its own
  // free publish time (06:30 morning, 18:30 evening IST) and YouTube itself makes the video public at that time.
  const plan = dailyPublishPlan(s, now, reservedPublishTimes(last.id), slot);
  const ok = await upload(v.id, { title: last.title, description: last.description, tags: last.tags || [], ...plan });
  const latest = slotState(store.getSettings(), slot).lastVideo || last;
  if (ok) {
    let after = null;
    try { after = getVideo(v.id); } catch (_) { after = null; }
    const youtubeUrl = after && after.youtube ? after.youtube.url : null;
    patchSlot(slot, { lastVideo: { ...latest, uploadedAt: now.toISOString(), youtubeUrl } });
    updateHistory(v.id, { status: 'uploaded', privacy: plan.privacy, publishAt: plan.publishAt, youtubeUrl, uploadedAt: now.toISOString() });
    return `uploaded ${v.id} as ${plan.privacy}`;
  }
  updateHistory(v.id, { status: 'upload failed' });
  return 'upload failed; will retry';
}

/**
 * What the dashboard shows: when the next daily videos are made, when the next videos become public, the state
 * of each slot, and recent history. Read-only.
 */
function summary(now = new Date()) {
  const s = store.getSettings();
  const { date, hour } = localParts(now);
  const publicOn = !!(s.dailyPublic && s.dailyPublicConsentAt);
  const slots = SLOT_IDS.map((slot) => {
    const cfg = slotConfig(slot, s);
    const createDate = hour < cfg.createHour ? date : addDays(date, 1);
    const lv = slotState(s, slot).lastVideo;
    return {
      slot,
      label: cfg.label,
      createAt: s.dailyEnabled ? istInstant(createDate, cfg.createHour, 0) : null,
      publishTime: `${pad2(cfg.publishHour)}:${pad2(cfg.publishMinute)}`,
      lastVideo: lv ? { id: lv.id, title: lv.title, date: lv.date || null, uploadedAt: lv.uploadedAt || null, youtubeUrl: lv.youtubeUrl || null, uploadAttempts: lv.uploadAttempts || 0 } : null,
    };
  });
  const upcoming = store.listVideos()
    .filter((v) => v.status === 'scheduled' && v.schedule && v.schedule.publishAt && Date.parse(v.schedule.publishAt) > now.getTime())
    .sort((a, b) => a.schedule.publishAt.localeCompare(b.schedule.publishAt));
  let nextPublishAt = null;
  let nextPublishVideo = null;
  if (upcoming.length) {
    nextPublishAt = upcoming[0].schedule.publishAt;
    nextPublishVideo = { id: upcoming[0].id, title: (upcoming[0].approval && upcoming[0].approval.title) || upcoming[0].title || 'Untitled' };
  } else if (publicOn && s.dailyAutoUpload) {
    const taken = reservedPublishTimes();
    const candidates = SLOT_IDS.map((slot) => { const cfg = slotConfig(slot, s); return nextFreeSlot(cfg.publishHour, cfg.publishMinute, now, taken); });
    nextPublishAt = candidates.sort()[0];
  }
  const createTimes = slots.map((x) => x.createAt).filter(Boolean).sort();
  const publishTimes = slots.map((x) => x.publishTime);
  let message;
  if (!s.dailyEnabled) message = 'Daily videos are off. Turn on "Make daily videos" in Settings.';
  else if (!s.dailyAutoUpload) message = 'Daily videos are made but not uploaded. Turn on "Upload each daily video" in Settings.';
  else if (!publicOn) message = 'Daily videos upload as PRIVATE. Turn on public publishing and confirm once in Settings to publish automatically.';
  else message = `Each daily video becomes public on YouTube at ${publishTimes.join(' and ')} India time.`;
  const history = (s.dailyHistory || []).slice(-20).reverse();
  return {
    enabled: !!s.dailyEnabled,
    autoUpload: !!s.dailyAutoUpload,
    publicOn,
    publicConsent: !!s.dailyPublicConsentAt,
    publishTime: publishTimes[0],
    publishTimes,
    nextCreateAt: createTimes[0] || null,
    nextPublishAt,
    nextPublishVideo,
    slots,
    history,
    lastError: s.dailyLastError || null,
    message,
  };
}

let timer = null;
let busy = false;
/**
 * Starts the once-a-minute checks: create each slot's video when its time comes, then upload finished videos
 * when auto-upload is on. Runs one minute check at a time, so the slots never overlap.
 * Safe to call more than once. `upload(id, meta)` resolves true only when YouTube confirmed it.
 */
function start(createVideo, upload) {
  if (timer) return;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const slot of SLOT_IDS) {
        const r = await tick({ createVideo, slot }).catch((e) => `failed: ${e.message}`);
        if (r.startsWith('failed')) console.log(`[daily] ${slot}: ${r}`);
      }
      if (upload) {
        for (const slot of SLOT_IDS) {
          const r = await autoUploadTick({ upload, isYouTubeReady: () => require('./youtube').status().connected, slot }).catch((e) => `upload error: ${e.message}`);
          if (r.startsWith('upload failed') || r.startsWith('upload error')) console.log(`[daily] ${slot}: ${r}`);
        }
      }
    } finally {
      busy = false;
    }
  }, TICK_MS);
}

module.exports = { SLOT_IDS, slotConfig, tick, autoUploadTick, start, storyKey, localParts, metadataFor, pickNewStory, nextPublishAt, nextFreeSlot, dailyPublishPlan, summary, istInstant };
