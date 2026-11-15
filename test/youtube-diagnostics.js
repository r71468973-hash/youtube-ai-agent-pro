'use strict';
/** Google API error reasons, scope checks and log hygiene, against a stubbed network (no real Google). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-diag-test-'));
process.env.DATA_DIR = DATA;
process.env.APP_SECRET = 'x'.repeat(32);
const vault = require('../lib/vault');
const youtube = require('../lib/youtube');

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
const realFetch = global.fetch;
const realErr = console.error;
const SCOPE_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
const SCOPE_READ = 'https://www.googleapis.com/auth/youtube.readonly';
const ALL_SCOPES = `${SCOPE_UPLOAD} ${SCOPE_READ}`;
const TOKEN = 'ya29.SECRET-ACCESS-TOKEN-123';
const REFRESH = '1//SECRET-REFRESH-TOKEN-456';
const CLIENT_SECRET = 'GOCSPX-diag-client-secret-789';
const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });

/** googleError builds the JSON Google sends for an API error. */
const googleError = (status, reason, message) => reply(status, {
  error: { code: status, message, status: status === 403 ? 'PERMISSION_DENIED' : 'RESOURCE_EXHAUSTED', errors: [{ message, domain: 'youtube.quota', reason }] },
});

/** stub: token endpoint returns the given scope; channels endpoint returns the given sequence of replies. */
function stub({ scope = ALL_SCOPES, channelReplies }) {
  const calls = [];
  const queue = [...channelReplies];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET' });
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      return reply(200, { access_token: TOKEN, refresh_token: REFRESH, expires_in: 3600, scope });
    }
    if (u.includes('/youtube/v3/channels')) {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return typeof next === 'function' ? next() : next;
    }
    return reply(500, { error: { message: 'unexpected call in test' } });
  };
  return calls;
}

const channelsCalls = (calls) => calls.filter((c) => c.url.includes('/youtube/v3/channels'));
const MOONHAND = { id: 'UCmoonhand123', snippet: { title: 'Moonhand Facts', customUrl: '@moonhandifacts', thumbnails: {} }, statistics: { subscriberCount: '10' } };

async function expectFailure(promise, pattern) {
  let caught = null;
  await assert.rejects(promise, (e) => { caught = e; return pattern.test(e.message); });
  return caught;
}

