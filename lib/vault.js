'use strict';
/**
 * Secure API key management.
 *  - Secrets are encrypted at rest with AES-256-GCM.
 *  - The encryption key is derived (scrypt) from APP_SECRET. If APP_SECRET is not set,
 *    a random one is generated once and stored in data/.app_secret (mode 0600).
 *  - Secret values are never returned by the API; only a masked hint (last 4 chars).
 *  - Environment variables are used as a fallback when nothing is stored in the vault.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, KEY_NAMES } = require('./config');
const { ensureDir, writeJsonAtomic } = require('./util');

const VAULT_FILE = path.join(DATA_DIR, 'vault.json');
const SECRET_FILE = path.join(DATA_DIR, '.app_secret');

let masterKey = null;
let appSecretCache = null;

function appSecret() {
  if (appSecretCache) return appSecretCache;
  if (process.env.APP_SECRET) {
    if (process.env.APP_SECRET.length < 16) throw new Error('APP_SECRET must be at least 16 characters');
    appSecretCache = process.env.APP_SECRET;
    return appSecretCache;
  }
  ensureDir(DATA_DIR);
  if (fs.existsSync(SECRET_FILE)) {
    appSecretCache = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } else {
    appSecretCache = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, appSecretCache, { mode: 0o600 });
  }
  return appSecretCache;
}

function key() {
  if (!masterKey) masterKey = crypto.scryptSync(appSecret(), 'ai-video-vault-v1', 32);
  return masterKey;
}

/** Derived key for signing cookies etc. (separate from the encryption key). */
function signingKey() {
  return crypto.createHmac('sha256', key()).update('session-signing-v1').digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function decrypt(rec) {
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(rec.iv, 'base64'));
  d.setAuthTag(Buffer.from(rec.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(rec.ct, 'base64')), d.final()]).toString('utf8');
}

function load() {
  try { return JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')); } catch { return {}; }
}
function save(obj) {
  ensureDir(DATA_DIR);
  writeJsonAtomic(VAULT_FILE, obj);
}

const INTERNAL = new Set(['YOUTUBE_TOKENS']); // not user-editable through the keys API

function get(name) {
  const rec = load()[name];
  if (rec) {
    try { return decrypt(rec); } catch { /* wrong APP_SECRET or corrupted: fall through */ }
  }
  if (KEY_NAMES.includes(name) && process.env[name]) return process.env[name];
  return null;
}

function set(name, value) {
  if (!KEY_NAMES.includes(name) && !INTERNAL.has(name)) throw new Error('Unknown key name');
  const v = String(value);
  if (!v || v.length > 8192) throw new Error('Invalid value');
  const all = load();
  all[name] = { ...encrypt(v), updatedAt: new Date().toISOString(), hint: v.length > 8 ? v.slice(-4) : '' };
  save(all);
}

function remove(name) {
  const all = load();
  delete all[name];
  save(all);
}

/** Safe listing: never includes values. */
function list() {
  const all = load();
  return KEY_NAMES.map((name) => {
    const rec = all[name];
    const fromEnv = !rec && !!process.env[name];
    return {
      name,
      configured: !!rec || fromEnv,
      source: rec ? 'vault' : fromEnv ? 'env' : null,
      hint: rec && rec.hint ? `••••${rec.hint}` : rec || fromEnv ? '••••' : '',
      updatedAt: rec ? rec.updatedAt : null,
    };
  });
}

module.exports = { get, set, remove, list, signingKey, has: (n) => !!get(n) };
