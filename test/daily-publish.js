'use strict';
/** Daily public publishing: India-time publish times, the consent gate, and SEO metadata limits. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-pub-'));
process.env.DATA_DIR = DATA;
process.env.APP_SECRET = 'x'.repeat(32);
const daily = require('../lib/daily');
const store = require('../lib/store');
const { generateHindiStory } = require('../lib/story');

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

(async () => {
  try {
    // 1. Next publish time, India time (IST = UTC+05:30).
    // 15:30 IST, publish 18:30 IST -> same day 13:00 UTC.
    assert.strictEqual(daily.nextPublishAt(18, 30, new Date('2026-11-15T10:00:00Z')), '2026-11-15T13:00:00.000Z'); ok('publish time later today is computed in India time');
    // Exactly 18:30 IST with a 30-minute lead: today is too close, so tomorrow.
    assert.strictEqual(daily.nextPublishAt(18, 30, new Date('2026-11-15T13:00:00Z')), '2026-11-16T13:00:00.000Z'); ok('a publish time too close to now moves to tomorrow');
    // 18:15 IST, publish 18:30 IST: only 15 minutes away, so tomorrow.
    assert.strictEqual(daily.nextPublishAt(18, 30, new Date('2026-11-15T12:45:00Z')), '2026-11-16T13:00:00.000Z'); ok('a publish time under 30 minutes away moves to tomorrow');
    // Crossing midnight: 23:50 IST, publish 00:10 IST.
    assert.strictEqual(daily.nextPublishAt(0, 10, new Date('2026-11-15T18:20:00Z')), '2026-11-16T18:40:00.000Z'); ok('publish time after midnight India time is handled');

    // 2. The consent gate: public only with the setting on AND a recorded consent.
    const now = new Date('2026-11-15T10:00:00Z');
    assert.deepStrictEqual(daily.dailyPublishPlan({ dailyPublic: false, dailyPublicConsentAt: '2026-11-01T00:00:00Z' }, now), { privacy: 'private', publishAt: null }); ok('public off means PRIVATE');
    assert.deepStrictEqual(daily.dailyPublishPlan({ dailyPublic: true, dailyPublicConsentAt: null }, now), { privacy: 'private', publishAt: null }); ok('public on without consent still means PRIVATE');
    const plan = daily.dailyPublishPlan({ dailyPublic: true, dailyPublicConsentAt: '2026-11-01T00:00:00Z', dailyPublishHour: 18, dailyPublishMinute: 30 }, now);
    assert.deepStrictEqual(plan, { privacy: 'public', publishAt: '2026-11-15T13:00:00.000Z' }); ok('public with consent is scheduled at the chosen India time');

    // 3. Title, description and tags: SEO-friendly and within YouTube's limits, for every story template.
    const seen = new Set();
    for (let seed = 0; seed < 600; seed++) {
      const story = generateHindiStory(seed * 7919);
      const m = daily.metadataFor(story);
      assert(Array.from(m.title).length <= 90, 'title too long'); assert(!/[<>]/.test(m.title));
      assert(Array.from(m.description).length <= 4500, 'description too long');
      assert(m.tags.length >= 1 && m.tags.length <= 15);
      assert(m.description.includes('#Shorts'));
      seen.add(m.title);
    }
    ok('titles, descriptions and tags stay within limits for every story template');
    const meta = daily.metadataFor(generateHindiStory(1));
    assert(meta.title.startsWith('सीख: ')); ok('title carries the story lesson');
    assert(meta.description.includes('आज की सीख:')); ok('description repeats the lesson and adds hashtags');
    assert(seen.size > 1); ok('different stories get different titles');

    // 4. Auto-upload: the upload callback receives the plan, and only consent makes it public.
    store.setSettings({ dailyAutoUpload: true, dailyPublic: true, dailyPublicConsentAt: '2026-11-01T00:00:00Z', dailyPublishHour: 18, dailyPublishMinute: 30 });
    const calls = [];
    const upload = async (id, m) => { calls.push({ id, ...m }); return true; };
    const base = { id: 'vid-public', title: 'T', description: 'D', tags: ['a'], uploadAttempts: 0 };
    store.setSettings({ dailyLastVideo: base });
    const getVideo = (id) => ({ id, status: 'ready', youtube: null });
    const r1 = await daily.autoUploadTick({ upload, isYouTubeReady: () => true, getVideo, now });
    assert.strictEqual(r1, 'uploaded vid-public as public'); ok('upload result names the privacy used');
    assert.strictEqual(calls[0].privacy, 'public'); assert.strictEqual(calls[0].publishAt, '2026-11-15T13:00:00.000Z'); ok('consented daily video is sent public at its publish time');

    store.setSettings({ dailyLastVideo: { ...base, id: 'vid-private', uploadAttempts: 0, uploadedAt: undefined }, dailyPublicConsentAt: null });
    calls.length = 0;
    await daily.autoUploadTick({ upload, isYouTubeReady: () => true, getVideo: (id) => ({ id, status: 'ready' }), now });
    assert.strictEqual(calls[0].privacy, 'private'); assert.strictEqual(calls[0].publishAt, null); ok('without consent the daily video is sent PRIVATE');

    console.log(`\n${passed} daily publishing checks passed`);
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
