'use strict';
/**
 * Persistent spend ledger for paid Gemini video calls.
 *
 * Every paid clip is recorded in a JSON file BEFORE its request is sent:
 *   reserved  -> request sent, result not yet saved (a crash here leaves it reserved: never re-sent automatically)
 *   done      -> clip saved to disk (never generated again for the same key)
 *   failed    -> request failed after it was sent (counted as spent; re-sent only with an explicit retry approval)
 *
 * The total of all entries (reserved, done and failed) is checked against MAX_TOTAL_SPEND_USD, so a restart
 * cannot reset the spend. If the ledger file cannot be read, spending is blocked, never assumed to be zero.
 *
 * Errors thrown here are plain Error objects with a `code`; gemini-video.js turns them into GeminiVideoError.
 */
const fs = require('fs');
const path = require('path');

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function load(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { entries: {} };
    throw fail('ledger_unreadable', 'The Gemini spend ledger cannot be read, so paid generation is blocked until it is fixed.');
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw fail('ledger_unreadable', 'The Gemini spend ledger is damaged, so paid generation is blocked until it is fixed.');
  }
  if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
    throw fail('ledger_unreadable', 'The Gemini spend ledger has an unexpected format, so paid generation is blocked.');
  }
  return data;
}

// Write to a temp file, then rename, so a crash never leaves a half-written ledger.
function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function totalUsd(file) {
  const data = load(file);
  return Object.values(data.entries).reduce((a, e) => a + (Number(e.usd) || 0), 0);
}

/**
 * Records a reservation for `key` costing `usd`. Throws before anything is spent when:
 *  - the key already has a reservation or a finished clip (duplicate charge),
 *  - the key failed earlier and no explicit retry was approved,
 *  - the total would go over capUsd.
 */
function reserve(file, key, usd, capUsd, { allowRetry = false } = {}) {
  const data = load(file);
  const prev = data.entries[key];
  if (prev) {
    if (prev.status === 'done') throw fail('already_generated', `This clip (${key}) was already generated and saved. It will not be paid for again.`);
    if (prev.status === 'reserved') throw fail('duplicate_pending', `This clip (${key}) has a request that never finished. It will not be sent again automatically. Check the ledger first.`);
    if (prev.status === 'failed' && !allowRetry) throw fail('previous_failure', `This clip (${key}) failed earlier. A new paid request needs an explicit retry approval.`);
  }
  const total = Object.entries(data.entries)
    .filter(([k]) => k !== key) // a failed key being retried replaces its own old amount
    .reduce((a, [, e]) => a + (Number(e.usd) || 0), 0);
  if (total + usd > capUsd + 0.00001) {
    throw fail('spend_limit', `This clip would take the total paid spend to ${(total + usd).toFixed(2)} USD, above the limit of ${capUsd.toFixed(2)} USD (MAX_TOTAL_SPEND_USD).`);
  }
  data.entries[key] = { usd, status: 'reserved', at: new Date().toISOString() };
  save(file, data);
}

/** Marks a reservation as 'done' (saved) or 'failed' (request failed after it was sent). */
function settle(file, key, status) {
  if (status !== 'done' && status !== 'failed') throw fail('bad_status', `Unknown ledger status ${status}.`);
  const data = load(file);
  if (!data.entries[key]) throw fail('no_reservation', `No reservation found for ${key}.`);
  data.entries[key].status = status;
  data.entries[key].at = new Date().toISOString();
  save(file, data);
}

function statusOf(file, key) {
  const e = load(file).entries[key];
  return e ? e.status : null;
}

module.exports = { reserve, settle, totalUsd, statusOf, load };
