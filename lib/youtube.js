'use strict';
/**
 * YouTube integration: Google OAuth 2.0 (authorization code + PKCE, offline access)
 * and resumable video upload. Tokens are stored encrypted in the vault.
 */
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const vault = require('./vault');
const store = require('./store');
const { BASE_URL } = require('./config');
const { scrub } = require('./util');

const REDIRECT_URI = `${BASE_URL}/auth/google/callback`;
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

const isConfigured = () => vault.has('YOUTUBE_CLIENT_ID') && vault.has('YOUTUBE_CLIENT_SECRET');

function readTokens() {
  const raw = vault.get('YOUTUBE_TOKENS');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
const writeTokens = (t) => vault.set('YOUTUBE_TOKENS', JSON.stringify(t));

function authUrl() {
  if (!isConfigured()) throw new Error('Add your Google OAuth client ID and secret in Settings first.');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({
    client_id: vault.get('YOUTUBE_CLIENT_ID'),
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, state, verifier };
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: vault.get('YOUTUBE_CLIENT_ID'), client_secret: vault.get('YOUTUBE_CLIENT_SECRET'), ...params }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google OAuth error: ${scrub(data.error_description || data.error || res.status)}`);
  return data;
}

async function channelInfo(accessToken) {
  const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const ch = data.items && data.items[0];
  return ch ? { id: ch.id, title: ch.snippet.title } : null;
}

async function handleCallback({ code, verifier }) {
  const data = await tokenRequest({ code, code_verifier: verifier, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' });
  const prev = readTokens();
  const refresh = data.refresh_token || (prev && prev.refresh_token);
  if (!refresh) throw new Error('Google did not return a refresh token. Remove the app from your Google account permissions and connect again.');
  const channel = await channelInfo(data.access_token);
  writeTokens({
    refresh_token: refresh,
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    channel,
  });
  return channel;
}

async function accessToken() {
  const t = readTokens();
  if (!t) throw new Error('YouTube is not connected.');
  if (t.access_token && t.expires_at - 60000 > Date.now()) return t.access_token;
  const data = await tokenRequest({ refresh_token: t.refresh_token, grant_type: 'refresh_token' });
  t.access_token = data.access_token;
  t.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
  writeTokens(t);
  return t.access_token;
}

function status() {
  const t = readTokens();
  return { configured: isConfigured(), connected: !!t, channel: t ? t.channel || null : null, redirectUri: REDIRECT_URI };
}

async function disconnect() {
  const t = readTokens();
  if (t && t.refresh_token) {
    try {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: t.refresh_token }),
        signal: AbortSignal.timeout(15000),
      });
    } catch { /* best effort: local tokens are removed regardless */ }
  }
  vault.remove('YOUTUBE_TOKENS');
}

function putStream(url, file, size, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { method: 'PUT', host: u.host, path: u.pathname + u.search, headers: { authorization: `Bearer ${token}`, 'content-type': 'video/mp4', 'content-length': size } },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch { /* not json */ }
          if (res.statusCode >= 200 && res.statusCode < 300 && json && json.id) resolve(json);
          else reject(new Error(`YouTube upload failed (HTTP ${res.statusCode}): ${scrub(json && json.error ? json.error.message : body).slice(0, 300)}`));
        });
      }
    );
    req.setTimeout(60 * 60 * 1000, () => req.destroy(new Error('YouTube upload timed out')));
    req.on('error', (e) => reject(new Error(`YouTube network error: ${scrub(e.message)}`)));
    fs.createReadStream(file).pipe(req);
  });
}

/** Upload an approved video. Caller (server) is responsible for the approval gate. */
async function uploadVideo({ file, thumb, title, description, tags, privacy, isShort }) {
  const token = await accessToken();
  const size = fs.statSync(file).size;
  const desc = isShort && !/#shorts/i.test(description) ? `${description}\n\n#Shorts`.trim() : description;

  const init = async (withSynthetic) => {
    const status = { privacyStatus: privacy, selfDeclaredMadeForKids: false };
    if (withSynthetic) status.containsSyntheticMedia = true;
    return fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(size),
        'x-upload-content-type': 'video/mp4',
      },
      body: JSON.stringify({ snippet: { title, description: desc, tags, categoryId: '22' }, status }),
      signal: AbortSignal.timeout(60000),
    });
  };

  const wantSynthetic = store.getSettings().markSyntheticMedia !== false;
  let res = await init(wantSynthetic);
  if (res.status === 400 && wantSynthetic) res = await init(false); // field not accepted: retry without it
  if (!res.ok) {
    const body = scrub(await res.text().catch(() => ''));
    throw new Error(`YouTube rejected the upload request (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  const location = res.headers.get('location');
  if (!location) throw new Error('YouTube did not return an upload URL');
  const result = await putStream(location, file, size, token);
  // Custom thumbnail is best effort: YouTube only allows it on verified channels.
  let thumbnail = 'not attempted';
  if (thumb && fs.existsSync(thumb) && fs.statSync(thumb).size < 2 * 1024 * 1024) {
    try {
      const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(result.id)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' },
        body: fs.readFileSync(thumb),
        signal: AbortSignal.timeout(60000),
      });
      thumbnail = r.ok ? 'set' : `not set (HTTP ${r.status}; custom thumbnails need a verified channel)`;
    } catch (e) { thumbnail = `not set (${scrub(e.message).slice(0, 80)})`; }
  }
  return { videoId: result.id, url: `https://www.youtube.com/watch?v=${result.id}`, thumbnail };
}

module.exports = { authUrl, handleCallback, status, disconnect, uploadVideo, isConfigured, REDIRECT_URI };
