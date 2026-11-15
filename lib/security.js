'use strict';
/**
 * Security events and request limits.
 *  - Events go to data/security.log (JSON lines, owner-only file) and to the console. Passwords, tokens,
 *    keys and cookies are never recorded: any field whose name looks like a secret is dropped.
 *  - Limits are simple sliding-window counters kept in memory (one process).
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { ensureDir } = require('./util');

const LOG_FILE = path.join(DATA_DIR, 'security.log');
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_LOG_LINES = 2000;
const SECRET_FIELD = /password|token|secret|key|authorization|cookie|csrf|verifier|code/i;

function event(type, details = {}) {
  const rec = { at: new Date().toISOString(), type };
  for (const [k, v] of Object.entries(details)) {
    if (SECRET_FIELD.test(k)) continue;
    rec[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  const line = JSON.stringify(rec);
  console.log(`[security] ${line}`);
  try {
    ensureDir(DATA_DIR);
    fs.appendFileSync(LOG_FILE, `${line}\n`, { mode: 0o600 });
    if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      const kept = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-MAX_LOG_LINES);
      fs.writeFileSync(`${LOG_FILE}.tmp`, `${kept.join('\n')}\n`, { mode: 0o600 });
      fs.renameSync(`${LOG_FILE}.tmp`, LOG_FILE);
    }
  } catch { /* the console line above still records the event */ }
  return rec;
}

/** The most recent events, newest last. Unreadable lines are skipped. */
function recent(n = 100) {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-n)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * The client address. Behind Railway's proxy the socket address is the proxy itself, so the address
 * is taken from X-Forwarded-For, using the last entry (the one the edge proxy adds). Only used when
 * running behind that proxy, so a direct client cannot pick its own address.
 */
function clientIp(req) {
  const behindProxy = process.env.TRUST_PROXY === '1' || !!process.env.RAILWAY_PROJECT_ID || !!process.env.RAILWAY_ENVIRONMENT_NAME;
  if (behindProxy) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

const buckets = new Map();
/** True when `key` has used more than `limit` requests in the last `windowMs`. */
function overLimit(key, limit, windowMs) {
  const now = Date.now();
  if (buckets.size > 10000) buckets.clear(); // bounded memory; a cleared window only makes limits briefly looser
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(key, hits);
  return hits.length > limit;
}

module.exports = { event, recent, clientIp, overLimit, LOG_FILE };
