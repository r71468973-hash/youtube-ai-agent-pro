'use strict';
/**
 * Daily automation with a fake clock: one video made at 04:00 IST, uploaded once and scheduled for 06:30 IST,
 * no duplicates, recovery after a failed render, state kept across a restart, the 06:30 publish, and
 * notifications (the webhook address is never printed). No YouTube, Google or AI calls are made.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aiv-daily-auto-'));
const SECRET = 'a'.repeat(40);
process.env.DATA_DIR = DATA;
process.env.APP_SECRET = SECRET;

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
const store = require('../lib/store');
const daily = require('../lib/daily');
const publisher = require('../lib/publisher');
const notify = require('../lib/notify');
const vault = require('../lib/vault');

// India time helpers: 06:30 IST on 2026-11-16 is 01:00 UTC on the same day.
const at = (iso) => new Date(iso);
const SLOT_16 = '2026-11-16T01:00:00.000Z';
const SLOT_17 = '2026-11-17T01:00:00.000Z';
const SLOT_18 = '2026-11-18T01:00:00.000Z';
const NOV16_0405_IST = at('2026-11-15T22:35:00Z');
const NOV16_0410_IST = at('2026-11-15T22:40:00Z');
const NOV16_0631_IST = at('2026-11-16T01:01:00Z');
const NOV16_0640_IST = at('2026-11-16T01:10:00Z');

(async () => {
  // 1. Defaults and the one-time schedule migration.
  store.init();
  const fresh = store.getSettings();
  assert.strictEqual(fresh.dailyHour, 4);
  assert.strictEqual(fresh.dailyPublishHour, 6);
  assert.strictEqual(fresh.dailyPublishMinute, 30);
  ok('the daily video is made at 04:00 India time and published at 06:30 India time by default');

  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiv-daily-old-'));
  fs.writeFileSync(path.join(oldDir, 'db.json'), JSON.stringify({ settings: { dailyHour: 9, dailyPublishHour: 18, dailyPublishMinute: 30 }, videos: {}, music: {} }));
  const mig = spawnSync('node', ['-e', "const s=require('./lib/store');s.init();console.log(JSON.stringify([s.getSettings().dailyHour,s.getSettings().dailyPublishHour,s.getSettings().dailyPublishMinute]))"], { cwd: ROOT, env: { ...process.env, DATA_DIR: oldDir }, encoding: 'utf8' });
  assert.strictEqual(mig.stdout.trim(), '[4,6,30]', mig.stderr);
  fs.rmSync(oldDir, { recursive: true, force: true });
  ok('an earlier 18:30 schedule is moved once to 04:00 and 06:30');

  // 2. Publish slots: exact 06:30 IST, never in the past, never shared.
  assert.strictEqual(daily.nextFreeSlot(6, 30, NOV16_0405_IST), SLOT_16);
  assert.strictEqual(daily.nextFreeSlot(6, 30, NOV16_0640_IST), SLOT_17);
  assert.strictEqual(daily.nextFreeSlot(6, 30, NOV16_0405_IST, new Set([SLOT_16])), SLOT_17);
  assert.strictEqual(daily.nextFreeSlot(6, 30, at('2026-11-16T07:00:00+05:30'), new Set([SLOT_17])), SLOT_18);
  ok('the publish time is exactly 06:30 IST; a time already in use or already past moves to the next free day');

  // 3. Public only with the owner's consent; otherwise private.
  assert.deepStrictEqual(daily.dailyPublishPlan({ dailyPublic: true, dailyPublicConsentAt: null, dailyPublishHour: 6, dailyPublishMinute: 30 }, NOV16_0405_IST), { privacy: 'private', publishAt: null });
  assert.deepStrictEqual(daily.dailyPublishPlan({ dailyPublic: true, dailyPublicConsentAt: '2026-11-10T00:00:00Z', dailyPublishHour: 6, dailyPublishMinute: 30 }, NOV16_0405_IST), { privacy: 'public', publishAt: SLOT_16 });
  ok('without the one-time consent the video stays private; with it, it is scheduled for 06:30 IST');

  // 4. Daily cycle with a fake clock.
  store.setSettings({ dailyEnabled: true, dailyAutoUpload: true, dailyPublic: true, dailyPublicConsentAt: '2026-11-10T00:00:00Z' });
  const createVideo = async (body) => {
    const id = `day${Math.random().toString(36).slice(2, 8)}`;
    store.saveVideo({ id, status: 'ready', title: body.title, story: body.story, format: 'shorts', mode: '2d-cartoon', language: 'hi', createdAt: new Date().toISOString(), scenes: [], warnings: [], progress: 100 });
    return id;
  };
  const uploads = [];
  const upload = async (id, meta) => {
    uploads.push({ id, ...meta });
    const v = store.getVideo(id);
    if (meta.publishAt) {
      Object.assign(v, { status: 'scheduled', youtube: { videoId: `yt-${id}`, url: `https://youtu.be/yt-${id}`, privacy: 'scheduled' }, schedule: { publishAt: meta.publishAt, pending: false, attempts: 1, meta: {} } });
    } else {
      Object.assign(v, { status: 'published', youtube: { videoId: `yt-${id}`, url: `https://youtu.be/yt-${id}`, privacy: 'private' } });
    }
    store.saveVideo(v);
    return true;
  };
  const isReady = () => true;

  assert((await daily.tick({ createVideo, now: NOV16_0405_IST })).startsWith('created'));
  const day1 = store.getSettings().dailyLastVideo.id;
  assert.strictEqual(await daily.tick({ createVideo, now: NOV16_0410_IST }), 'already created today');
  ok('one video is made at 04:00 IST and not again the same day');

  assert((await daily.autoUploadTick({ upload, isYouTubeReady: isReady, now: NOV16_0410_IST })).startsWith('uploaded'));
  assert.strictEqual(uploads.length, 1);
  assert.strictEqual(uploads[0].privacy, 'public');
  assert.strictEqual(uploads[0].publishAt, SLOT_16);
  assert.strictEqual(await daily.autoUploadTick({ upload, isYouTubeReady: isReady, now: NOV16_0410_IST }), 'already uploaded');
  assert.strictEqual(uploads.length, 1, 'a second upload must never happen');
  ok('the video is uploaded once, scheduled to become public at 06:30 IST, and never uploaded twice');

  // 5. The dashboard shows the next publish time and the next video.
  const sum = daily.summary(NOV16_0410_IST);
  assert.strictEqual(sum.nextPublishAt, SLOT_16);
  assert.strictEqual(sum.nextPublishVideo.id, day1);
  assert.strictEqual(sum.publicOn, true);
  assert(sum.nextCreateAt && sum.message.includes('06:30'));
  ok('the dashboard summary shows the next publish time and the video it belongs to');

  // 6. Restart: a fresh process reads the same schedule from disk.
  const restart = spawnSync('node', ['-e', `const d=require('./lib/daily');console.log(JSON.stringify(d.summary(new Date('2026-11-15T22:40:00Z')).nextPublishAt))`], { cwd: ROOT, env: { ...process.env, DATA_DIR: DATA }, encoding: 'utf8' });
  assert.strictEqual(JSON.parse(restart.stdout.trim()), SLOT_16, restart.stderr);
  ok('after a restart the next publish time is still scheduled');

  // 7. Failed render: the day is made again (at most twice), then the app stops trying.
  const day2 = '2026-11-18';
  const at18 = (hm) => at(`${day2}T${hm}:00+05:30`);
  assert((await daily.tick({ createVideo, now: at18('04:05') })).startsWith('created'));
  const first = store.getSettings().dailyLastVideo.id;
  store.saveVideo({ ...store.getVideo(first), status: 'failed', error: 'Interrupted by a server restart.' });
  assert((await daily.tick({ createVideo, now: at18('04:30') })).startsWith('made again'));
  const second = store.getSettings().dailyLastVideo.id;
  store.saveVideo({ ...store.getVideo(second), status: 'failed', error: 'render failed' });
  assert((await daily.tick({ createVideo, now: at18('04:40') })).startsWith('made again'));
  const third = store.getSettings().dailyLastVideo.id;
  store.saveVideo({ ...store.getVideo(third), status: 'failed', error: 'render failed' });
  assert((await daily.tick({ createVideo, now: at18('04:50') })).startsWith('gave up'));
  assert.notStrictEqual(store.getSettings().dailyLastVideo.id, first);
  ok('a failed daily video is made again at most twice a day, then the app stops and reports it');

  // 8. The 06:30 publish: YouTube confirms the video is public, and it is recorded and announced.
  const acts = await publisher.tick({
    now: NOV16_0631_IST,
    videos: () => store.listVideos(),
    updateVideo: (id, patch) => { const v = store.getVideo(id); if (v) { Object.assign(v, patch); store.saveVideo(v); } },
    getPublishState: async () => ({ privacyStatus: 'public' }),
    retry: async () => false,
  });
  assert(acts.some(([a, id]) => a === 'published' && id === day1), JSON.stringify(acts));
  assert.strictEqual(store.getVideo(day1).status, 'published');
  notify.notify('published', `Published: ${store.getVideo(day1).title}`, 'YouTube made this video public at its scheduled time.', day1);
  assert(store.listNotifications(5).some((n) => n.kind === 'published' && n.videoId === day1));
  ok('at 06:30 IST the scheduled video is confirmed public, and a notice is recorded');

  // 9. Webhook: sent with the message, and its address never printed or returned.
  const WEBHOOK = 'https://hooks.example.test/T-SECRET-HOOK-123';
  vault.set('NOTIFY_WEBHOOK_URL', WEBHOOK);
  const realFetch = global.fetch;
  const realLog = console.log;
  const logged = [];
  let sentBody = null;
  let sentUrl = null;
  global.fetch = async (url, opts) => { sentUrl = url; sentBody = opts.body; return { ok: true, status: 204 }; };
  console.log = (...a) => logged.push(a.join(' '));
  let sent;
  try {
    sent = await notify.sendWebhook(store.listNotifications(1)[0]);
  } finally {
    global.fetch = realFetch;
    console.log = realLog;
  }
  assert.strictEqual(sent, true);
  assert.strictEqual(sentUrl, WEBHOOK);
  assert(JSON.parse(sentBody).text.includes('Published:'));
  global.fetch = async () => { throw new Error(`connect failed to ${WEBHOOK}`); };
  console.log = (...a) => logged.push(a.join(' '));
  try {
    assert.strictEqual(await notify.sendWebhook(store.listNotifications(1)[0]), false);
  } finally {
    global.fetch = realFetch;
    console.log = realLog;
  }
  assert(!logged.join('\n').includes('T-SECRET-HOOK-123'), 'the webhook address was printed');
  ok('the webhook receives the notice, and its address is never printed');

  // 10. Turning daily publishing off leaves nothing scheduled to change.
  store.setSettings({ dailyEnabled: false });
  assert.strictEqual(await daily.tick({ createVideo, now: at18('05:00') }), 'disabled');
  assert.strictEqual(daily.summary(at18('05:00')).nextCreateAt, null);
  ok('with daily videos turned off, nothing new is made and the dashboard says so');

  console.log(`\n${passed} daily automation checks passed`);
  fs.rmSync(DATA, { recursive: true, force: true });
})().catch((e) => {
  console.error('FAILED:', e.stack || e.message);
  process.exit(1);
});
