'use strict';
/**
 * "Test" button for saved API keys. Each check is one free, read-only request (a model or account listing),
 * so testing never spends money. The key is sent only in a request header and is never returned or logged.
 */

const TIMEOUT_MS = 15000;

const CHECKS = {
  GEMINI_API_KEY: {
    label: 'Google Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    headers: (k) => ({ 'x-goog-api-key': k }),
  },
  REPLICATE_API_TOKEN: {
    label: 'Replicate',
    url: 'https://api.replicate.com/v1/account',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  OPENAI_API_KEY: {
    label: 'OpenAI',
    url: 'https://api.openai.com/v1/models',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  ANTHROPIC_API_KEY: {
    label: 'Anthropic',
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
  },
  ELEVENLABS_API_KEY: {
    label: 'ElevenLabs',
    url: 'https://api.elevenlabs.io/v1/user',
    headers: (k) => ({ 'xi-api-key': k }),
  },
};

/** Returns { ok, message }. Never includes the key in the message. */
async function testKey(name, getValue, fetchImpl = fetch) {
  const check = CHECKS[name];
  if (!check) return { ok: false, message: 'There is no free test for this key. Save it and use the feature to confirm it works.' };
  const key = getValue(name);
  if (!key) return { ok: false, message: 'No value is saved for this key yet.' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(check.url, { method: 'GET', headers: check.headers(key), signal: ctl.signal });
    if (res.ok) return { ok: true, message: 'Connected. The key works.' };
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'The service rejected this key. Check it and save it again.' };
    if (res.status === 429) return { ok: false, message: 'Rate limit reached. Try again in a minute.' };
    return { ok: false, message: `${check.label} answered with an error (${res.status}). Try again later.` };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, message: `${check.label} did not answer within 15 seconds.` };
    return { ok: false, message: `Could not reach ${check.label}. Check the server's internet access.` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { testKey, CHECKS };
