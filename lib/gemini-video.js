'use strict';
/**
 * Gemini Omni 1.2 Flash video generation (official Gemini API, interactions endpoint).
 *
 * Sources used for the request shape:
 *   https://aistudio.google.com/docs/omni  (model ID, endpoint, request fields, async download flow)
 *   https://blog.google/.../introducing-gemini-omni-1-2-flash/  (3–15 s clips, 360p/720p/1080p/4k, $0.07/s at 720p)
 *
 * Safety rules built in:
 *  - GEMINI_API_KEY is read from the environment only and is never logged or returned.
 *  - No paid request is made unless the caller passes approvedUsd equal to the estimate.
 *  - MAX_SPEND_USD caps any single generation (default 1.00 USD).
 *  - Retries are limited (default 2) and only for rate limits, server errors and timeouts.
 */
const fs = require('fs');

const MODEL_ID = 'gemini-omni-1.2-flash';
const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const FILES_BASE = 'https://generativelanguage.googleapis.com/v1beta/';
const ASPECTS = ['9:16', '16:9'];
const RESOLUTIONS = ['360p', '720p', '1080p', '4k'];
const MIN_SEC = 3;
const MAX_SEC = 15;

// Price per generated second in USD. Only 720p is stated on Google's blog; the pricing page did not show Omni yet,
// so other resolutions are refused until a verified price is added here.
const PRICE_PER_SEC_USD = { '720p': 0.07 };

class GeminiVideoError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'GeminiVideoError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Reads the key from the environment. Returns '' when missing; never logs it. */
function apiKey(env = process.env) {
  return (env.GEMINI_API_KEY || '').trim();
}

function configStatus(env = process.env) {
  if (!apiKey(env)) {
    return { ok: false, message: 'GEMINI_API_KEY is not set. Add it in Railway → youtube-ai-agent-pro → Variables, then redeploy.' };
  }
  return { ok: true, message: 'GEMINI_API_KEY is set.' };
}

// Total paid spend recorded by this process. A request is refused if it would push the total over MAX_TOTAL_SPEND_USD.
const ledger = { spentUsd: 0, requests: 0 };
function totalCapUsd(env = process.env) {
  const v = Number(env.MAX_TOTAL_SPEND_USD);
  return Number.isFinite(v) && v > 0 ? v : 1.0;
}
function resetLedger() { ledger.spentUsd = 0; ledger.requests = 0; }

function maxSpendUsd(env = process.env) {
  const v = Number(env.MAX_SPEND_USD);
  return Number.isFinite(v) && v > 0 ? v : 1.0;
}

/** Cost of one clip. Throws if the resolution has no verified price. */
function estimateCost({ duration, resolution = '720p' }) {
  if (!Number.isInteger(duration) || duration < MIN_SEC || duration > MAX_SEC) {
    throw new GeminiVideoError('invalid_duration', `Clip length must be a whole number of seconds from ${MIN_SEC} to ${MAX_SEC}.`);
  }
  const price = PRICE_PER_SEC_USD[resolution];
  if (price === undefined) {
    throw new GeminiVideoError('unverified_price', `No verified price for ${resolution} yet. Use 720p, or add the official price first.`);
  }
  return { seconds: duration, resolution, pricePerSecondUsd: price, usd: Math.round(duration * price * 100) / 100 };
}

/** Checks the spending limit and the approval, both before any network call. */
function assertCanSpend(estimate, { approvedUsd }, env = process.env) {
  const cap = maxSpendUsd(env);
  if (estimate.usd > cap) {
    throw new GeminiVideoError('spend_limit', `Estimated cost ${estimate.usd.toFixed(2)} USD is above the limit of ${cap.toFixed(2)} USD (MAX_SPEND_USD).`);
  }
  const total = totalCapUsd(env);
  if (ledger.spentUsd + estimate.usd > total + 0.00001) {
    throw new GeminiVideoError('spend_limit', `This clip would take the total paid spend to ${(ledger.spentUsd + estimate.usd).toFixed(2)} USD, above the limit of ${total.toFixed(2)} USD (MAX_TOTAL_SPEND_USD).`);
  }
  if (approvedUsd === undefined || Math.abs(Number(approvedUsd) - estimate.usd) > 0.005) {
    throw new GeminiVideoError('approval_required',
      `Paid generation needs your approval. This clip is estimated at ${estimate.usd.toFixed(2)} USD. Approve that exact amount to continue.`);
  }
}

