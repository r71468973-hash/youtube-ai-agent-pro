'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PORT, PUBLIC_DIR, KEY_NAMES, LIMITS, FORMATS, BASE_URL, DATA_DIR } = require('./lib/config');
const vault = require('./lib/vault');
const auth = require('./lib/auth');
const store = require('./lib/store');
const storage = require('./lib/storage');
const youtube = require('./lib/youtube');
const pipeline = require('./lib/pipeline');
const disk = require('./lib/disk');
const render = require('./lib/render');
const providers = require('./lib/providers');
const animation = require('./lib/animation');
const daily = require('./lib/daily');
const publisher = require('./lib/publisher');
const { generateHindiStory } = require('./lib/story');
const uploading = new Set(); // video ids with an upload in progress (never two at once)
let usageCache = null; // cloud usage is listed at most once a minute (the dashboard polls)
async function cachedUsage() {
  if (usageCache && Date.now() - usageCache.at < 60000) return usageCache.value;
  const value = await storage.usage();
  usageCache = { at: Date.now(), value };
  return value;
}
const { ensureDir, newId, safeEqual, scrub } = require('./lib/util');
const security = require('./lib/security');
const notify = require('./lib/notify');

ensureDir(DATA_DIR);
ensureDir(pipeline.VIDEOS_DIR);
ensureDir(pipeline.MUSIC_DIR);
store.init();
// Temporary files left by jobs that were stopped or failed before the cleanup fix are removed now.
{
  const freedMb = pipeline.sweepOrphanWork();
  console.log(`[startup] temporary files cleared: ${freedMb} MB. Free space on data volume: ${disk.freeMb(DATA_DIR)} MB`);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const MUSIC_EXT = new Set(['.mp3', '.wav', '.m4a', '.ogg']);
const MUSIC_BUILTIN = [
  { id: 'none', name: 'No music' },
  { id: 'ambient-calm', name: 'Calm ambient (built-in)' },
  { id: 'ambient-bright', name: 'Bright ambient (built-in)' },
];

// HSTS only over HTTPS (Railway serves the app over HTTPS, so the header is sent in production).
const HSTS = BASE_URL.startsWith('https://') ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob: https://yt3.ggpht.com https://yt3.googleusercontent.com; media-src 'self' blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  ...HSTS,
};

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(obj));
}
const bad = (res, msg, code = 400) => json(res, code, { error: msg });

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error('Request too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON'), { code: 400 }); }
}

const clientIp = (req) => security.clientIp(req);

/* -------------------------------------------------------------- serializers */

function publicVideo(v) {
  const { story, scenes, ...rest } = v;
  return { ...rest, storyPreview: String(story || '').slice(0, 160), sceneCount: (scenes || []).length, hasFile: fs.existsSync(path.join(pipeline.videoDir(v.id), 'video.mp4')), inCloud: !!v.cloud, cloudUrl: (v.cloud && v.cloud.url) || null };
}
const fullVideo = (v) => ({ ...publicVideo(v), story: v.story, scenes: v.scenes || [] });

/* ------------------------------------------------------------------ static */

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return bad(res, 'Not found', 404);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return bad(res, 'Not found', 404);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
    fs.createReadStream(file).pipe(res);
  });
}

