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
    assert.strictEqual(await daily.tick({ createVideo, now: at8ist }), 'waiting for the daily hour');
    assert.strictEqual(created.length, 0);
    ok('does not run before the chosen hour');

    const first = await daily.tick({ createVideo, now: at9ist });
    assert.match(first, /^created v1 for 2026-11-14$/);
    assert.strictEqual(created[0].language, 'hi');
    assert.strictEqual(created[0].mode, 'animated-3d');
    assert.strictEqual(created[0].format, 'shorts');
    assert.strictEqual(store.getSettings().dailyLastDate, '2026-11-14');
    ok('creates exactly one Hindi 3D Short at the chosen hour');

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
    store.setSettings({ dailyLastDate: null, dailyAttempts: null });
    const failing = async () => { throw new Error('3D animation is not available: no renderer'); };
    const failed = await daily.tick({ createVideo: failing, now: new Date('2026-11-16T03:30:00Z') });
    assert.match(failed, /^failed: 3D animation/);
    const s = store.getSettings();
    assert.strictEqual(s.dailyLastDate, null, 'a failed day is not marked as done');
    assert.strictEqual(s.dailyAttempts.count, 1);
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

    console.log(`\n${passed} daily checks passed`);
  } catch (e) {
    console.error('\nFAILED:', e.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
})();