(async () => {
  try {
    vault.set('YOUTUBE_CLIENT_ID', 'client-id.apps.googleusercontent.com');
    vault.set('YOUTUBE_CLIENT_SECRET', CLIENT_SECRET);
    const logs = [];
    console.error = (...a) => { logs.push(a.map(String).join(' ')); };

    // 1. insufficientPermissions: the Google reason is named and the fix is "Reconnect".
    stub({ channelReplies: [googleError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.')] });
    const insuff = await expectFailure(youtube.handleCallback({ code: 'c', verifier: 'v' }), /HTTP 403, reason insufficientPermissions/);
    assert.strictEqual(insuff.google.reason, 'insufficientPermissions');
    assert.strictEqual(insuff.google.httpStatus, 403);
    assert(/Reconnect/.test(insuff.message));
    ok('insufficientPermissions names the reason and tells the user to reconnect with all permissions');

    // 2. accessNotConfigured: the enable link from Google's message is shown to the user.
    const enableUrl = 'https://console.developers.google.com/apis/api/youtube.googleapis.com/overview?project=123456';
    stub({ channelReplies: [googleError(403, 'accessNotConfigured', `YouTube Data API v3 has not been used in project 123456 before or it is disabled. Enable it by visiting ${enableUrl} then retry.`)] });
    const notCfg = await expectFailure(youtube.handleCallback({ code: 'c', verifier: 'v' }), /reason accessNotConfigured/);
    assert(notCfg.message.includes(enableUrl));
    assert.strictEqual(notCfg.google.reason, 'accessNotConfigured');
    ok('accessNotConfigured shows the exact enable link from Google');

    // 3. accessNotConfigured without a link in the message: the YouTube API library page is shown instead.
    stub({ channelReplies: [googleError(403, 'accessNotConfigured', 'Access Not Configured.')] });
    await expectFailure(youtube.handleCallback({ code: 'c', verifier: 'v' }), /console\.cloud\.google\.com\/apis\/library\/youtube\.googleapis\.com/);
    ok('accessNotConfigured without a link points to the YouTube Data API v3 library page');

    // 4. quotaExceeded: the reset time is stated, and there is no retry.
    const quotaCalls = stub({ channelReplies: [googleError(403, 'quotaExceeded', 'The request cannot be completed because you have exceeded your quota.')] });
    await expectFailure(youtube.handleCallback({ code: 'c', verifier: 'v' }), /midnight Pacific Time/);
    assert.strictEqual(channelsCalls(quotaCalls).length, 1);
    ok('quotaExceeded explains the reset at midnight Pacific Time and does not retry');

    // 5. rateLimitExceeded: one retry, then success with the real channel data.
    const rlCalls = stub({ channelReplies: [googleError(403, 'rateLimitExceeded', 'Rate Limit Exceeded'), reply(200, { items: [MOONHAND] })] });
    const retried = await youtube.handleCallback({ code: 'c', verifier: 'v' });
    assert.strictEqual(channelsCalls(rlCalls).length, 2);
    assert.strictEqual(retried.id, 'UCmoonhand123');
    ok('rateLimitExceeded is retried once and then succeeds');

    // 6. A rate limit that keeps failing stops after the second attempt.
    const rlStuck = stub({ channelReplies: [googleError(429, 'rateLimitExceeded', 'Rate Limit Exceeded')] });
    await expectFailure(youtube.handleCallback({ code: 'c', verifier: 'v' }), /slow down/);
    assert.strictEqual(channelsCalls(rlStuck).length, 2);
    ok('a rate limit that keeps failing gives up after two attempts');

    // 7. youtubeSignupRequired: the account has no channel, and the user is told how to fix it.
    stub({ channelReplies: [googleError(403, 'youtubeSignupRequired', 'The authenticated user account is not connected to YouTube.')] });
    await expectFailure(youtube.handleCallback({ code: 'c', verifier: 'v' }), /no YouTube channel/);
    ok('youtubeSignupRequired tells the user to create a channel and reconnect');

    // 8. Empty channel list: the account has no channel.
    stub({ channelReplies: [reply(200, { items: [] })] });
    await expectFailure(youtube.handleCallback({ code: 'c', verifier: 'v' }), /no YouTube channel/);
    ok('an empty channel list says the account has no YouTube channel');

    // 9. Missing scopes on the token: refused before any channels call, with the missing scope named.
    const noScope = stub({ scope: SCOPE_READ, channelReplies: [reply(200, { items: [MOONHAND] })] });
    const missing = await expectFailure(youtube.handleCallback({ code: 'c', verifier: 'v' }), /missing: youtube\.upload/);
    assert.deepStrictEqual(missing.google.missingScopes, [SCOPE_UPLOAD]);
    assert.strictEqual(channelsCalls(noScope).length, 0);
    ok('a token without the upload scope is refused before the channel is read, and the missing scope is named');

    // 10. All scopes granted: the channel is read, and the granted scopes are saved with the tokens.
    stub({ channelReplies: [reply(200, { items: [MOONHAND] })] });
    const good = await youtube.handleCallback({ code: 'c', verifier: 'v' });
    assert.strictEqual(good.id, 'UCmoonhand123');
    const saved = JSON.parse(vault.get('YOUTUBE_TOKENS'));
    assert.deepStrictEqual(saved.scopes, [SCOPE_UPLOAD, SCOPE_READ]);
    ok('with all scopes granted, the channel is read and the granted scopes are stored');

    // 11. Nothing secret appears in the logs, in error messages, or in the status.
    const everything = [...logs, JSON.stringify(youtube.status())];
    for (const e of [insuff, notCfg]) everything.push(e.message);
    for (const text of everything) {
      for (const secret of [TOKEN, REFRESH, CLIENT_SECRET]) assert(!String(text).includes(secret), 'a secret was printed');
    }
    assert(logs.some((l) => l.includes('[youtube]')), 'the Google error should be logged with a [youtube] prefix');
    ok('no access token, refresh token or client secret appears in logs, messages or status');

    console.error = realErr;
    console.log(`\n${passed} YouTube diagnostics checks passed`);
  } finally {
    console.error = realErr;
    global.fetch = realFetch;
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