function serveFileWithRange(req, res, file, type, download) {
  fs.stat(file, (err, st) => {
    if (err) return bad(res, 'File not found', 404);
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, no-store', ...SECURITY_HEADERS };
    if (download) headers['content-disposition'] = `attachment; filename="${download}"`;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : st.size - parseInt(m[2], 10);
      let end = m[1] && m[2] ? parseInt(m[2], 10) : st.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, st.size - 1);
      if (start > end) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

/* --------------------------------------------------------------- validation */

function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

/** Saves a validated video request and queues it. Shared by the dashboard and the daily job. */
function createJob(input) {
  disk.assertRoom(pipeline.VIDEOS_DIR); // 507 with a clear message when the volume is full
  const id = newId(6);
  const v = store.saveVideo({ id, ...input, status: 'queued', progress: 0, stage: 'Queued', createdAt: new Date().toISOString(), warnings: [], error: null, scenes: [] });
  pipeline.enqueue(id);
  return v;
}

function validateCreate(b) {
  let story = cleanText(b.story, LIMITS.storyMax);
  // Only 2D cartoon videos are made. Older requests that name another style are refused, not silently changed.
  if (b.mode !== undefined && b.mode !== '2d-cartoon') throw Object.assign(new Error('Only 2D cartoon videos can be made.'), { code: 400 });
  const mode = '2d-cartoon';
  // Empty story + Hindi: write an original Hindi story offline (no paid API).
  const autoStory = !story && b.language === 'hi';
  if (autoStory) story = generateHindiStory();
  if (story.length < LIMITS.storyMin) throw Object.assign(new Error(`Story must be at least ${LIMITS.storyMin} characters.`), { code: 400 });
  if (!['hi', 'en'].includes(b.language)) throw Object.assign(new Error('Language must be "hi" or "en".'), { code: 400 });
  if (!FORMATS[b.format]) throw Object.assign(new Error('Format must be "shorts" or "long".'), { code: 400 });
  const st = animation.current();
  if (!st || !st.ok) throw Object.assign(new Error(`2D cartoon renderer is not available: ${st ? st.reason : 'unknown renderer'}`), { code: 409 });
  const music = String(b.music || 'none');
  if (music.startsWith('upload:')) {
    if (!store.getMusic(music.slice(7))) throw Object.assign(new Error('Selected music track not found.'), { code: 400 });
  } else if (!MUSIC_BUILTIN.some((m) => m.id === music)) throw Object.assign(new Error('Unknown music option.'), { code: 400 });
  return {
    story,
    title: cleanText(b.title, 100) || story.split(/[.!?।\n]/)[0].slice(0, 70),
    language: b.language,
    format: b.format,
    mode,
    voiceGender: b.voiceGender === 'male' ? 'male' : 'female',
    captions: b.captions !== false,
    music,
  };
}

const TTS_SETTINGS = ['auto', 'edge', 'piper', 'openai', 'elevenlabs', 'google', 'none'];
function validateSettings(b) {
  const out = {};
  if (b.ttsProvider !== undefined) {
    if (!TTS_SETTINGS.includes(b.ttsProvider)) throw Object.assign(new Error('Invalid TTS provider'), { code: 400 });
    out.ttsProvider = b.ttsProvider;
  }
  if (b.imageMode !== undefined) {
    if (!['gradient', 'ai'].includes(b.imageMode)) throw Object.assign(new Error('Invalid image mode'), { code: 400 });
    out.imageMode = b.imageMode;
  }
  if (b.dailyEnabled !== undefined) {
    if (typeof b.dailyEnabled !== 'boolean') throw Object.assign(new Error('dailyEnabled must be true or false'), { code: 400 });
    out.dailyEnabled = b.dailyEnabled;
  }
  if (b.dailyAutoUpload !== undefined) {
    if (typeof b.dailyAutoUpload !== 'boolean') throw Object.assign(new Error('dailyAutoUpload must be true or false'), { code: 400 });
    out.dailyAutoUpload = b.dailyAutoUpload;
  }
  if (b.dailyHour !== undefined) {
    const h = Number(b.dailyHour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw Object.assign(new Error('dailyHour must be a whole hour from 0 to 23 (India time)'), { code: 400 });
    out.dailyHour = h;
  }
  if (b.dailyPublishHour !== undefined) {
    const h = Number(b.dailyPublishHour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw Object.assign(new Error('dailyPublishHour must be a whole hour from 0 to 23 (India time)'), { code: 400 });
    out.dailyPublishHour = h;
  }
  if (b.dailyEveningHour !== undefined) {
    const h = Number(b.dailyEveningHour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw Object.assign(new Error('dailyEveningHour must be a whole hour from 0 to 23 (India time)'), { code: 400 });
    out.dailyEveningHour = h;
  }
  if (b.dailyEveningPublishHour !== undefined) {
    const h = Number(b.dailyEveningPublishHour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw Object.assign(new Error('dailyEveningPublishHour must be a whole hour from 0 to 23 (India time)'), { code: 400 });
    out.dailyEveningPublishHour = h;
  }
  if (b.dailyPublishMinute !== undefined) {
    const m = Number(b.dailyPublishMinute);
    if (!Number.isInteger(m) || m < 0 || m > 59) throw Object.assign(new Error('dailyPublishMinute must be from 0 to 59'), { code: 400 });
    out.dailyPublishMinute = m;
  }
  if (b.dailyPrivacy !== undefined) {
    if (!['private', 'unlisted'].includes(b.dailyPrivacy)) throw Object.assign(new Error('dailyPrivacy must be private or unlisted'), { code: 400 });
    out.dailyPrivacy = b.dailyPrivacy;
  }
  if (b.dailyPublic !== undefined) {
    if (typeof b.dailyPublic !== 'boolean') throw Object.assign(new Error('dailyPublic must be true or false'), { code: 400 });
    if (b.dailyPublic) {
      // Public publishing is a separate, explicit choice: it needs daily upload on, and a one-time consent
      // recorded with its time. Turning it off clears the consent, so turning it on again asks once more.
      const cur = store.getSettings();
      const autoUpload = b.dailyAutoUpload !== undefined ? b.dailyAutoUpload : cur.dailyAutoUpload;
      if (!autoUpload) throw Object.assign(new Error('Turn on daily upload first. Public publishing needs it.'), { code: 400 });
      if (!cur.dailyPublicConsentAt) {
        if (b.dailyPublicConsent !== true) throw Object.assign(new Error('Tick the consent box: each daily video will become public on YouTube at the chosen India time.'), { code: 400 });
        out.dailyPublicConsentAt = new Date().toISOString();
      }
      out.dailyPublic = true;
    } else {
      out.dailyPublic = false;
      out.dailyPublicConsentAt = null;
    }
  }
  for (const k of ['elevenVoiceFemale', 'elevenVoiceMale']) {
    if (b[k] !== undefined) {
      if (!/^[A-Za-z0-9]{10,40}$/.test(b[k])) throw Object.assign(new Error('Invalid ElevenLabs voice id'), { code: 400 });
      out[k] = b[k];
    }
  }
  if (b.markSyntheticMedia !== undefined) out.markSyntheticMedia = !!b.markSyntheticMedia;
  if (b.storage) {
    const s = b.storage;
    const st = {};
    if (s.endpoint !== undefined) {
      const ep = String(s.endpoint).trim();
      if (ep && !/^https?:\/\/[^\s]+$/i.test(ep)) throw Object.assign(new Error('Storage endpoint must start with https://'), { code: 400 });
      st.endpoint = ep.replace(/\/+$/, '');
    }
    if (s.region !== undefined) st.region = cleanText(s.region, 40) || 'auto';
    if (s.bucket !== undefined) {
      const bk = String(s.bucket).trim();
      if (bk && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}$/.test(bk)) throw Object.assign(new Error('Invalid bucket name'), { code: 400 });
      st.bucket = bk;
    }
    if (s.prefix !== undefined) {
      const p = String(s.prefix).trim().replace(/^\/+/, '');
      if (!/^[A-Za-z0-9/_-]*$/.test(p)) throw Object.assign(new Error('Prefix may only contain letters, numbers, / _ -'), { code: 400 });
      st.prefix = p && !p.endsWith('/') ? `${p}/` : p;
    }
    if (s.pathStyle !== undefined) st.pathStyle = !!s.pathStyle;
    out.storage = st;
  }
  return out;
}

/* ------------------------------------------------------------------- upload */

/**
 * Approval gate. A video is uploaded to YouTube only through this function, and only when
 * the owner explicitly approves it (POST /api/videos/:id/approve with confirm: true) while
 * it is in the "ready" state. The only other caller is the daily job, and only when the owner has
 * turned on dailyAutoUpload; it always passes privacy "private". Resolves true only when YouTube
 * confirmed the upload.
 */
async function approveAndUpload(id, meta) {
  const v = store.getVideo(id);
  if (!v) return false;
  // Duplicate prevention: a video that is already on YouTube, or already uploading, is never sent again.
  if (!publisher.canUpload(v).ok || uploading.has(id)) return false;
  uploading.add(id);
  const scheduled = !!meta.publishAt;
  const now = new Date().toISOString();
  const prevAttempts = (v.schedule && v.schedule.attempts) || 0;
  const scheduleMeta = { title: meta.title, description: meta.description, tags: meta.tags, privacy: 'public', publishAt: meta.publishAt || null };
  v.status = 'uploading';
  v.error = null;
  v.approval = { approvedAt: now, title: meta.title, privacy: meta.privacy, publishAt: meta.publishAt || null };
  store.saveVideo(v);
  try {
    const file = path.join(pipeline.videoDir(id), 'video.mp4');
    if (!fs.existsSync(file)) throw new Error('Video file is no longer on this server. Regenerate it.');
    // Integrity: the MP4 must open and carry H.264 video, AAC audio and matching lengths before YouTube sees it.
    await render.verifyMp4(file, { width: null, height: null });
    const r = await youtube.uploadVideo({
      file, title: meta.title, description: meta.description, tags: meta.tags, privacy: meta.privacy,
      isShort: v.format === 'shorts', publishAt: meta.publishAt || null,
    });
    // Custom thumbnail. The video is already on YouTube, so a refused thumbnail is recorded, never a failed upload.
    let thumbnailError = null;
    const thumbFile = path.join(pipeline.videoDir(id), 'thumb.jpg');
    if (fs.existsSync(thumbFile)) {
      try { await youtube.setThumbnail(r.videoId, thumbFile); } catch (te) { thumbnailError = scrub(te.message).slice(0, 200); }
    }
    const done = store.getVideo(id);
    if (scheduled) {
      // YouTube holds the video privately until publishAt, then makes it public itself.
      Object.assign(done, {
        status: 'scheduled', error: null,
        youtube: { videoId: r.videoId, url: r.url, privacy: 'scheduled', uploadedAt: now, thumbnailError },
        schedule: { publishAt: meta.publishAt, pending: false, attempts: prevAttempts + 1, lastAttemptAt: now, meta: scheduleMeta },
      });
    } else {
      Object.assign(done, { status: 'published', youtube: { videoId: r.videoId, url: r.url, privacy: meta.privacy, uploadedAt: now, thumbnailError }, error: null });
    }
    store.saveVideo(done);
    const shownTitle = meta.title || done.title || 'Video';
    if (scheduled) notify.notify('scheduled', `Scheduled: ${shownTitle}`, `Will become public on YouTube at ${publisher.istLabel(meta.publishAt)}.`, id);
    else notify.notify('uploaded', `Uploaded: ${shownTitle}`, `Uploaded to YouTube as ${meta.privacy}.`, id);
    return true;
  } catch (e) {
    const failed = store.getVideo(id);
    const message = `YouTube upload failed: ${scrub(e.message)}`;
    if (scheduled) {
      // Stays "ready" with a pending retry; the scheduler retries it with a gap, up to a limit.
      Object.assign(failed, {
        status: 'ready', error: message, approval: null,
        schedule: { publishAt: meta.publishAt, pending: true, attempts: prevAttempts + 1, lastAttemptAt: now, meta: scheduleMeta },
      });
    } else {
      // Back to "ready": the approval is consumed, the owner must approve again to retry.
      Object.assign(failed, { status: 'ready', error: message, approval: null });
    }
    store.saveVideo(failed);
    return false;
  } finally {
    uploading.delete(id);
  }
}

function validateApproval(b) {
  if (b.confirm !== true) throw Object.assign(new Error('Explicit approval is required (confirm: true).'), { code: 400 });
  const title = cleanText(b.title, 100);
  if (!title) throw Object.assign(new Error('A title is required.'), { code: 400 });
  if (/[<>]/.test(title)) throw Object.assign(new Error('Title cannot contain < or >.'), { code: 400 });
  const privacy = ['private', 'unlisted', 'public'].includes(b.privacy) ? b.privacy : 'private';
  const description = cleanText(b.description, 5000);
  const tags = (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(','))
    .map((t) => cleanText(t, 30).replace(/[<>]/g, '')).filter(Boolean).slice(0, 15);
  // Optional scheduled publishing: the video becomes public on YouTube at this India time.
  // Making a video public needs its own explicit consent, separate from approving the upload.
  if (b.publishAt) {
    const publishAt = publisher.toUtcPublishAt(b.publishAt);
    if (b.publicAtTimeConsent !== true) throw Object.assign(new Error('Tick the box to confirm the video becomes public on YouTube at that time.'), { code: 400 });
    return { title, description, tags, privacy: 'public', publishAt };
  }
  // Public right away is its own explicit choice: the owner must confirm it, separately from the approval.
  if (privacy === 'public' && b.publicNowConsent !== true) {
    throw Object.assign(new Error('Confirm that this video becomes public on YouTube now. Otherwise choose Private or Unlisted.'), { code: 400 });
  }
  return { title, description, tags, privacy, publishAt: null };
}

/* ------------------------------------------------------------------- router */

async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  // General limit on the API: a runaway client or scanner is slowed down before it reaches the work.
  const ip = clientIp(req);
  if (security.overLimit(`api:${ip}`, 300, 60 * 1000)) {
    security.event('rate_limited', { ip, method, path: p });
    return bad(res, 'Too many requests. Slow down and try again in a minute.', 429);
  }

  if (method === 'POST' && p === '/api/login') {
    if (auth.throttled(ip)) {
      security.event('login_throttled', { ip });
      return bad(res, 'Too many attempts. Try again in a few minutes.', 429);
    }
    const b = await readJson(req);
    if (!auth.checkPassword(String(b.password || ''))) {
      auth.noteFailure(ip);
      security.event('login_failed', { ip });
      return bad(res, 'Wrong password.', 401);
    }
    const csrf = auth.startSession(res);
    security.event('login_ok', { ip });
    return json(res, 200, { ok: true, csrf });
  }

  const session = auth.getSession(req);
  if (p === '/api/session') return json(res, 200, session ? { authenticated: true, csrf: session.csrf } : { authenticated: false });
  if (!session) {
    security.event('unauthorized_api', { ip, method, path: p });
    return bad(res, 'Please sign in.', 401);
  }

  if (method !== 'GET' && method !== 'HEAD') {
    if (!safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) {
      security.event('csrf_rejected', { ip, method, path: p });
      return bad(res, 'Invalid CSRF token. Reload the page.', 403);
    }
  }

  if (method === 'POST' && p === '/api/logout') { auth.endSession(res); return json(res, 200, { ok: true }); }

  /* Cloud storage (Cloudflare R2). Status, connection test and cleanup need the admin login. */
  if (method === 'GET' && p === '/api/storage') {
    const st = storage.status();
    let usage = null;
    let usageError = null;
    if (st.configured) {
      try { usage = await cachedUsage(); } catch (e) { usageError = scrub(e.message).slice(0, 300); }
    }
    return json(res, 200, { ...st, usage, usageError });
  }
  if (method === 'POST' && p === '/api/storage/test') {
    if (!storage.isConfigured()) return bad(res, `Cloud storage is not configured. Missing: ${storage.status().missing.join(', ')}`, 409);
    const r = await storage.testConnection();
    usageCache = null;
    return json(res, r.ok ? 200 : 502, r);
  }
  if (method === 'POST' && p === '/api/storage/cleanup') {
    const b = await readJson(req);
    if (b.confirm !== true) return bad(res, 'Confirm before deleting cloud files.', 400);
    const days = Number(b.olderThanDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return bad(res, 'olderThanDays must be a whole number from 1 to 3650.', 400);
    const cutoff = Date.now() - days * 86400000;
    // Only videos saved to cloud, older than the cutoff, not mid-job, and not published to YouTube (kept for their record).
    const old = store.listVideos().filter((v) => v.cloud && v.cloud.saved && !['queued', 'generating', 'uploading'].includes(v.status)
      && !(v.youtube && v.youtube.videoId) && Date.parse(v.createdAt) < cutoff);
    for (const v of old) { pipeline.deleteArtifacts(v.id); store.deleteVideo(v.id); }
    usageCache = null;
    return json(res, 200, { deleted: old.length });
  }

  if (method === 'GET' && p === '/api/overview') {
    const tts = providers.pickTtsProvider();
    return json(res, 200, {
      formats: FORMATS, music: MUSIC_BUILTIN.concat(store.listMusic().map((m) => ({ id: `upload:${m.id}`, name: `${m.name} (uploaded)` }))),
      tts: tts || null,
      ai: { scenes: vault.has('ANTHROPIC_API_KEY'), images: store.getSettings().imageMode === 'ai' && vault.has('OPENAI_API_KEY') },
      animation: { selected: animation.config().id, providers: animation.statuses() },
      storage: { configured: storage.isConfigured(), bucket: storage.status().bucket, source: storage.status().source, missing: storage.status().missing },
      youtube: await youtube.statusFresh(),
      daily: daily.summary(),
      notifications: store.listNotifications(8),
      limits: { storyMin: LIMITS.storyMin, storyMax: LIMITS.storyMax },
    });
  }

  /* API keys: write-only. Values are never returned. */
  if (method === 'GET' && p === '/api/keys') return json(res, 200, { keys: vault.list() });
  const testMatch = /^\/api\/keys\/([A-Z0-9_]+)\/test$/.exec(p);
  if (method === 'POST' && testMatch) {
    const name = testMatch[1];
    if (!KEY_NAMES.includes(name)) return bad(res, 'Unknown key.', 404);
    const result = await require('./lib/key-tests').testKey(name, (n) => vault.get(n));
    return json(res, 200, result);
  }
  let m = /^\/api\/keys\/([A-Z0-9_]+)$/.exec(p);
  if (m) {
    const name = m[1];
    if (!KEY_NAMES.includes(name)) return bad(res, 'Unknown key.', 404);
    if (method === 'PUT') {
      const b = await readJson(req);
      const val = String(b.value || '').trim();
      if (!val || val.length > 4096 || /\s/.test(val)) return bad(res, 'Enter the key without spaces (max 4096 characters).');
      vault.set(name, val);
      return json(res, 200, { ok: true, keys: vault.list() });
    }
    if (method === 'DELETE') { vault.remove(name); return json(res, 200, { ok: true, keys: vault.list() }); }
  }

  if (method === 'GET' && p === '/api/settings') return json(res, 200, { settings: store.getSettings() });
  if (method === 'PUT' && p === '/api/settings') {
    const patch = validateSettings(await readJson(req));
    return json(res, 200, { settings: store.setSettings(patch) });
  }

  /* YouTube */
  if (method === 'GET' && p === '/api/youtube/status') return json(res, 200, await youtube.statusFresh());
  if (method === 'POST' && p === '/api/youtube/refresh') {
    if (!youtube.status().connected) return bad(res, 'YouTube is not connected.', 409);
    try { return json(res, 200, { channel: await youtube.refreshChannel() }); } catch (e) { return bad(res, scrub(e.message).slice(0, 300), 502); }
  }
  if (method === 'POST' && p === '/api/youtube/connect') {
    if (!youtube.isConfigured()) return bad(res, 'Add your Google OAuth client ID and secret in Settings first.');
    const a = youtube.authUrl();
    res.setHeader('Set-Cookie', auth.cookieHeader('aiv_oauth', auth.signShort({ state: a.state, verifier: a.verifier }, 10 * 60 * 1000), 600));
    security.event('youtube_connect_started', { ip: clientIp(req) });
    return json(res, 200, { url: a.url });
  }
  if (method === 'POST' && p === '/api/youtube/disconnect') {
    await youtube.disconnect();
    security.event('youtube_disconnected', { ip: clientIp(req) });
    return json(res, 200, { ok: true });
  }

  /* Security events (what happened, never passwords, tokens or keys). Owner only. */
  if (method === 'GET' && p === '/api/notifications') return json(res, 200, { notifications: store.listNotifications(50) });
  if (method === 'GET' && p === '/api/security/events') return json(res, 200, { events: security.recent(200) });

  /* Delete the app's data: every video (local and cloud copies), the music library and the YouTube connection.
     API keys and settings are kept; the security log is kept as the record of what happened. Needs the exact phrase. */
  if (method === 'POST' && p === '/api/account/erase') {
    const b = await readJson(req);
    if (b.confirm !== 'DELETE MY DATA') return bad(res, 'Type DELETE MY DATA to confirm. Nothing was deleted.', 400);
    if (store.listVideos().some((v) => ['queued', 'generating', 'uploading'].includes(v.status))) return bad(res, 'Wait until the current video step finishes, then try again.', 409);
    const videos = store.listVideos();
    for (const v of videos) { pipeline.deleteArtifacts(v.id); store.deleteVideo(v.id); }
    for (const t of store.listMusic()) { fs.rmSync(t.file, { force: true }); store.deleteMusic(t.id); }
    await youtube.disconnect();
    usageCache = null;
    security.event('account_erased', { ip: clientIp(req), videos: videos.length });
    return json(res, 200, { ok: true, videosDeleted: videos.length });
  }

  /* Music library */
  if (method === 'GET' && p === '/api/music') return json(res, 200, { music: store.listMusic().map(({ file, ...r }) => r) });
  if (method === 'POST' && p === '/api/music') {
    const name = cleanText(decodeURIComponent(String(req.headers['x-filename'] || 'track')), 80).replace(/[\\/]/g, '_');
    const ext = path.extname(name).toLowerCase();
    if (!MUSIC_EXT.has(ext)) return bad(res, 'Music must be .mp3, .wav, .m4a or .ogg');
    const buf = await readBody(req, LIMITS.musicMaxBytes);
    if (buf.length < 1024) return bad(res, 'File is empty.');
    const id = newId(6);
    const file = path.join(pipeline.MUSIC_DIR, `${id}${ext}`);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    store.saveMusic({ id, name: name.replace(/\.[^.]+$/, ''), file, size: buf.length, createdAt: new Date().toISOString() });
    return json(res, 201, { id: `upload:${id}` });
  }
  m = /^\/api\/music\/([a-f0-9]+)$/.exec(p);
  if (m && method === 'DELETE') {
    const t = store.getMusic(m[1]);
    if (!t) return bad(res, 'Not found.', 404);
    fs.rmSync(t.file, { force: true });
    store.deleteMusic(m[1]);
    return json(res, 200, { ok: true });
  }

  /* Videos */
  if (method === 'GET' && p === '/api/videos') return json(res, 200, { videos: store.listVideos().map(publicVideo) });
  // Publishing queue: scheduled, published and failed videos, in publish-time order (India time shown by the dashboard).
  if (method === 'GET' && p === '/api/schedule') {
    const items = store.listVideos()
      .filter((v) => v.schedule || ['scheduled', 'published', 'failed'].includes(v.status))
      .map((v) => ({
        id: v.id,
        title: (v.approval && v.approval.title) || v.title || 'Untitled',
        status: v.status,
        publishAt: v.schedule ? v.schedule.publishAt : null,
        publishedAt: v.youtube && v.youtube.publishedAt ? v.youtube.publishedAt : null,
        url: v.youtube && v.youtube.url ? v.youtube.url : null,
        attempts: v.schedule ? v.schedule.attempts || 0 : 0,
        error: v.error || null,
        thumbnailError: (v.youtube && v.youtube.thumbnailError) || null,
      }))
      .sort((a, b) => (a.publishAt || a.publishedAt || '9999').localeCompare(b.publishAt || b.publishedAt || '9999'));
    return json(res, 200, { items, now: new Date().toISOString() });
  }
  if (method === 'POST' && p === '/api/videos') {
    const input = validateCreate(await readJson(req));
    const active = store.listVideos().filter((v) => ['queued', 'generating'].includes(v.status)).length;
    if (active >= 5) return bad(res, 'Too many videos in progress. Wait for one to finish.', 429);
    const v = createJob(input);
    return json(res, 202, { video: publicVideo(v) });
  }

  m = /^\/api\/videos\/([a-f0-9]+)(?:\/(file|thumb|retry|approve|reject|reschedule))?$/.exec(p);
  if (m) {
    const v = store.getVideo(m[1]);
    if (!v) return bad(res, 'Video not found.', 404);
    const action = m[2];

    if (!action && method === 'GET') return json(res, 200, { video: fullVideo(v) });
    if (!action && method === 'DELETE') {
      if (['queued', 'generating', 'uploading'].includes(v.status)) return bad(res, 'Wait until the current step finishes.', 409);
      pipeline.deleteArtifacts(v.id);
      store.deleteVideo(v.id);
      return json(res, 200, { ok: true });
    }

    if (action === 'file' && method === 'GET') {
      const f = path.join(pipeline.videoDir(v.id), 'video.mp4');
      if (fs.existsSync(f)) return serveFileWithRange(req, res, f, 'video/mp4', url.searchParams.has('download') ? `${v.id}.mp4` : null);
      // The local copy is used when it exists. Otherwise the saved permanent link, then a temporary link as a fallback.
      if (v.cloud && v.cloud.url) {
        res.writeHead(302, { location: v.cloud.url, 'cache-control': 'no-store' });
        return res.end();
      }
      if (v.cloud) {
        res.writeHead(302, { location: storage.presignGet(v.cloud.key), 'cache-control': 'no-store' });
        return res.end();
      }
      return bad(res, 'File not available.', 404);
    }
    if (action === 'thumb' && method === 'GET') return serveFileWithRange(req, res, path.join(pipeline.videoDir(v.id), 'thumb.jpg'), 'image/jpeg');

    // Change the publish time of a video that is still private and scheduled on YouTube ("Edit time" / "Publish now").
    if (action === 'reschedule' && method === 'POST') {
      const b = await readJson(req);
      if (v.status !== 'scheduled' || !v.youtube || !v.youtube.videoId) return bad(res, 'Only a scheduled video can change its time.', 409);
      if (b.publicAtTimeConsent !== true) return bad(res, 'Confirm that the video becomes public on YouTube at the new time.', 400);
      let when;
      try { when = publisher.toUtcPublishAt(String(b.publishAt || '')); } catch (e) { return bad(res, e.message, e.code || 400); }
      const state = await youtube.getPublishState(v.youtube.videoId);
      if (state.privacyStatus !== 'private') return bad(res, 'YouTube already made this video public, so its time can no longer change.', 409);
      await youtube.updatePublishAt(v.youtube.videoId, when);
      v.schedule = { ...(v.schedule || {}), publishAt: when, pending: false, meta: { ...((v.schedule && v.schedule.meta) || {}), publishAt: when } };
      store.saveVideo(v);
      return json(res, 200, { ok: true, publishAt: when });
    }

    if (action === 'retry' && method === 'POST') {
      if (!['failed', 'ready'].includes(v.status)) return bad(res, 'This video cannot be regenerated right now.', 409);
      Object.assign(v, { status: 'queued', progress: 0, stage: 'Queued', error: null, approval: null, warnings: [] });
      store.saveVideo(v);
      pipeline.enqueue(v.id);
      return json(res, 202, { video: publicVideo(v) });
    }

    if (action === 'reject' && method === 'POST') {
      if (v.status !== 'ready') return bad(res, 'Only videos awaiting review can be rejected.', 409);
      v.status = 'rejected';
      store.saveVideo(v);
      return json(res, 200, { video: publicVideo(v) });
    }

    if (action === 'approve' && method === 'POST') {
      if (v.youtube && v.youtube.videoId) return bad(res, 'Already uploaded to YouTube.', 409);
      if (!['ready', 'failed'].includes(v.status)) return bad(res, 'Only videos awaiting approval or failed uploads can be approved.', 409);
      const yt = youtube.status();
      if (!yt.connected) return bad(res, 'Connect your YouTube account first.', 409);
      const meta = validateApproval(await readJson(req));
      security.event('upload_approved', { ip: clientIp(req), videoId: v.id, privacy: meta.privacy, scheduled: !!meta.publishAt, channel: yt.channel ? yt.channel.id : null });
      approveAndUpload(v.id, meta); // runs in background; UI polls status
      return json(res, 202, { video: publicVideo(store.getVideo(v.id)) });
    }
  }

  return bad(res, 'Not found.', 404);
}

async function handleOAuthCallback(req, res, url) {
  const page = (msg, ok) => {
    res.writeHead(302, { location: `/?youtube=${ok ? 'connected' : 'error'}&msg=${encodeURIComponent(msg).slice(0, 300)}`, 'set-cookie': auth.cookieHeader('aiv_oauth', '', 0) });
    res.end();
  };
  if (!auth.getSession(req)) return page('Please sign in to the dashboard first, then connect again.', false);
  if (url.searchParams.get('error')) return page(youtube.oauthErrorMessage(url.searchParams.get('error'), url.searchParams.get('error_description')), false);
  const saved = auth.verify(auth.parseCookies(req).aiv_oauth);
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code');
  if (!saved || !code || !safeEqual(state, saved.state)) return page('The sign-in link expired or did not match. Please try again.', false);
  try {
    const ch = await youtube.handleCallback({ code, verifier: saved.verifier });
    return page(ch ? `Connected to ${ch.title}` : 'Connected', true);
  } catch (e) {
    return page(scrub(e.message), false);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, BASE_URL);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/auth/google/callback' && req.method === 'GET') return await handleOAuthCallback(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return bad(res, 'Method not allowed', 405);
    return serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (raw) {
    const e = disk.asStorageError(raw);
    const code = e.code && Number.isInteger(e.code) ? e.code : 500;
    // Full server log for every failed request (secrets scrubbed), so the cause can be found in Railway logs.
    if (code >= 500) console.error(`[server] ${req.method} ${String(req.url).split('?')[0]} -> ${code}:`, scrub(e.stack || e.message));
    if (!res.headersSent) bad(res, code === 500 ? 'Internal server error. The details are in the server log.' : e.message, code);
    else res.end();
  }
});

// A failed background render must not take the whole studio down. Errors are logged (secrets scrubbed) and the server keeps serving.
process.on('uncaughtException', (e) => console.error('[process] uncaught exception:', scrub((e && e.stack) || String(e))));
process.on('unhandledRejection', (e) => console.error('[process] unhandled rejection:', scrub((e && e.stack) || String(e))));

server.listen(PORT, () => {
  console.log(`AI Video Studio running at ${BASE_URL}`);
  const sst = storage.status();
  console.log(sst.configured
    ? `Cloud storage: connected to bucket "${sst.bucket}" (${sst.source} settings)`
    : `Cloud storage: NOT configured (missing ${sst.missing.join(', ')}). Videos stay on this server only.`);
  const pw = auth.adminPassword();
  if (auth.wasGenerated()) console.log(`No ADMIN_PASSWORD set. Generated one and saved it to ${path.join(DATA_DIR, '.admin_password')}`);
  if (!process.env.ADMIN_PASSWORD) console.log('Set ADMIN_PASSWORD in the environment to choose your own login password.');
  // Daily job: makes one story video per day (India time) and waits for your approval. Off until enabled in Settings.
  // The upload callback only runs when dailyAutoUpload is on. Its privacy comes from daily.dailyPublishPlan:
  // PRIVATE, or public at the chosen India time once the owner has given the one-time consent.
  daily.start(
    (body) => createJob(validateCreate(body)).id,
    (id, meta) => approveAndUpload(id, meta),
  );
  // Publishing scheduler: once a minute it confirms scheduled videos with YouTube and retries failed
  // uploads. It does nothing until YouTube is connected. YouTube itself makes a video public at its time.
  setInterval(() => {
    if (!youtube.status().connected) return;
    publisher.tick({
      videos: () => store.listVideos(),
      updateVideo: (id, patch) => { const v = store.getVideo(id); if (v) { Object.assign(v, patch); store.saveVideo(v); } },
      getPublishState: youtube.getPublishState,
      retry: (id) => { const v = store.getVideo(id); return v && v.schedule && v.schedule.meta ? approveAndUpload(id, v.schedule.meta) : false; },
    }).then((acts) => {
      for (const [a, id] of acts) {
        console.log(`[schedule] ${a} ${id}`);
        const v = store.getVideo(id);
        const title = (v && (v.approval && v.approval.title || v.title)) || 'Video';
        if (a === 'published') notify.notify('published', `Published: ${title}`, 'YouTube made this video public at its scheduled time.', id);
        if (a === 'failed') notify.notify('failed', `Not published: ${title}`, (v && v.error) || 'YouTube did not make this video public.', id);
      }
    })
      .catch((e) => console.log(`[schedule] ${scrub(e.message)}`));
  }, 60 * 1000);
});

module.exports = server;
