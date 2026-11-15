'use strict';
/** YouTube Data API calls for thumbnails and publish time, checked against a stubbed fetch (no network). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-api-test-'));
process.env.DATA_DIR = DATA;
process.env.APP_SECRET = 'x'.repeat(32);
const vault = require('../lib/vault');
const youtube = require('../lib/youtube');

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
const realFetch = global.fetch;
const TOKEN = 'ya29.test-access-token-123';

function stub(handler) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    return handler(String(url), opts);
  };
  return calls;
}
const reply = (status, text = '{}') => ({ ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) });

(async () => {
  try {
    // A connected account whose token is still valid, so no refresh request is needed.
    vault.set('YOUTUBE_TOKENS', JSON.stringify({ access_token: TOKEN, refresh_token: 'r-token', expires_at: Date.now() + 3600000 }));
    const thumb = path.join(DATA, 'thumb.jpg');
    fs.writeFileSync(thumb, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));

    // 1. Thumbnail upload goes to the official thumbnails.set endpoint with the right type and bytes.
    let calls = stub(() => reply(200));
    assert.strictEqual(await youtube.setThumbnail('vid123', thumb), true);
    assert.strictEqual(calls.length, 1);
    assert(calls[0].url.startsWith('https://www.googleapis.com/upload/youtube/v3/thumbnails/set?'));
    assert(calls[0].url.includes('videoId=vid123') && calls[0].url.includes('uploadType=media'));
    assert.strictEqual(calls[0].method, 'POST');
    assert.strictEqual(calls[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.strictEqual(calls[0].headers['content-type'], 'image/jpeg');
    assert(Buffer.from(calls[0].body).equals(fs.readFileSync(thumb)));
    ok('thumbnail is set with the official endpoint, the token, JPEG type and the exact bytes');

    // 2. A PNG thumbnail is sent as PNG.
    const png = path.join(DATA, 'thumb.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    calls = stub(() => reply(200));
    await youtube.setThumbnail('vid123', png);
    assert.strictEqual(calls[0].headers['content-type'], 'image/png');
    ok('PNG thumbnails are sent as PNG');

    // 3. A refused thumbnail throws a clear error, and the token never appears in it.
    stub(() => reply(403, JSON.stringify({ error: { message: 'Channel not verified' } })));
    await assert.rejects(youtube.setThumbnail('vid123', thumb), (e) => {
      assert(/HTTP 403/.test(e.message) && /Channel not verified/.test(e.message));
      assert(!e.message.includes(TOKEN));
      return true;
    });
    ok('a refused thumbnail reports the reason without the token');

    // 4. Oversized thumbnails are refused before any request is made.
    const big = path.join(DATA, 'big.jpg');
    fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 1));
    calls = stub(() => reply(200));
    await assert.rejects(youtube.setThumbnail('vid123', big), /larger than 2 MB/);
    assert.strictEqual(calls.length, 0);
    ok('thumbnails over 2 MB are refused without a request');

    // 5. Publish time change: videos.update with status part, privacy kept private, publishAt set.
    calls = stub(() => reply(200));
    await youtube.updatePublishAt('vid123', '2026-11-16T12:30:00.000Z');
    assert.strictEqual(calls[0].method, 'PUT');
    assert(calls[0].url.startsWith('https://www.googleapis.com/youtube/v3/videos?part=status'));
    const body = JSON.parse(calls[0].body);
    assert.strictEqual(body.id, 'vid123');
    assert.strictEqual(body.status.privacyStatus, 'private');
    assert.strictEqual(body.status.publishAt, '2026-11-16T12:30:00.000Z');
    ok('publish time change keeps the video private until the new time');

    // 6. A refused time change reports YouTube's reason.
    stub(() => reply(400, JSON.stringify({ error: { message: 'publishAt must be in the future' } })));
    await assert.rejects(youtube.updatePublishAt('vid123', '2020-01-01T00:00:00.000Z'), /publishAt must be in the future/);
    ok('a refused time change reports YouTube\'s reason');

    console.log(`\n${passed} YouTube API checks passed`);
  } finally {
    global.fetch = realFetch;
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
