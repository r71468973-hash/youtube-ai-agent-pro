'use strict';
/** Connected channel details, upload guard and old-record refresh, against a stubbed network (no real YouTube). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-channel-test-'));
process.env.DATA_DIR = DATA;
process.env.APP_SECRET = 'x'.repeat(32);
const vault = require('../lib/vault');
const youtube = require('../lib/youtube');

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
const realFetch = global.fetch;
const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });

/** channels: the channel list the stubbed account returns (empty = no channel). */
function stubGoogle({ channels, uploadInitStatus = 500 }) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET' });
    if (u.startsWith('https://oauth2.googleapis.com/token')) return reply(200, { access_token: 'ya29.new', refresh_token: 'r-new', expires_in: 3600 });
    if (u.includes('/youtube/v3/channels')) return reply(200, { items: channels });
    if (u.includes('uploadType=resumable')) return reply(uploadInitStatus, { error: { message: 'stubbed' } });
    return reply(500, { error: { message: 'unexpected call in test' } });
  };
  return calls;
}

const MOONHAND = { id: 'UCmoonhand123', snippet: { title: 'Moonhand Facts', customUrl: '@moonhandifacts', thumbnails: { default: { url: 'https://yt3.ggpht.com/small.jpg' }, high: { url: 'https://yt3.ggpht.com/high.jpg' } } } };
const OTHER = { id: 'UCother999', snippet: { title: 'Another Channel', thumbnails: {} } };

(async () => {
  try {
    vault.set('YOUTUBE_CLIENT_ID', 'client-id.apps.googleusercontent.com');
    vault.set('YOUTUBE_CLIENT_SECRET', 'client-secret-value');

    // 1. After OAuth, the channel is read with channels.list mine=true and stored with the handle and picture.
    const calls = stubGoogle({ channels: [MOONHAND] });
    const ch = await youtube.handleCallback({ code: 'auth-code', verifier: 'v' });
    const listCall = calls.find((c) => c.url.includes('/youtube/v3/channels'));
    assert(listCall && listCall.url.includes('part=snippet') && listCall.url.includes('mine=true'));
    assert.strictEqual(ch.id, 'UCmoonhand123');
    assert.strictEqual(ch.title, 'Moonhand Facts');
    assert.strictEqual(ch.handle, '@moonhandifacts');
    assert.strictEqual(ch.url, 'https://www.youtube.com/@moonhandifacts');
    assert.strictEqual(ch.thumbnail, 'https://yt3.ggpht.com/high.jpg');
    const st = youtube.status();
    assert.strictEqual(st.connected, true);
    assert.strictEqual(st.channel.id, 'UCmoonhand123');
    ok('connection reads the channel with channels.list mine=true and stores name, handle, URL, ID and picture');

    // 2. A channel without a handle links by channel ID.
    stubGoogle({ channels: [OTHER] });
    const noHandle = await youtube.refreshChannel();
    assert.strictEqual(noHandle.url, 'https://www.youtube.com/channel/UCother999');
    assert.strictEqual(noHandle.thumbnail, null);
    ok('a channel without a handle links by ID and has no picture');

    // 3. A Google account with no YouTube channel gets a clear error.
    stubGoogle({ channels: [] });
    await assert.rejects(youtube.refreshChannel(), /no YouTube channel/);
    ok('an account with no YouTube channel is told clearly');

    // 4. Upload guard: a different channel on the token is refused before any upload starts.
    stubGoogle({ channels: [MOONHAND] });
    await youtube.refreshChannel();
    const video = path.join(DATA, 'video.mp4');
    fs.writeFileSync(video, Buffer.alloc(1024));
    const wrong = stubGoogle({ channels: [OTHER] });
    await assert.rejects(youtube.uploadVideo({ file: video, title: 't', description: 'd', tags: [], privacy: 'private', isShort: false }),
      /is now "Another Channel"/);
    assert(!wrong.some((c) => c.url.includes('uploadType=resumable'))); ok('upload is refused when the token belongs to a different channel, and nothing is sent');

    // 5. Same channel: the guard passes and the upload starts.
    const same = stubGoogle({ channels: [MOONHAND], uploadInitStatus: 500 });
    await assert.rejects(youtube.uploadVideo({ file: video, title: 't', description: 'd', tags: [], privacy: 'private', isShort: false }),
      /rejected the upload request/);
    assert(same.some((c) => c.url.includes('uploadType=resumable'))); ok('upload starts when the token belongs to the connected channel');

    // 6. An old connection record (no details) is refreshed once when the status is read.
    vault.set('YOUTUBE_TOKENS', JSON.stringify({ access_token: 'ya29.x', refresh_token: 'r', expires_at: Date.now() + 3600000, channel: { id: 'UCmoonhand123', title: 'Moonhand Facts' } }));
    stubGoogle({ channels: [MOONHAND] });
    const fresh = await youtube.statusFresh();
    assert.strictEqual(fresh.channel.url, 'https://www.youtube.com/@moonhandifacts');
    assert.strictEqual(fresh.channel.v, 2);
    ok('an older connection record gains the handle, URL and picture when the status is read');

    // 7. A failed refresh keeps the connection and reports the reason.
    vault.set('YOUTUBE_TOKENS', JSON.stringify({ access_token: 'ya29.x', refresh_token: 'r', expires_at: Date.now() + 3600000, channel: { id: 'UCmoonhand123', title: 'Moonhand Facts' } }));
    global.fetch = async () => reply(503, { error: { message: 'unavailable' } });
    const degraded = await youtube.statusFresh();
    assert.strictEqual(degraded.connected, true);
    assert(degraded.channelError);
    ok('a failed channel refresh keeps the connection and shows the reason');

    console.log(`\n${passed} YouTube channel checks passed`);
  } finally {
    global.fetch = realFetch;
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
