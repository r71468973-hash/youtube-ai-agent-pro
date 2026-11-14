'use strict';
/** Checks scheduled publishing: India time, duplicate prevention, never-early publishing, retries. */
const assert = require('assert');
const publisher = require('../lib/publisher');

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

(async () => {
  const now = new Date('2026-11-15T00:00:00Z'); // 05:30 IST on 15 Nov 2026

  // India time is converted to UTC: 18:30 IST is 13:00 UTC.
  assert.strictEqual(publisher.toUtcPublishAt('2026-11-20T18:30', now), '2026-11-20T13:00:00.000Z');
  assert.strictEqual(publisher.toUtcPublishAt('2026-11-20T18:30:15+05:30', now), '2026-11-20T13:00:15.000Z');
  ok('India time (IST) is converted to UTC correctly');

  assert.throws(() => publisher.toUtcPublishAt('20/11/2026 6pm', now), /India time/);
  assert.throws(() => publisher.toUtcPublishAt('2026-11-15T05:31', now), /at least 2 minutes/);
  assert.throws(() => publisher.toUtcPublishAt('2028-01-01T10:00', now), /within one year/);
  ok('bad formats, past times and times over a year away are refused');

  assert.match(publisher.istLabel('2026-11-20T13:00:00.000Z'), /06:30.*IST/);
  ok('the dashboard label shows India time');

  // Duplicate prevention: a video already on YouTube, or mid-publish, is never uploaded again.
  assert.strictEqual(publisher.canUpload({ status: 'ready', youtube: { videoId: 'abc' } }).ok, false);
  assert.strictEqual(publisher.canUpload({ status: 'scheduled', youtube: null }).ok, false);
  assert.strictEqual(publisher.canUpload({ status: 'ready', youtube: null }).ok, true);
  assert.strictEqual(publisher.canUpload({ status: 'failed', youtube: null }).ok, true);
  ok('a video already on YouTube, or already scheduled, cannot be uploaded again');

  // Scheduler: never publishes early, publishes once YouTube reports public, and fails after the window.
  const scheduledAt = '2026-11-20T13:00:00.000Z';
  const make = (over = {}) => ({
    id: 'v1', status: 'scheduled', youtube: { videoId: 'yt1', url: 'u' }, schedule: { publishAt: scheduledAt, attempts: 1, pending: false }, ...over,
  });
  const run = async (video, state, at) => {
    const saved = [];
    let checks = 0;
    const actions = await publisher.tick({
      now: at,
      videos: () => [video],
      updateVideo: (id, patch) => { saved.push(patch); Object.assign(video, patch); },
      getPublishState: async () => { checks++; if (state instanceof Error) throw state; return state; },
      retry: async () => {},
    });
    return { actions, saved, checks, video };
  };

  let r = await run(make(), { privacyStatus: 'public' }, new Date('2026-11-20T12:59:00Z'));
  assert.strictEqual(r.checks, 0, 'no YouTube check before the scheduled time');
  assert.strictEqual(r.video.status, 'scheduled');
  ok('a scheduled video is never touched before its time');

  r = await run(make(), { privacyStatus: 'public' }, new Date('2026-11-20T13:02:00Z'));
  assert.strictEqual(r.video.status, 'published');
  assert.strictEqual(r.video.youtube.privacy, 'public');
  ok('after the time, a video YouTube reports as public is marked published');

  r = await run(make(), { privacyStatus: 'private' }, new Date('2026-11-20T13:02:00Z'));
  assert.strictEqual(r.video.status, 'scheduled', 'still waiting while YouTube has not published it');
  ok('a video YouTube has not made public stays scheduled');

  r = await run(make(), { privacyStatus: 'private' }, new Date('2026-11-20T14:30:00Z'));
  assert.strictEqual(r.video.status, 'failed');
  assert.match(r.video.error, /not made this video public/);
  ok('a video still private long after its time is reported as failed, honestly');

  r = await run(make(), new Error('network down'), new Date('2026-11-20T13:02:00Z'));
  assert.strictEqual(r.video.status, 'scheduled', 'a YouTube outage does not change the status');
  assert.deepStrictEqual(r.actions, [['check-later', 'v1']]);
  ok('an unreachable YouTube keeps the video scheduled and checks again later');

  // Retries: a failed scheduled upload is retried after a gap, and stops after the limit.
  const pending = (attempts, lastAt) => ({
    id: 'v2', status: 'ready', youtube: null,
    schedule: { publishAt: scheduledAt, pending: true, attempts, lastAttemptAt: lastAt, meta: {} },
  });
  let retries = 0;
  const retryFn = async () => { retries++; };
  const passOnce = (video, at) => publisher.tick({
    now: at, videos: () => [video], updateVideo: (id, patch) => Object.assign(video, patch),
    getPublishState: async () => ({ privacyStatus: 'private' }), retry: retryFn,
  });
  await passOnce(pending(1, '2026-11-15T00:00:00Z'), new Date('2026-11-15T00:05:00Z'));
  assert.strictEqual(retries, 0, 'no retry before the gap has passed');
  await passOnce(pending(1, '2026-11-15T00:00:00Z'), new Date('2026-11-15T00:11:00Z'));
  assert.strictEqual(retries, 1, 'retried once the gap has passed');
  ok('a failed upload is retried after the gap');

  const exhausted = pending(publisher.MAX_UPLOAD_ATTEMPTS, '2026-11-15T00:00:00Z');
  await passOnce(exhausted, new Date('2026-11-15T01:00:00Z'));
  assert.strictEqual(exhausted.status, 'failed');
  assert.strictEqual(retries, 1, 'no further retries after the limit');
  ok('after the retry limit the video is marked failed, not retried forever');

  console.log(`\n${passed} schedule checks passed`);
})().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exitCode = 1;
});
