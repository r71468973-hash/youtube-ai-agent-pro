'use strict';
/** Checks for the daily job: timing (India time), once-per-day, duplicate protection and honest failures. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-'));
process.env.DATA_DIR = work;

const store = require('../lib/store');
const daily = require('../lib/daily');
const { generateHindiStory } = require('../lib/story');

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

(async () => {
  try {
    store.init();

    // India time: 03:30 UTC is 09:00 IST on the same date.
    const at9ist = new Date('2026-11-14T03:30:00Z');
    const at8ist = new Date('2026-11-14T02:30:00Z');
    assert.deepStrictEqual(daily.localParts(at9ist), { date: '2026-11-14', hour: 9 });
    ok('India-time date and hour are computed correctly');

    // Disabled by default: nothing is created.
    let created = [];
    const createVideo = async (body) => { created.push(body); return `v${created.length}`; };
    assert.strictEqual(await daily.tick({ createVideo, now: at9ist }), 'disabled');
    ok('daily job is off by default');

    store.setSettings({ dailyEnabled: true, dailyHour: 9 });
    assert.strictEqual(await daily.tick({ createVideo, now: at8ist }), 'waiting for the morning hour');
    assert.strictEqual(created.length, 0);
    ok('does not run before the chosen hour');

    const first = await daily.tick({ createVideo, now: at9ist });
    assert.match(first, /^created v1 for 2026-11-14$/);
    assert.strictEqual(created[0].language, 'hi');
    assert.strictEqual(created[0].mode, '2d-cartoon');
    assert.strictEqual(created[0].format, 'shorts');
    assert.strictEqual(store.getSettings().dailySlots.morning.lastDate, '2026-11-14');
    ok('creates exactly one Hindi 2D cartoon Short at the chosen hour');

    assert.strictEqual(await daily.tick({ createVideo, now: new Date('2026-11-14T06:00:00Z') }), 'already created today');
    assert.strictEqual(created.length, 1);
    ok('never creates a second video on the same day');

    // Duplicate protection: the next day must use a different story.
    const day1Key = daily.storyKey(created[0].story);
    const next = await daily.tick({ createVideo, now: new Date('2026-11-15T03:30:00Z') });
    assert.match(next, /created v2 for 2026-11-15/);
    assert.notStrictEqual(daily.storyKey(created[1].story), day1Key);
    ok('next day uses a story that was not used before');

    // Stories already saved as videos are never reused.
    const used = daily.storyKey(generateHindiStory(0));
    const picked = daily.pickNewStory(0, new Set([used]));
    assert.notStrictEqual(picked.key, used);
    ok('a story already saved as a video is skipped');

    // Failures are recorded honestly and retried, not reported as success.
    store.setSettings({ dailySlots: { morning: { lastDate: null, attempts: null } } });
    const failing = async () => { throw new Error('2D cartoon renderer is not available: no renderer'); };
    const failed = await daily.tick({ createVideo: failing, now: new Date('2026-11-16T03:30:00Z') });
    assert.match(failed, /^failed: 2D cartoon renderer/);
    const s = store.getSettings();
    assert.strictEqual(s.dailySlots.morning.lastDate, null, 'a failed day is not marked as done');
    assert.strictEqual(s.dailySlots.morning.attempts.count, 1);
    assert.match(s.dailyLastError.message, /renderer/);
    ok('a failed run is recorded and not marked as done');

    // After repeated failures the job waits for the next day instead of looping.
    await daily.tick({ createVideo: failing, now: new Date('2026-11-16T04:00:00Z') });
    await daily.tick({ createVideo: failing, now: new Date('2026-11-16T05:00:00Z') });
    assert.strictEqual(
      await daily.tick({ createVideo: failing, now: new Date('2026-11-16T06:00:00Z') }),
      'gave up for today after repeated failures',
    );
    ok('stops after three failed attempts in a day');

    // --- daily auto-upload (always PRIVATE, once per video, retries honestly)
    const calls = [];
    const upload = async (id, meta) => { calls.push({ id, meta }); return true; };
    const at = new Date('2026-11-14T04:00:00Z');
    let videoStatus = 'generating';
    const getVideo = (id) => ({ id, status: videoStatus, youtube: null });
    const ytReady = { v: true };
    const isYouTubeReady = () => ytReady.v;
    store.setSettings({ dailyAutoUpload: false, dailySlots: { morning: { lastVideo: { id: 'daily-1', title: 'कहानी', description: 'd', tags: ['Shorts'] } } } });

    assert.strictEqual(await daily.autoUploadTick({ upload, isYouTubeReady, getVideo, now: at }), 'auto-upload off');
    assert.strictEqual(calls.length, 0);
    ok('auto-upload is off by default and uploads nothing');

    store.setSettings({ dailyAutoUpload: true });
    assert.strictEqual(await daily.autoUploadTick({ upload, isYouTubeReady, getVideo, now: at }), 'waiting for the video (generating)');
    assert.strictEqual(calls.length, 0);
    ok('does not upload a video that is still generating');

    videoStatus = 'ready';
    ytReady.v = false;
    assert.strictEqual(await daily.autoUploadTick({ upload, isYouTubeReady, getVideo, now: at }), 'YouTube is not connected');
    assert.strictEqual(calls.length, 0);
    ok('does not upload when YouTube is not connected');

    ytReady.v = true;
    assert.strictEqual(await daily.autoUploadTick({ upload, isYouTubeReady, getVideo, now: at }), 'uploaded daily-1 as private');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].meta.privacy, 'private', 'daily uploads are always private');
    assert.strictEqual(calls[0].meta.title, 'कहानी');
    ok('uploads the ready daily video once, as PRIVATE');

    assert.strictEqual(store.getSettings().dailySlots.morning.lastVideo.uploadedAt !== undefined, true);
    assert.strictEqual(await daily.autoUploadTick({ upload, isYouTubeReady, getVideo, now: at }), 'already uploaded');
    assert.strictEqual(calls.length, 1, 'no duplicate upload');
    ok('never uploads the same daily video twice');

    // Failure path: a refused upload is retried only after the gap, and is not marked done.
    store.setSettings({ dailySlots: { morning: { lastVideo: { id: 'daily-2', title: 't', description: 'd', tags: [] } } } });
    const refuse = async () => false;
    assert.strictEqual(await daily.autoUploadTick({ upload: refuse, isYouTubeReady, getVideo, now: at }), 'upload failed; will retry');
    assert.strictEqual(store.getSettings().dailySlots.morning.lastVideo.uploadedAt, undefined);
    assert.strictEqual(await daily.autoUploadTick({ upload, isYouTubeReady, getVideo, now: new Date(at.getTime() + 60000) }), 'waiting before retrying the upload');
    assert.strictEqual(calls.length, 1, 'retry waits for the gap');
    const later = new Date(at.getTime() + 11 * 60 * 1000);
    assert.strictEqual(await daily.autoUploadTick({ upload, isYouTubeReady, getVideo, now: later }), 'uploaded daily-2 as private');
    ok('a failed upload is retried after the gap, and only marked done when YouTube confirms');


    // --- two slots: morning (04:00 made, 06:30 public) and evening (16:00 made, 18:30 public)
    const day = '2026-11-20';
    const at2 = (hm) => new Date(`${day}T${hm}:00+05:30`);
    store.setSettings({ dailyAutoUpload: false, dailyPublic: false, dailyPublicConsentAt: null });
    assert.strictEqual(await daily.tick({ createVideo, now: at2('15:59'), slot: 'evening' }), 'waiting for the evening hour');
    const m = await daily.tick({ createVideo, now: at2('09:05'), slot: 'morning' });
    assert.match(m, /^created v\d+ for 2026-11-20$/);
    const e = await daily.tick({ createVideo, now: at2('16:05'), slot: 'evening' });
    assert.match(e, /^created v\d+ for 2026-11-20$/);
    const sMorning = store.getSettings().dailySlots.morning.lastVideo;
    const sEvening = store.getSettings().dailySlots.evening.lastVideo;
    assert.notStrictEqual(sMorning.id, sEvening.id, 'each slot has its own video');
    assert.notStrictEqual(daily.storyKey(created[created.length - 2].story), daily.storyKey(created[created.length - 1].story), 'morning and evening stories differ');
    assert.strictEqual(await daily.tick({ createVideo, now: at2('17:00'), slot: 'evening' }), 'already created today');
    ok('morning and evening each make one different story per day, at their own hours');

    const hist = store.getSettings().dailyHistory.filter((h) => h.date === day);
    assert.deepStrictEqual(hist.map((h) => h.slot).sort(), ['evening', 'morning']);
    ok('history keeps morning and evening runs apart');

    // Duplicate YouTube upload: a video that already has a YouTube id is never sent again.
    const uploads = [];
    const upload2 = async (id, meta) => { uploads.push(id); return true; };
    const readyVideo = (id, extra = {}) => ({ id, status: 'ready', youtube: null, ...extra });
    store.setSettings({ dailyAutoUpload: true, dailySlots: { ...store.getSettings().dailySlots, evening: { ...store.getSettings().dailySlots.evening, lastVideo: { ...sEvening, uploadedAt: undefined } } } });
    const alreadyOnYouTube = (id) => ({ id, status: 'ready', youtube: { videoId: 'yt1', url: 'https://youtu.be/yt1', privacy: 'private', uploadedAt: '2026-11-20T10:00:00Z' } });
    assert.strictEqual(await daily.autoUploadTick({ upload: upload2, isYouTubeReady: () => true, getVideo: alreadyOnYouTube, now: at2('16:20'), slot: 'evening' }), 'already uploaded');
    assert.strictEqual(uploads.length, 0, 'a video with a YouTube id is never uploaded again');
    ok('a video that already has a YouTube id is never uploaded again');

    // Upload in progress blocks a second upload of the same video.
    store.setSettings({ dailySlots: { ...store.getSettings().dailySlots, evening: { ...store.getSettings().dailySlots.evening, lastVideo: { ...sEvening, uploadedAt: undefined, lastUploadAt: undefined, uploadAttempts: 0 } } } });
    assert.strictEqual(await daily.autoUploadTick({ upload: upload2, isYouTubeReady: () => true, getVideo: (id) => readyVideo(id, { status: 'uploading' }), now: at2('16:20'), slot: 'evening' }), 'upload in progress');
    assert.strictEqual(uploads.length, 0);
    ok('an upload already in progress is not started again');

    // Evening upload goes to the evening publish time when public is on.
    store.setSettings({ dailyPublic: true, dailyPublicConsentAt: '2026-11-10T00:00:00Z' });
    const plan = daily.dailyPublishPlan(store.getSettings(), at2('16:20'), new Set(), 'evening');
    assert.strictEqual(plan.privacy, 'public');
    assert.strictEqual(plan.publishAt, daily.istInstant(day, 18, 30));
    ok('the evening video is scheduled for 18:30 IST when public publishing is on');

    // Failed upload is retried with the slot's own state, and the morning slot is untouched.
    store.setSettings({ dailyPublic: false, dailyPublicConsentAt: null });
    const morningBefore = JSON.stringify(store.getSettings().dailySlots.morning);
    store.setSettings({ dailySlots: { ...store.getSettings().dailySlots, evening: { ...store.getSettings().dailySlots.evening, lastVideo: { ...sEvening, uploadedAt: undefined, lastUploadAt: undefined, uploadAttempts: 0 } } } });
    assert.strictEqual(await daily.autoUploadTick({ upload: async () => false, isYouTubeReady: () => true, getVideo: (id) => readyVideo(id), now: at2('16:20'), slot: 'evening' }), 'upload failed; will retry');
    assert.strictEqual(JSON.stringify(store.getSettings().dailySlots.morning), morningBefore, 'the morning slot is not changed by the evening retry');
    ok('a failed evening upload is recorded in the evening slot only');

    // The dashboard shows both slots.
    const sum2 = daily.summary(at2('17:00'));
    assert.deepStrictEqual(sum2.publishTimes, ['06:30', '18:30']);
    assert.strictEqual(sum2.slots.length, 2);
    assert.strictEqual(sum2.slots[1].createAt, daily.istInstant('2026-11-21', 16, 0), 'after 16:00 the next evening video is tomorrow');
    ok('the dashboard lists both slots with their next times');

    console.log(`\n${passed} daily checks passed`);
  } catch (e) {
    console.error('\nFAILED:', e.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
})();
