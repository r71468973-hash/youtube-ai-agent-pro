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
const providers = require('./lib/providers');
const { ensureDir, newId, safeEqual, scrub } = require('./lib/util');

ensureDir(DATA_DIR);
ensureDir(pipeline.VIDEOS_DIR);
ensureDir(pipeline.MUSIC_DIR);
store.init();

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const MUSIC_EXT = new Set(['.mp3', '.wav', '.m4a', '.ogg']);
const MUSIC_BUILTIN = [
  { id: 'none', name: 'No music' },
  { id: 'ambient-calm', name: 'Calm ambient (built-in)' },
  { id: 'ambient-bright', name: 'Bright ambient (built-in)' },
];

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

const clientIp = (req) => req.socket.remoteAddress || 'unknown';

/* -------------------------------------------------------------- serializers */

function publicVideo(v) {
  const { story, scenes, ...rest } = v;
  return { ...rest, storyPreview: String(story || '').slice(0, 160), sceneCount: (scenes || []).length, hasFile: fs.existsSync(path.join(pipeline.videoDir(v.id), 'video.mp4')), inCloud: !!v.cloud };
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

function validateCreate(b) {
  const story = cleanText(b.story, LIMITS.storyMax);
  if (story.length < LIMITS.storyMin) throw Object.assign(new Error(`Story must be at least ${LIMITS.storyMin} characters.`), { code: 400 });
  if (!['hi', 'en'].includes(b.language)) throw Object.assign(new Error('Language must be "hi" or "en".'), { code: 400 });
  if (!FORMATS[b.format]) throw Object.assign(new Error('Format must be "shorts" or "long".'), { code: 400 });
  const music = String(b.music || 'none');
  if (music.startsWith('upload:')) {
    if (!store.getMusic(music.slice(7))) throw Object.assign(new Error('Selected music track not found.'), { code: 400 });
  } else if (!MUSIC_BUILTIN.some((m) => m.id === music)) throw Object.assign(new Error('Unknown music option.'), { code: 400 });
  return {
    story,
    title: cleanText(b.title, 100) || story.split(/[.!?।\n]/)[0].slice(0, 70),
    language: b.language,
    format: b.format,
    voiceGender: b.voiceGender === 'male' ? 'male' : 'female',
    captions: b.captions !== false,
    music,
  };
}

const TTS_SETTINGS = ['auto', 'gemini', 'openai', 'elevenlabs', 'google', 'none'];
function validateSettings(b) {
  const out = {};
  if (b.ttsProvider !== undefined) {
    if (!TTS_SETTINGS.includes(b.ttsProvider)) throw Object.assign(new Error('Invalid TTS provider'), { code: 400 });
    out.ttsProvider = b.ttsProvider;
  }
  if (b.aiProvider !== undefined) {
    if (!['auto', 'gemini', 'anthropic'].includes(b.aiProvider)) throw Object.assign(new Error('Invalid AI provider'), { code: 400 });
    out.aiProvider = b.aiProvider;
  }
  if (b.visualStyle !== undefined) {
    if (!['3d-cartoon', 'cinematic'].includes(b.visualStyle)) throw Object.assign(new Error('Invalid visual style'), { code: 400 });
    out.visualStyle = b.visualStyle;
  }
  if (b.imageMode !== undefined) {
    if (!['gradient', 'ai'].includes(b.imageMode)) throw Object.assign(new Error('Invalid image mode'), { code: 400 });
    out.imageMode = b.imageMode;
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
 * it is in the "ready" state. There is no auto-upload path anywhere else in the code.
 */
async function approveAndUpload(id, meta) {
  const v = store.getVideo(id);
  v.status = 'uploading';
  v.error = null;
  v.approval = { approvedAt: new Date().toISOString(), title: meta.title, privacy: meta.privacy };
  store.saveVideo(v);
  try {
    const file = path.join(pipeline.videoDir(id), 'video.mp4');
    if (!fs.existsSync(file)) throw new Error('Video file is no longer on this server. Regenerate it.');
    const r = await youtube.uploadVideo({ file, title: meta.title, description: meta.description, tags: meta.tags, privacy: meta.privacy, isShort: v.format === 'shorts' });
    const done = store.getVideo(id);
    Object.assign(done, { status: 'published', youtube: { videoId: r.videoId, url: r.url, privacy: meta.privacy, uploadedAt: new Date().toISOString() }, error: null });
    store.saveVideo(done);
  } catch (e) {
    const failed = store.getVideo(id);
    // Back to "ready": the approval is consumed, the owner must approve again to retry.
    Object.assign(failed, { status: 'ready', error: `YouTube upload failed: ${scrub(e.message)}`, approval: null });
    store.saveVideo(failed);
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
  return { title, description, tags, privacy };
}

/* ------------------------------------------------------------------- router */

async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  if (method === 'POST' && p === '/api/login') {
    const ip = clientIp(req);
    if (auth.throttled(ip)) return bad(res, 'Too many attempts. Try again in a few minutes.', 429);
    const b = await readJson(req);
    if (!auth.checkPassword(String(b.password || ''))) { auth.noteFailure(ip); return bad(res, 'Wrong password.', 401); }
    const csrf = auth.startSession(res);
    return json(res, 200, { ok: true, csrf });
  }

  const session = auth.getSession(req);
  if (p === '/api/session') return json(res, 200, session ? { authenticated: true, csrf: session.csrf } : { authenticated: false });
  if (!session) return bad(res, 'Please sign in.', 401);

  if (method !== 'GET' && method !== 'HEAD') {
    if (!safeEqual(req.headers['x-csrf-token'] || '', session.csrf)) return bad(res, 'Invalid CSRF token. Reload the page.', 403);
  }

  if (method === 'POST' && p === '/api/logout') { auth.endSession(res); return json(res, 200, { ok: true }); }

  if (method === 'GET' && p === '/api/overview') {
    const tts = providers.pickTtsProvider();
    return json(res, 200, {
      formats: FORMATS, music: MUSIC_BUILTIN.concat(store.listMusic().map((m) => ({ id: `upload:${m.id}`, name: `${m.name} (uploaded)` }))),
      tts: tts || null,
      ai: { scenes: providers.plannerOrder().length > 0, planner: providers.plannerOrder()[0] || null, gemini: vault.has('GEMINI_API_KEY'), anthropic: vault.has('ANTHROPIC_API_KEY'), images: store.getSettings().imageMode === 'ai' && !!providers.imageProvider() },
      storage: { configured: storage.isConfigured() },
      youtube: youtube.status(),
      limits: { storyMin: LIMITS.storyMin, storyMax: LIMITS.storyMax },
    });
  }

  /* API keys: write-only. Values are never returned. */
  if (method === 'GET' && p === '/api/keys') return json(res, 200, { keys: vault.list() });
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

  if (method === 'POST' && p === '/api/storage/test') return json(res, 200, await storage.testConnection());
  if (method === 'POST' && p === '/api/gemini/test') {
    if (!vault.has('GEMINI_API_KEY')) return json(res, 200, { ok: false, error: 'No Gemini API key saved.' });
    try { return json(res, 200, { ok: true, reply: await providers.testGemini() }); }
    catch (e) { return json(res, 200, { ok: false, error: scrub(e.message) }); }
  }

  /* YouTube */
  if (method === 'GET' && p === '/api/youtube/status') return json(res, 200, youtube.status());
  if (method === 'POST' && p === '/api/youtube/connect') {
    if (!youtube.isConfigured()) return bad(res, 'Add your Google OAuth client ID and secret in Settings first.');
    const a = youtube.authUrl();
    res.setHeader('Set-Cookie', auth.cookieHeader('aiv_oauth', auth.signShort({ state: a.state, verifier: a.verifier }, 10 * 60 * 1000), 600));
    return json(res, 200, { url: a.url });
  }
  if (method === 'POST' && p === '/api/youtube/disconnect') { await youtube.disconnect(); return json(res, 200, { ok: true }); }

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
  if (method === 'POST' && p === '/api/videos') {
    const input = validateCreate(await readJson(req));
    const active = store.listVideos().filter((v) => ['queued', 'generating'].includes(v.status)).length;
    if (active >= 5) return bad(res, 'Too many videos in progress. Wait for one to finish.', 429);
    const id = newId(6);
    const v = store.saveVideo({ id, ...input, status: 'queued', progress: 0, stage: 'Queued', createdAt: new Date().toISOString(), warnings: [], error: null, scenes: [] });
    pipeline.enqueue(id);
    return json(res, 202, { video: publicVideo(v) });
  }

  m = /^\/api\/videos\/([a-f0-9]+)(?:\/(file|thumb|retry|approve|reject))?$/.exec(p);
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
      if (v.cloud) {
        res.writeHead(302, { location: storage.presignGet(v.cloud.key), 'cache-control': 'no-store' });
        return res.end();
      }
      return bad(res, 'File not available.', 404);
    }
    if (action === 'thumb' && method === 'GET') return serveFileWithRange(req, res, path.join(pipeline.videoDir(v.id), 'thumb.jpg'), 'image/jpeg');

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
      if (v.status !== 'ready') return bad(res, v.status === 'published' ? 'Already uploaded to YouTube.' : 'Only videos in the "ready" state can be approved.', 409);
      const yt = youtube.status();
      if (!yt.connected) return bad(res, 'Connect your YouTube account first.', 409);
      const meta = validateApproval(await readJson(req));
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
  if (url.searchParams.get('error')) return page(`Google: ${url.searchParams.get('error')}`, false);
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
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) console.error('[server]', scrub(e.stack || e.message));
    if (!res.headersSent) bad(res, code === 500 ? 'Internal server error.' : e.message, code);
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`AI Video Studio running at ${BASE_URL}`);
  const pw = auth.adminPassword();
  if (auth.wasGenerated()) console.log(`No ADMIN_PASSWORD set. Generated one and saved it to ${path.join(DATA_DIR, '.admin_password')}`);
  if (!process.env.ADMIN_PASSWORD) console.log('Set ADMIN_PASSWORD in the environment to choose your own login password.');
});

module.exports = server;