/** Builds the request body for the interactions endpoint. Pure: no network. */
function buildRequest({ prompt, imageBase64, imageMime, aspectRatio = '16:9', resolution = '720p', duration = 5, task }) {
  if (!prompt || !String(prompt).trim()) throw new GeminiVideoError('invalid_prompt', 'The scene prompt is empty.');
  if (!ASPECTS.includes(aspectRatio)) throw new GeminiVideoError('invalid_aspect', `Aspect ratio must be one of ${ASPECTS.join(', ')}.`);
  if (!RESOLUTIONS.includes(resolution)) throw new GeminiVideoError('invalid_resolution', `Resolution must be one of ${RESOLUTIONS.join(', ')}.`);
  estimateCost({ duration, resolution }); // validates duration and price

  const text = { type: 'text', text: String(prompt) };
  let input;
  if (imageBase64) {
    input = [text, { type: 'image', data: imageBase64, mime_type: imageMime || 'image/jpeg' }];
  } else {
    input = String(prompt);
  }
  const body = {
    model: MODEL_ID,
    input,
    response_format: { type: 'video', aspect_ratio: aspectRatio, resolution, duration: `${duration}s`, delivery: 'uri' },
  };
  if (task) {
    if (!['text_to_video', 'image_to_video'].includes(task)) throw new GeminiVideoError('invalid_task', `Unknown task ${task}.`);
    body.generation_config = { video_config: { task } };
  }
  return body;
}

function mapHttpError(status, detail) {
  const msg = String(detail || '');
  if (status === 401 || (status === 403 && /api key|permission|unauthori[sz]ed/i.test(msg))) {
    return new GeminiVideoError('invalid_key', 'Gemini rejected the API key. Check GEMINI_API_KEY in Railway.');
  }
  if (status === 402 || (status === 403 && /billing|balance|payment|quota exceeded/i.test(msg))) {
    return new GeminiVideoError('billing', 'Insufficient billing balance on the Gemini account. Add credit, then retry.');
  }
  if (status === 404 || /model/i.test(msg) && status === 400) {
    return new GeminiVideoError('unsupported_model', `The model ${MODEL_ID} was not found or does not support this request.`);
  }
  if (status === 429) return new GeminiVideoError('rate_limit', 'Gemini rate limit reached. Retrying later.', { retryable: true });
  if (status >= 500) return new GeminiVideoError('server', `Gemini server error (${status}). Retrying.`, { retryable: true });
  return new GeminiVideoError('request_failed', `Gemini request failed (${status}).`);
}

async function withTimeout(fetchImpl, url, init, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new GeminiVideoError('timeout', 'Gemini did not respond in time.', { retryable: true });
    throw new GeminiVideoError('network', 'Could not reach the Gemini API.', { retryable: true });
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Finds the first "uri" value that points at a Gemini file in the response. */
function findFileUri(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.uri === 'string' && /files\/[A-Za-z0-9_-]+/.test(obj.uri)) return obj.uri;
  for (const v of Object.values(obj)) {
    const found = findFileUri(v);
    if (found) return found;
  }
  return null;
}

/** Finds inline base64 video data in a response (used when the API returns the bytes directly). */
function findInlineVideo(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.data === 'string' && obj.data.length > 1000 && (obj.mime_type === 'video/mp4' || obj.mimeType === 'video/mp4')) return obj.data;
  for (const v of Object.values(obj)) {
    const found = findInlineVideo(v);
    if (found) return found;
  }
  return null;
}

/**
 * Generates one clip and writes it to outFile. Returns { file, seconds, usd }.
 * opts.fetchImpl is for tests; production uses the global fetch.
 */
