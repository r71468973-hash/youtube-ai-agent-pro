'use strict';
/**
 * Scheduled publishing.
 *
 * A video scheduled for a time is uploaded to YouTube as PRIVATE with YouTube's own `publishAt`
 * setting, and YouTube makes it public at that moment. So publishing does not depend on this
 * server being awake at the time. This module:
 *   - converts the India time (Asia/Kolkata, +05:30) typed in the dashboard to UTC,
 *   - keeps the app's status in step with what YouTube reports after the publish time,
 *   - retries uploads that failed, a limited number of times, with a gap between tries,
 *   - never marks a video published unless YouTube says it is public,
 *   - refuses a second upload of a video that already has a YouTube id (no duplicates).
 * It holds no secrets and calls YouTube only through the functions it is given.
 */

const IST_OFFSET = '+05:30';
const MAX_UPLOAD_ATTEMPTS = 3;
const RETRY_GAP_MS = 10 * 60 * 1000;
const CHECK_GAP_MS = 5 * 60 * 1000;
const GIVE_UP_MS = 60 * 60 * 1000;
const MIN_LEAD_MS = 2 * 60 * 1000;
const MAX_LEAD_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Turns a publish time into a UTC ISO string. Accepts India time as typed by the date picker
 * ("2026-11-20T18:30", read as IST) or a full ISO string with an offset. Throws a clear message
 * for bad input or a time that is not safely in the future.
 */
function toUtcPublishAt(input, now = new Date()) {
  const s = String(input || '').trim();
  let iso;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) iso = `${s.length === 16 ? `${s}:00` : s}${IST_OFFSET}`;
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)) iso = s;
  else throw Object.assign(new Error('Publish time must be a date and time in India time, like 2026-11-20T18:30.'), { code: 400 });
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw Object.assign(new Error('Publish time is not a valid date.'), { code: 400 });
  if (t < now.getTime() + MIN_LEAD_MS) throw Object.assign(new Error('Publish time must be at least 2 minutes in the future.'), { code: 400 });
  if (t > now.getTime() + MAX_LEAD_MS) throw Object.assign(new Error('Publish time must be within one year.'), { code: 400 });
  return new Date(t).toISOString();
}

/** Human label for a UTC time, shown in India time. */
function istLabel(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(new Date(iso)) + ' IST';
}

/**
 * Whether a video may be uploaded now. A video that already has a YouTube id is never uploaded
 * again (duplicate prevention). Only generated or previously failed videos can be uploaded.
 */
function canUpload(v) {
  if (v.youtube && v.youtube.videoId) return { ok: false, reason: 'already uploaded to YouTube' };
  if (!['ready', 'failed'].includes(v.status)) return { ok: false, reason: `video is ${v.status}` };
  return { ok: true };
}

/**
 * One scheduler pass. `videos()` returns every stored video. `updateVideo(id, patch)` saves changes.
 * `getPublishState(youtubeId)` resolves { privacyStatus }. `retry(id)` re-runs a failed upload.
 * Returns a list of [action, id] for logs and tests. Never publishes a video itself: YouTube does
 * that at the scheduled time, and this function only records what YouTube reports.
 */
async function tick({ now = new Date(), videos, updateVideo, getPublishState, retry }) {
  const actions = [];
  for (const v of videos()) {
    const s = v.schedule;
    if (!s) continue;

    // 1. A scheduled video: after its time has passed, confirm YouTube made it public.
    if (v.status === 'scheduled' && v.youtube && v.youtube.videoId) {
      const due = Date.parse(s.publishAt);
      if (now.getTime() < due + 60 * 1000) continue; // not before the scheduled time
      if (s.lastCheckAt && now.getTime() - Date.parse(s.lastCheckAt) < CHECK_GAP_MS) continue;
      let state = null;
      try {
        state = await getPublishState(v.youtube.videoId);
      } catch (_) {
        // YouTube could not be reached: keep the video as scheduled and check again on the next pass.
        updateVideo(v.id, { schedule: { ...s, lastCheckAt: now.toISOString() } });
        actions.push(['check-later', v.id]);
        continue;
      }
      if (state && state.privacyStatus === 'public') {
        updateVideo(v.id, {
          status: 'published',
          error: null,
          youtube: { ...v.youtube, privacy: 'public', publishedAt: now.toISOString() },
          schedule: { ...s, lastCheckAt: now.toISOString() },
        });
        actions.push(['published', v.id]);
      } else if (now.getTime() - due > GIVE_UP_MS) {
        updateVideo(v.id, {
          status: 'failed',
          error: 'YouTube has not made this video public at the scheduled time. Check it in YouTube Studio.',
          schedule: { ...s, lastCheckAt: now.toISOString() },
        });
        actions.push(['failed', v.id]);
      } else {
        updateVideo(v.id, { schedule: { ...s, lastCheckAt: now.toISOString() } });
      }
      continue;
    }

    // 2. An upload that failed before YouTube accepted it: retry with a gap, then give up.
    if (v.status === 'ready' && s.pending) {
      if ((s.attempts || 0) >= MAX_UPLOAD_ATTEMPTS) {
        updateVideo(v.id, { status: 'failed', error: `Upload failed ${MAX_UPLOAD_ATTEMPTS} times. Press Schedule to try again.`, schedule: { ...s, pending: false } });
        actions.push(['failed', v.id]);
        continue;
      }
      if (!s.lastAttemptAt || now.getTime() - Date.parse(s.lastAttemptAt) >= RETRY_GAP_MS) {
        actions.push(['retry', v.id]);
        try { await retry(v.id); } catch (_) { /* the upload records its own error on the video */ }
      }
    }
  }
  return actions;
}

module.exports = { toUtcPublishAt, istLabel, canUpload, tick, MAX_UPLOAD_ATTEMPTS, RETRY_GAP_MS };
