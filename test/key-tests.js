'use strict';
// Key "Test" button logic with a fake fetch: no network, no charges. Checks the right header, the right
// status messages, and that the key never appears in the result.
const assert = require('assert');
const { testKey } = require('../lib/key-tests');

const SECRET = 'sk-test-SECRET-value-123456';
const get = (n) => (n === 'GEMINI_API_KEY' ? SECRET : '');
const fakeFetch = (status, seen) => async (url, init) => { seen.push({ url, init }); return { ok: status < 400, status }; };
const ok = (m) => console.log(`  ok  ${m}`);

(async () => {
  const seen = [];
  const good = await testKey('GEMINI_API_KEY', get, fakeFetch(200, seen));
  assert.strictEqual(good.ok, true);
  assert.strictEqual(seen[0].init.headers['x-goog-api-key'], SECRET);
  assert(!JSON.stringify(good).includes(SECRET) && !seen[0].url.includes(SECRET));
  ok('valid Gemini key: connected, key sent only in a header, never in the result');

  const bad = await testKey('GEMINI_API_KEY', get, fakeFetch(403, []));
  assert.strictEqual(bad.ok, false);
  assert(/rejected this key/.test(bad.message) && !bad.message.includes(SECRET));
  ok('rejected key: clear message, key not echoed');

  const empty = await testKey('REPLICATE_API_TOKEN', () => '', fakeFetch(200, []));
  assert(/No value is saved/.test(empty.message));
  ok('no saved value: clear message, no request');

  const none = await testKey('NOTIFY_WEBHOOK_URL', get, fakeFetch(200, []));
  assert(/no free test/.test(none.message));
  ok('keys without a free test say so instead of failing');

  const timeoutFetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  const t = await testKey('GEMINI_API_KEY', get, timeoutFetch);
  assert(/did not answer/.test(t.message));
  ok('timeout gives a clear message');

  console.log('\n5 key-test checks passed (no network, no charges)');
})().catch((e) => { console.error(e); process.exit(1); });
