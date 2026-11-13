'use strict';
/** Tiny JSON-file database (single process). Atomic writes, no external dependencies. */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { ensureDir, writeJsonAtomic } = require('./util');

const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_SETTINGS = {
  settingsVersion: 2,
  aiProvider: 'auto', // auto | gemini | anthropic (scene planning and story generation)
  ttsProvider: 'auto', // auto | gemini | openai | elevenlabs | google | none
  imageMode: 'ai', // ai (3D cartoon scenes via Gemini or OpenAI) | gradient
  visualStyle: '3d-cartoon', // 3d-cartoon | cinematic
  elevenVoiceFemale: 'EXAVITQu4vr4xnSDxMaL',
  elevenVoiceMale: 'JBFqnCBsd6RMkjVDRZzb',
  openaiTtsModel: 'gpt-4o-mini-tts',
  markSyntheticMedia: true,
  keepLocalCopy: true,
  storage: { endpoint: '', region: 'auto', bucket: '', prefix: 'videos/', pathStyle: true },
};

let db = null;

function load() {
  if (db) return db;
  ensureDir(DATA_DIR);
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = {}; }
  db.videos = db.videos || {};
  db.music = db.music || {};
  const prevVersion = (db.settings && db.settings.settingsVersion) || 1;
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}), storage: { ...DEFAULT_SETTINGS.storage, ...((db.settings || {}).storage || {}) } };
  if (prevVersion < 2) {
    // v2: AI scene images are on by default (needs a Gemini or OpenAI key; falls back to gradients without one).
    db.settings.imageMode = 'ai';
    db.settings.settingsVersion = 2;
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), { mode: 0o600 }); } catch { /* retried on next save */ }
  }
  return db;
}
function flush() { writeJsonAtomic(DB_FILE, db); }

module.exports = {
  init() {
    load();
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
