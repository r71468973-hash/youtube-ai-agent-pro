'use strict';
/**
 * Cloud storage for generated videos via any S3-compatible service
 * (AWS S3, Cloudflare R2, Backblaze B2, Supabase Storage, MinIO ...).
 * Implements AWS Signature V4 directly, so no SDK is needed.
 * Without configuration, videos simply stay on local disk.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const vault = require('./vault');
const store = require('./store');
const { scrub } = require('./util');

const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split('/').map(enc).join('/');

function cfg() {
  const s = store.getSettings().storage;
  const accessKey = vault.get('S3_ACCESS_KEY_ID');
  const secretKey = vault.get('S3_SECRET_ACCESS_KEY');
  const ok = !!(s.endpoint && s.bucket && accessKey && secretKey);
  return { ok, ...s, accessKey, secretKey };
}
const isConfigured = () => cfg().ok;

function target(c, key) {
  const u = new URL(c.endpoint);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Storage endpoint must be http(s)');
  let host = u.host;
  let pathname = (u.pathname.replace(/\/$/, '') || '') + '/';
  if (c.pathStyle) pathname += `${c.bucket}/${key}`;
  else { host = `${c.bucket}.${u.host}`; pathname += key; }
  return { protocol: u.protocol, host, hostname: host.split(':')[0], port: host.includes(':') ? host.split(':')[1] : undefined, path: encPath(pathname).replace(/%2F/g, '/') };
}

function signingKeyFor(c, date) {
  return hmac(hmac(hmac(hmac('AWS4' + c.secretKey, date), c.region || 'auto'), 's3'), 'aws4_request');
}

function signedHeaders({ c, method, t, payloadHash, extra = {} }) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers = { host: t.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extra };
  const names = Object.keys(headers).sort();
  const canonical = [method, t.path, '', ...names.map((n) => `${n}:${String(headers[n]).trim()}`), '', names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${c.region || 'auto'}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const sig = crypto.createHmac('sha256', signingKeyFor(c, date)).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
  return headers;
}

function send(t, method, headers, bodyStream, wantBody = false) {
  return new Promise((resolve, reject) => {
    const mod = t.protocol === 'https:' ? https : http;
    const req = mod.request({ method, host: t.hostname, port: t.port, path: t.path, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { if (body.length < 2000) body += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(wantBody ? body : undefined);
        else reject(new Error(`Storage HTTP ${res.statusCode}: ${scrub(body).slice(0, 300)}`));
      });
    });
    req.setTimeout(30 * 60 * 1000, () => req.destroy(new Error('Storage request timed out')));
    req.on('error', (e) => reject(new Error(`Storage network error: ${scrub(e.message)}`)));
    if (bodyStream) bodyStream.pipe(req); else req.end();
  });
}

function objectKey(c, name) {
  const prefix = (c.prefix || '').replace(/^\/+/, '');
  return `${prefix}${name}`;
}

async function putFile(name, file, contentType = 'video/mp4') {
  const c = cfg();
  if (!c.ok) throw new Error('Cloud storage is not configured');
  const key = objectKey(c, name);
  const t = target(c, key);
  const size = fs.statSync(file).size;
  const headers = signedHeaders({ c, method: 'PUT', t, payloadHash: 'UNSIGNED-PAYLOAD', extra: { 'content-type': contentType, 'content-length': size } });
  await send(t, 'PUT', headers, fs.createReadStream(file));
  return { key, bucket: c.bucket };
}

async function deleteObject(key) {
  const c = cfg();
  if (!c.ok) return;
  const t = target(c, key);
  await send(t, 'DELETE', signedHeaders({ c, method: 'DELETE', t, payloadHash: sha256hex('') }));
}

/** Time-limited download URL (default 1 hour). */
function presignGet(key, expires = 3600) {
  const c = cfg();
  if (!c.ok) throw new Error('Cloud storage is not configured');
  const t = target(c, key);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${c.region || 'auto'}/s3/aws4_request`;
  const q = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${c.accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const qs = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&');
  const canonical = ['GET', t.path, qs, `host:${t.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const sig = crypto.createHmac('sha256', signingKeyFor(c, date)).update(toSign).digest('hex');
  return `${t.protocol}//${t.host}${t.path}?${qs}&X-Amz-Signature=${sig}`;
}

/** Write, read back and delete a tiny object. Returns a step-by-step report; never throws. */
async function testConnection() {
  const c = cfg();
  const steps = [];
  const missing = [];
  if (!c.endpoint) missing.push('endpoint');
  if (!c.bucket) missing.push('bucket');
  if (!c.accessKey) missing.push('access key ID');
  if (!c.secretKey) missing.push('secret access key');
  if (missing.length) return { ok: false, steps, error: `Missing: ${missing.join(', ')}.` };
  const name = `.connection-test-${crypto.randomBytes(4).toString('hex')}.txt`;
  const payload = `ai-video-studio ${new Date().toISOString()}`;
  const tmp = require('path').join(require('os').tmpdir(), name);
  fs.writeFileSync(tmp, payload);
  let key;
  try {
    try { key = (await putFile(name, tmp, 'text/plain')).key; steps.push({ step: 'write', ok: true }); }
    catch (e) { steps.push({ step: 'write', ok: false }); return { ok: false, steps, error: scrub(e.message) }; }
    try {
      const t = target(c, key);
      const body = await send(t, 'GET', signedHeaders({ c, method: 'GET', t, payloadHash: sha256hex('') }), null, true);
      if (body !== payload) throw new Error('Read-back content did not match');
      steps.push({ step: 'read', ok: true });
    } catch (e) { steps.push({ step: 'read', ok: false }); return { ok: false, steps, error: scrub(e.message) }; }
    try { await deleteObject(key); steps.push({ step: 'delete', ok: true }); }
    catch (e) { steps.push({ step: 'delete', ok: false }); return { ok: false, steps, error: scrub(e.message) }; }
    return { ok: true, steps };
  } finally { fs.rmSync(tmp, { force: true }); }
}

module.exports = { testConnection, isConfigured, putFile, deleteObject, presignGet };
