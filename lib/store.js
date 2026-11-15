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
  dailyHour: 4, // hour of the day in India time when the daily video is made (early, so it is ready well before publish time)
  dailyAutoUpload: false, // when on, each finished daily video is uploaded to YouTube (PRIVATE unless dailyPublic is on)
  dailyPublic: false, // when on AND consented, each daily video becomes public on YouTube at dailyPublishHour:dailyPublishMinute (India time)
  dailyPublicConsentAt: null, // the one-time consent for public daily videos, with its time
  dailyPublishHour: 6, // India time: 06:30 AM, when the daily video becomes public (if dailyPublic)
  dailyPublishMinute: 30,
  scheduleVersion: 2, // 2 = daily schedule moved to 04:00 creation and 06:30 IST publishing (see migration in load())
  markSyntheticMedia: true,
  keepLocalCopy: true,
  storage: { endpoint: '', region: 'auto', bucket: '', prefix: 'videos/', pathStyle: true },
};

let db = null;
let legacyPlaintext = false;
let scheduleMigrated = false;
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
  const storedVersion = (db.settings && db.settings.scheduleVersion) || 1; // read before defaults are merged in
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}), storage: { ...DEFAULT_SETTINGS.storage, ...((db.settings || {}).storage || {}) } };
  db.notifications = db.notifications || [];
  if (storedVersion < 2) {
    // One-time move of the daily schedule to 04:00 creation and 06:30 IST publishing (the owner's requested time).
    db.settings = { ...db.settings, dailyHour: 4, dailyPublishHour: 6, dailyPublishMinute: 30, scheduleVersion: 2 };
    scheduleMigrated = true;
  }
  return db;
}
function flush() { writeJsonAtomic(DB_FILE, { [ENC_MARK]: vault.encryptText(JSON.stringify(db)) }); }

module.exports = {
  init() {
    load();
    if (legacyPlaintext || scheduleMigrated) { flush(); legacyPlaintext = false; scheduleMigrated = false; } // encrypt a plaintext database; save the schedule migration
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
  listNotifications(n = 30) { return load().notifications.slice(0, n); },
  addNotification(item) { const d = load(); d.notifications = [item, ...d.notifications].slice(0, 100); flush(); return item; },
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
