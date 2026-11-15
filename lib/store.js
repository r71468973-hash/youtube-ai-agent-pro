'use strict';
/** Tiny JSON-file database (single process). Atomic writes, no external dependencies. */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { ensureDir, writeJsonAtomic } = require('./util');
const vault = require('./vault');

const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_SETTINGS = {
  ttsProvider: 'auto', // auto | openai | elevenlabs | google | none
  imageMode: 'gradient', // gradient | ai (needs OpenAI key)
  elevenVoiceFemale: 'EXAVITQu4vr4xnSDxMaL',
  elevenVoiceMale: 'JBFqnCBsd6RMkjVDRZzb',
  openaiTtsModel: 'gpt-4o-mini-tts',
  animationProvider: 'local-3d', // local-3d (free, default) | external-http (paid, optional)
  animationEndpoint: '', // external-http only: job endpoint, see lib/animation/external.js
  dailyEnabled: false, // daily job: one new story video per day, waiting for your approval (off by default)
  dailyHour: 9, // hour of the day in India time when the daily video is made
  dailyAutoUpload: false, // when on, each finished daily video is uploaded to YouTube (PRIVATE unless dailyPublic is on)
  dailyPublic: false, // when on AND consented, each daily video becomes public on YouTube at dailyPublishHour:dailyPublishMinute (India time)
  dailyPublicConsentAt: null, // the one-time consent for public daily videos, with its time
  dailyPublishHour: 18, // India time hour when the daily video becomes public (if dailyPublic)
  dailyPublishMinute: 30,
  markSyntheticMedia: true,
  keepLocalCopy: true,
  storage: { endpoint: '', region: 'auto', bucket: '', prefix: 'videos/', pathStyle: true },
};

let db = null;
let legacyPlaintext = false;
const ENC_MARK = 'aiv-db-enc-v1';

/**
 * Reads the database file. The file is encrypted at rest (AES-256-GCM with the vault key).
 * A file that exists but cannot be read is an error: the app stops rather than starting empty,
 * because saving an empty database would overwrite the real one.
 */
function readDb() {
  if (!fs.existsSync(DB_FILE)) return {};
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('data/db.json is unreadable. Nothing was changed. Restore the file before starting.'); }
  if (parsed && parsed[ENC_MARK]) {
    try { return JSON.parse(vault.decryptText(parsed[ENC_MARK])); } catch { throw new Error('data/db.json cannot be decrypted. APP_SECRET may have changed. Nothing was changed.'); }
  }
  legacyPlaintext = true; // written before encryption at rest: encrypted on the next save
  return parsed || {};
}

function load() {
  if (db) return db;
  ensureDir(DATA_DIR);
  db = readDb();
  db.videos = db.videos || {};
  db.music = db.music || {};
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}), storage: { ...DEFAULT_SETTINGS.storage, ...((db.settings || {}).storage || {}) } };
  return db;
}
function flush() { writeJsonAtomic(DB_FILE, { [ENC_MARK]: vault.encryptText(JSON.stringify(db)) }); }

module.exports = {
  init() {
    load();
    if (legacyPlaintext) { flush(); legacyPlaintext = false; } // migrate a plaintext database to encrypted
    // Jobs interrupted by a restart cannot resume; mark them failed so the UI is honest.
    let dirty = false;
    for (const v of Object.values(db.videos)) {
      if (['queued', 'generating', 'uploading'].includes(v.status)) {
        v.status = v.status === 'uploading' ? 'approved' : 'failed';
        v.error = 'Interrupted by a server restart. Please retry.';
        dirty = true;
      }
    }
    if (dirty) flush();
  },
  listVideos() { return Object.values(load().videos).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
  getVideo(id) { return load().videos[id] || null; },
  saveVideo(v) { v.updatedAt = new Date().toISOString(); load().videos[v.id] = v; flush(); return v; },
  deleteVideo(id) { delete load().videos[id]; flush(); },
  listMusic() { return Object.values(load().music); },
  getMusic(id) { return load().music[id] || null; },
  saveMusic(m) { load().music[m.id] = m; flush(); },
  deleteMusic(id) { delete load().music[id]; flush(); },
  getSettings() { return load().settings; },
  setSettings(patch) {
    const cur = load().settings;
    const next = { ...cur, ...patch, storage: { ...cur.storage, ...(patch.storage || {}) } };
    load().settings = next;
    flush();
    return next;
  },
};
