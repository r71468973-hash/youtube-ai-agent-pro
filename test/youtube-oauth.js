'use strict';
/** Google OAuth setup and error handling, against a stubbed token endpoint (no real Google). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-oauth-test-'));
process.env.DATA_DIR = DATA;
process.env.APP_SECRET = 'x'.repeat(32);
process.env.BASE_URL = 'https://studio.example.up.railway.app';
for (const k of ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET']) delete process.env[k];

const youtube = require('../lib/youtube');
const vault = require('../lib/vault');

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };
const realFetch = global.fetch;
const SECRET = 'GOCSPX-test-client-secret-42';
const CLIENT = '123456-abc.apps.googleusercontent.com';

(async () => {
  try {
    // 1. Nothing configured: a clear message names the two variables.
    assert.strictEqual(youtube.isConfigured(), false);
    assert.throws(() => youtube.authUrl(), /YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET/);
    assert.strictEqual(youtube.status().credentialsFrom, null);
    ok('without credentials, connecting explains which variables to set');

    // 2. Railway environment variables are used, and the redirect URI matches the public address.
    process.env.YOUTUBE_CLIENT_ID = CLIENT;
    process.env.YOUTUBE_CLIENT_SECRET = SECRET;
    assert.strictEqual(youtube.isConfigured(), true);
    assert.strictEqual(youtube.status().credentialsFrom, 'environment');
    const a = youtube.authUrl();
    const q = new URL(a.url).searchParams;
    assert.strictEqual(q.get('client_id'), CLIENT);
    assert.strictEqual(q.get('redirect_uri'), 'https://studio.example.up.railway.app/auth/google/callback');
    assert.strictEqual(q.get('access_type'), 'offline');
    assert.strictEqual(q.get('code_challenge_method'), 'S256');
    assert(q.get('scope').includes('youtube.upload'));
    ok('environment credentials are used; redirect URI is the Railway callback address; PKCE and offline access set');

    // 3. The client secret never appears in the browser-facing status or the authorization URL.
    assert(!JSON.stringify(youtube.status()).includes(SECRET));
    assert(!a.url.includes(SECRET));
    ok('the client secret is absent from the status output and the sign-in URL');

    // 4. Settings fallback works when the variables are not set.
    delete process.env.YOUTUBE_CLIENT_ID;
    delete process.env.YOUTUBE_CLIENT_SECRET;
    vault.set('YOUTUBE_CLIENT_ID', 'settings-client.apps.googleusercontent.com');
    vault.set('YOUTUBE_CLIENT_SECRET', 'settings-secret-value');
    assert.strictEqual(youtube.status().credentialsFrom, 'settings');
    assert.strictEqual(new URL(youtube.authUrl().url).searchParams.get('client_id'), 'settings-client.apps.googleusercontent.com');
    ok('Settings credentials are used when the Railway variables are not set');
    process.env.YOUTUBE_CLIENT_ID = CLIENT;
    process.env.YOUTUBE_CLIENT_SECRET = SECRET;

    // 5. Google's error codes come back as plain instructions.
    assert(youtube.oauthErrorMessage('redirect_uri_mismatch').includes('https://studio.example.up.railway.app/auth/google/callback'));
    assert(/client ID or client secret/.test(youtube.oauthErrorMessage('invalid_client')));
    assert(/Test users/.test(youtube.oauthErrorMessage('access_blocked')));
    assert(/not grant/.test(youtube.oauthErrorMessage('access_denied')) || /not granted/.test(youtube.oauthErrorMessage('access_denied')));
    assert.strictEqual(youtube.oauthErrorMessage('some_new_code', 'details here'), 'Google: details here');
    ok('known Google error codes get a fix; unknown ones are shown as Google reported them');

    // 6. Token exchange with bad credentials: the user sees the fix, and the secret is not in the message.
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_client', error_description: `Unauthorized for ${SECRET}` }) });
    await assert.rejects(youtube.handleCallback({ code: 'c', verifier: 'v' }), (e) => {
      assert(/client ID or client secret/.test(e.message));
      assert(!e.message.includes(SECRET));
      return true;
    });
    ok('a rejected client shows the fix, and the secret is scrubbed from the message');

    // 7. A redirect mismatch names the exact address to register.
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'redirect_uri_mismatch' }) });
    await assert.rejects(youtube.handleCallback({ code: 'c', verifier: 'v' }), /Authorized redirect URI.*auth\/google\/callback/);
    ok('a redirect mismatch names the exact callback address to register');

    console.log(`\n${passed} YouTube OAuth checks passed`);
  } finally {
    global.fetch = realFetch;
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