async function generateClip(opts, env = process.env) {
  const { outFile, approvedUsd, fetchImpl = fetch, timeoutMs = 240000, maxRetries = 2 } = opts;
  // Checked before any network call: a refused request costs nothing.
  const key = apiKey(env);
  if (!key) throw new GeminiVideoError('missing_key', configStatus(env).message);
  const estimate = estimateCost({ duration: opts.duration, resolution: opts.resolution || '720p' });
  assertCanSpend(estimate, { approvedUsd }, env);
  const body = buildRequest(opts);
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': key };
  // Recorded before the request is sent, so a retry or a crash can never be forgotten.
  ledger.spentUsd += estimate.usd;
  ledger.requests += 1;

  let response = null;
  let lastErr = null;
  for (let attempt = 0; attempt <= Math.min(maxRetries, 3); attempt++) {
    try {
      const res = await withTimeout(fetchImpl, INTERACTIONS_URL, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw mapHttpError(res.status, detail.slice(0, 300));
      }
      response = await res.json();
      break;
    } catch (e) {
      lastErr = e instanceof GeminiVideoError ? e : new GeminiVideoError('unknown', 'Unexpected error calling Gemini.');
      // Only a rate limit is retried: it is refused before any generation, so it is not billed.
      if (lastErr.code !== 'rate_limit' || attempt === Math.min(maxRetries, 3)) throw lastErr;
      await sleep(2000 * 2 ** attempt);
    }
  }

  let bytes = null;
  const inline = findInlineVideo(response);
  if (inline) {
    bytes = Buffer.from(inline, 'base64');
  } else {
    const uri = findFileUri(response);
    if (!uri) throw new GeminiVideoError('no_output', 'Gemini returned no video file. Nothing was saved.');
    const id = uri.match(/files\/([A-Za-z0-9_-]+)/)[1];
    await waitForFile(id, { fetchImpl, headers: { 'x-goog-api-key': key }, timeoutMs });
    const dl = await withTimeout(fetchImpl, `${FILES_BASE}files/${id}:download?alt=media`, { headers: { 'x-goog-api-key': key } }, timeoutMs);
    if (!dl.ok) throw mapHttpError(dl.status, '');
    bytes = Buffer.from(await dl.arrayBuffer());
  }
  if (!bytes || bytes.length < 1000) throw new GeminiVideoError('no_output', 'The downloaded video is empty or too small.');
  fs.writeFileSync(outFile, bytes);
  return { file: outFile, seconds: estimate.seconds, usd: estimate.usd };
}

/** Polls the Files API until the output is ACTIVE. Throws on FAILED or timeout. */
async function waitForFile(id, { fetchImpl, headers, timeoutMs, intervalMs = 5000, maxWaitMs = 600000 }) {
  const start = Date.now();
  for (;;) {
    const res = await withTimeout(fetchImpl, `${FILES_BASE}files/${id}`, { headers }, timeoutMs);
    if (!res.ok) throw mapHttpError(res.status, '');
    const meta = await res.json();
    const state = (meta.state || (meta.file && meta.file.state) || '').toString().toUpperCase();
    if (state === 'ACTIVE' || state === 'STATE_ACTIVE') return;
    if (state === 'FAILED' || state === 'STATE_FAILED') throw new GeminiVideoError('generation_failed', 'Gemini could not generate this video. Try a different prompt.');
    if (Date.now() - start > maxWaitMs) throw new GeminiVideoError('timeout', 'Video generation took too long and was stopped.', { retryable: true });
    await sleep(intervalMs);
  }
}

const STYLE = 'Professional hand-drawn 2D cartoon animation, clean outlines, smooth shading, colourful background. Not photorealistic, not 3D, not a slideshow. Real motion: the characters move, blink and talk.';

/** Prompt for one scene. Pure: no network. Keeps every character\'s look fixed in each clip. */
function buildScenePrompt({ narration, setting, time, characters = [], shot = 'medium' }) {
  const cast = characters.map((c) => `${c.name}: ${c.description}`).join('; ');
  return [
    STYLE,
    `Scene: ${narration}`,
    setting ? `Location: ${setting} (Indian village setting).` : '',
    time ? `Time of day: ${time}.` : '',
    cast ? `Characters, keep identical in every scene: ${cast}.` : '',
    `Camera: ${shot} shot with a smooth cinematic movement.`,
  ].filter(Boolean).join(' ');
}

module.exports = {
  MODEL_ID, INTERACTIONS_URL, PRICE_PER_SEC_USD, GeminiVideoError, STYLE,
  configStatus, maxSpendUsd, totalCapUsd, estimateCost, assertCanSpend, buildRequest, buildScenePrompt,
  generateClip, findFileUri, findInlineVideo, ledger, resetLedger,
};
