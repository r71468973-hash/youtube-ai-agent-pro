'use strict';
/**
 * Read-only readiness check. Prints whether each required setting is present, and where it comes from
 * (environment or the encrypted Settings vault). It never prints a value and makes no network calls.
 * Usage: node scripts/check-config.js
 */
const vault = require('../lib/vault');
const characterRefs = require('../lib/character-refs');
const { DATA_DIR } = require('../lib/config');
const fs = require('fs');
const path = require('path');

function where(names) {
  const out = {};
  for (const n of names) {
    if ((process.env[n] || '').trim()) out[n] = 'environment';
    else if (safeVault(n)) out[n] = 'settings';
    else out[n] = 'MISSING';
  }
  return out;
}

function safeVault(name) {
  try { return !!(vault.get(name) || '').trim(); } catch (e) { return false; }
}

function line(label, status) {
  console.log(`  ${label.padEnd(28)} ${status}`);
}

const groups = {
  'Gemini (paid video)': ['GEMINI_API_KEY'],
  'Cloudflare R2 (storage)': ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL'],
  'YouTube OAuth': ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_TOKENS'],
};

console.log('Configuration readiness (values are never shown)');
for (const [title, names] of Object.entries(groups)) {
  console.log(title + ':');
  const found = where(names);
  for (const n of names) line(n, found[n]);
}

// R2 also accepts R2_ENDPOINT in place of R2_ACCOUNT_ID, and the Settings S3 names as fallback.
const r2Endpoint = (process.env.R2_ENDPOINT || '').trim() ? 'environment' : 'not set';
console.log(`  R2_ENDPOINT (alternative to ACCOUNT_ID) ${r2Endpoint}`);
const r2Fallback = safeVault('S3_ACCESS_KEY_ID') && safeVault('S3_SECRET_ACCESS_KEY');
console.log(`  S3_* keys in Settings (fallback)  ${r2Fallback ? 'present' : 'not set'}`);

const refs = characterRefs.listRefs(path.join(DATA_DIR, 'character-refs'));
console.log(`Character reference images: ${refs.length} saved (${refs.map((r) => r.name).join(', ') || 'none'})`);

const ledgerFile = path.join(DATA_DIR, 'gemini-ledger.json');
console.log(`Gemini spend ledger: ${fs.existsSync(ledgerFile) ? 'exists' : 'not created yet'}`);
