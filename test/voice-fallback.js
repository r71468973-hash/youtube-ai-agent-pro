'use strict';
// OpenAI voice switch-off on 429/402, using a fake fetch. No network, no charges, no real key.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));
const vault = require('../lib/vault');
const store = require('../lib/store');
const providers = require('../lib/providers');

const ok = (m) => console.log(`  ok  ${m}`);
const realFetch = global.fetch;
let calls = 0;
const fakeOpenAi = (status) => async (url) => {
  if (!String(url).includes('api.openai.com')) throw new Error('unexpected network call in test: ' + url);
  calls++;
  return { ok: false, status, text: async () => 'rate limited' };
};

(async () => {
  console.log('voice fallback checks');
  vault.set('OPENAI_API_KEY', 'sk-test-fake-value-for-tests');
  store.setSettings({ ttsProvider: 'openai', openaiTtsDisabledReason: null, openaiTtsDisabledAt: null });

  // 1. A 429 from OpenAI is reported and switches OpenAI off.
  global.fetch = fakeOpenAi(429);
  await assert.rejects(providers.synthesize({ provider: 'openai', text: 'नमस्ते', language: 'hi', gender: 'male' }), /HTTP 429/);
  assert.ok(store.getSettings().openaiTtsDisabledReason, 'reason saved');
  assert.ok(store.getSettings().openaiTtsDisabledAt, 'time saved');
  ok('HTTP 429 from OpenAI switches OpenAI TTS off and records why');

  // 2. Once off, OpenAI is not called again and is not picked for voice.
  const before = calls;
  await assert.rejects(providers.synthesize({ provider: 'openai', text: 'नमस्ते', language: 'hi', gender: 'male' }), /turned off|credits or rate limit/);
  assert.strictEqual(calls, before, 'no request while switched off');
  ok('no OpenAI request is made while it is switched off');
  assert.notStrictEqual(providers.pickTtsProvider('hi'), 'openai');
  ok('automatic voice choice skips OpenAI while it is switched off');

  // 3. A 402 (payment needed) switches it off too.
  store.setSettings({ openaiTtsDisabledReason: null, openaiTtsDisabledAt: null });
  global.fetch = fakeOpenAi(402);
  await assert.rejects(providers.synthesize({ provider: 'openai', text: 'नमस्ते', language: 'hi', gender: 'male' }), /HTTP 402/);
  assert.ok(store.getSettings().openaiTtsDisabledReason);
  ok('HTTP 402 from OpenAI also switches it off');

  // 4. Other errors (for example a 500) do not switch it off.
  store.setSettings({ openaiTtsDisabledReason: null, openaiTtsDisabledAt: null });
  global.fetch = fakeOpenAi(500);
  await assert.rejects(providers.synthesize({ provider: 'openai', text: 'नमस्ते', language: 'hi', gender: 'male' }), /HTTP 500/);
  assert.strictEqual(store.getSettings().openaiTtsDisabledReason, null);
  ok('a server error (500) does not switch OpenAI off');

  global.fetch = realFetch;
  console.log('\n4 voice fallback checks passed');
})().catch((e) => { global.fetch = realFetch; console.error('FAILED:', e.message); process.exit(1); });
