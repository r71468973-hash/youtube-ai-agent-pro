'use strict';
/**
 * Cloud storage for generated files: Cloudflare R2 through its S3-compatible API.
 *
 * Configure with environment variables (never hardcode them):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ENDPOINT
 * R2_ENDPOINT is optional when R2_ACCOUNT_ID is set (https://<account>.r2.cloudflarestorage.com).
 * If no R2 variable is set, the older Settings page (S3-compatible endpoint + vault keys) is used.
 *
 * Implements AWS Signature V4 directly, so no SDK is needed. Secrets are never returned or logged.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const vault = require('./vault');
const store = require('./store');
const { scrub } = require('./util');

const DEFAULT_BUCKET = 'youtube-ai-agent-storage';
const R2_VARS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_ENDPOINT'];
// Cloudflare R2 free tier includes 10 GB-month of Standard storage. Check the Cloudflare pricing page for current limits.
const FREE_STORAGE_BYTES = 10 * 1024 ** 3;
const MAX_LIST_PAGES = 50;

const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split('/').map(enc).join('/');
const EMPTY_HASH = sha256hex('');

// Recent failures for the dashboard. Messages are scrubbed of secrets before they are stored.
const errors = [];
function recordError(where, e) {
  errors.push({ at: new Date().toISOString(), where, message: scrub(String((e && e.message) || e)).slice(0, 300) });
  while (errors.length > 50) errors.shift();
}

/** Resolved configuration. `missing` lists variable NAMES only, never values. */
function cfg() {
  if (R2_VARS.some((n) => process.env[n])) {
    const accountId = process.env.R2_ACCOUNT_ID || '';
    const endpoint = (process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '')).replace(/\/+$/, '');
    const accessKey = process.env.R2_ACCESS_KEY_ID || '';
    const secretKey = process.env.R2_SECRET_ACCESS_KEY || '';
    const missing = [];
    if (!endpoint) missing.push('R2_ACCOUNT_ID (or R2_ENDPOINT)');
    if (!accessKey) missing.push('R2_ACCESS_KEY_ID');
    if (!secretKey) missing.push('R2_SECRET_ACCESS_KEY');
    return {
      source: 'environment', ok: !missing.length, missing, endpoint, accessKey, secretKey,
      bucket: process.env.R2_BUCKET_NAME || DEFAULT_BUCKET, region: 'auto', prefix: 'videos/', pathStyle: true,
    };
  }
  const s = store.getSettings().storage;
  const accessKey = vault.get('S3_ACCESS_KEY_ID');
  const secretKey = vault.get('S3_SECRET_ACCESS_KEY');
  const missing = [];
  if (!s.endpoint) missing.push('endpoint (Settings)');
  if (!s.bucket) missing.push('bucket (Settings)');
  if (!accessKey) missing.push('S3_ACCESS_KEY_ID');
  if (!secretKey) missing.push('S3_SECRET_ACCESS_KEY');
  return { source: 'settings', ok: !missing.length, missing, endpoint: s.endpoint, accessKey, secretKey, bucket: s.bucket, region: s.region || 'auto', prefix: s.prefix || '', pathStyle: s.pathStyle !== false };
}

const isConfigured = () => cfg().ok;

function requireConfig() {
  const c = cfg();
  if (!c.ok) throw new Error(`Cloud storage is not configured. Missing: ${c.missing.join(', ')}`);
  return c;
}

function target(c, key) {
  const u = new URL(c.endpoint);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Storage endpoint must be http(s)');
  let host = u.host;
  let pathname = (u.pathname.replace(/\/$/, '') || '') + '/';
  if (c.pathStyle) pathname += `${c.bucket}/${key}`;
  else { host = `${c.bucket}.${u.host}`; pathname += key; }
  return { protocol: u.protocol, host, hostname: host.split(':')[0], port: host.includes(':') ? host.split(':')[1] : undefined, path: encPath(pathname).replace(/%2F/g, '/') };
}

const signingKeyFor = (c, date) => hmac(hmac(hmac(hmac('AWS4' + c.secretKey, date), c.region || 'auto'), 's3'), 'aws4_request');

function signedHeaders({ c, method, t, payloadHash, extra = {}, query = {} }) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers = { host: t.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extra };
  const names = Object.keys(headers).sort();
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonical = [method, t.path, canonicalQuery, ...names.map((n) => `${n}:${String(headers[n]).trim()}`), '', names.join(';'), payloadHash].join('\n');
  const scope = `${date}/${c.region || 'auto'}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const sig = crypto.createHmac('sha256', signingKeyFor(c, date)).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
  return headers;
}

/** One HTTP call. Resolves with the status and the full body; never throws on an HTTP error status. */
function request(t, method, headers, body) {
  return new Promise((resolve, reject) => {
    const mod = t.protocol === 'https:' ? https : http;
    const req = mod.request({ method, host: t.hostname, port: t.port, path: t.path, headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (e) => reject(new Error(`Storage network error: ${scrub(e.message)}`)));
    });
    req.setTimeout(30 * 60 * 1000, () => req.destroy(new Error('Storage request timed out')));
    req.on('error', (e) => reject(new Error(`Storage network error: ${scrub(e.message)}`)));
    if (body && typeof body.pipe === 'function') {
      body.on('error', (e) => { req.destroy(e); reject(e); });
      body.pipe(req);
    } else req.end(body);
  });
}

async function call(c, method, key, { body, contentType, contentLength, payloadHash = EMPTY_HASH, query } = {}) {
  const t = target(c, key);
  const extra = {};
  if (contentType) extra['content-type'] = contentType;
  if (contentLength !== undefined) extra['content-length'] = contentLength;
  const headers = signedHeaders({ c, method, t, payloadHash, extra, query });
  const qs = query && Object.keys(query).length ? '?' + Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&') : '';
  return request({ ...t, path: t.path + qs }, method, headers, body);
}

const httpError = (res, what) => {
  const text = res.body.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return new Error(`${what} failed: storage returned HTTP ${res.status}${text ? ` (${scrub(text).slice(0, 200)})` : ''}`);
};

/** Keys must be relative, plain paths. Refusing anything else prevents writing outside the bucket folder. */
function safeName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..')) throw new Error(`Unsafe storage name: ${name}`);
  return name;
}
const objectKey = (c, name) => `${c.prefix || ''}${safeName(name)}`;

/** Folder for one video: YYYY/MM/DD/<videoId>. Date comes from when the video was created (UTC). */
function videoFolder(id, createdAt) {
  const d = new Date(createdAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${safeName(id)}`;
}

async function headObject(key) {
  const c = requireConfig();
  const res = await call(c, 'HEAD', key);
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) throw httpError(res, 'Check');
  return { size: Number(res.headers['content-length'] || 0) };
}

/** PUT, then confirm the object exists at the same size. Only a confirmed object counts as saved. */
async function putBody(name, body, size, contentType) {
  const c = requireConfig();
  const key = objectKey(c, name);
  try {
    const res = await call(c, 'PUT', key, { body, contentType, contentLength: size, payloadHash: 'UNSIGNED-PAYLOAD' });
    if (res.status < 200 || res.status >= 300) throw httpError(res, 'Upload');
    const head = await headObject(key);
    if (!head || head.size !== size) throw new Error(`Upload check failed: ${name} is not in storage at the expected size`);
    return { key, bucket: c.bucket, size, verified: true };
  } catch (e) {
    recordError(`upload ${name}`, e);
    throw e;
  }
}

async function putFile(name, file, contentType = 'video/mp4') {
  const size = fs.statSync(file).size;
  return putBody(name, fs.createReadStream(file), size, contentType);
}

async function putBuffer(name, buf, contentType = 'application/octet-stream') {
  return putBody(name, buf, buf.length, contentType);
}

async function getBuffer(name) {
  const c = requireConfig();
  const res = await call(c, 'GET', objectKey(c, name));
  if (res.status < 200 || res.status >= 300) throw httpError(res, 'Download');
  return res.body;
}

async function deleteObject(key) {
  const c = requireConfig();
  const res = await call(c, 'DELETE', key);
  if (res.status >= 200 && res.status < 300) return true;
  if (res.status === 404) return false;
  const err = httpError(res, 'Delete');
  recordError(`delete ${key}`, err);
  throw err;
}

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Every object in the bucket (paged). `capped` is true only if the bucket is larger than the listing limit. */
async function listAll() {
  const c = requireConfig();
  const objects = [];
  let token = null;
  let capped = false;
  for (let page = 0; ; page++) {
    if (page >= MAX_LIST_PAGES) { capped = true; break; }
    const query = { 'list-type': '2', prefix: c.prefix || '' };
    if (token) query['continuation-token'] = token;
    const res = await call(c, 'GET', '', { query });
    if (res.status < 200 || res.status >= 300) throw httpError(res, 'Listing');
    const xml = res.body.toString('utf8');
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const k = /<Key>([^<]*)<\/Key>/.exec(m[1]);
      const s = /<Size>(\d+)<\/Size>/.exec(m[1]);
      if (k) objects.push({ key: unescapeXml(k[1]), size: Number(s ? s[1] : 0) });
    }
    const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !next) break;
    token = unescapeXml(next[1]);
  }
  return { objects, capped };
}

function kindOf(key) {
  const base = key.split('/').pop();
  if (base === 'metadata.json') return 'metadata';
  if (/\.mp4$/i.test(base)) return 'videos';
  if (/\.(m4a|mp3|wav|ogg)$/i.test(base)) return 'audio';
  if (/\.(ass|srt|vtt)$/i.test(base)) return 'subtitles';
  if (/^thumb.*\.(jpe?g|png)$/i.test(base)) return 'thumbnails';
  if (/\.(jpe?g|png)$/i.test(base)) return 'images';
  return 'other';
}

/** Counts and sizes for the dashboard, with free-tier warnings. Billing is never changed from here. */
async function usage() {
  const { objects, capped } = await listAll();
  const counts = { videos: 0, audio: 0, thumbnails: 0, subtitles: 0, images: 0, metadata: 0, other: 0 };
  let bytes = 0;
  for (const o of objects) { bytes += o.size; counts[kindOf(o.key)]++; }
  const warnings = [];
  if (capped) warnings.push(`The bucket has more than ${MAX_LIST_PAGES * 1000} files; these totals are partial.`);
  if (bytes > FREE_STORAGE_BYTES) warnings.push('Storage is above the 10 GB free tier. Cloudflare may charge for the extra. Delete old files or check your billing page.');
  else if (bytes > FREE_STORAGE_BYTES * 0.8) warnings.push('Storage is above 80% of the 10 GB free tier. Delete old files before it fills.');
  return { objects: objects.length, bytes, counts, capped, freeTierBytes: FREE_STORAGE_BYTES, warnings };
}

/** Upload, download-and-compare, then delete. Only the test file is ever deleted. */
async function testConnection() {
  const c = cfg();
  const steps = [];
  if (!c.ok) return { ok: false, steps, error: `Not configured. Missing: ${c.missing.join(', ')}` };
  const name = `storage-test/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`;
  const content = Buffer.from(`storage connection test ${crypto.randomBytes(12).toString('hex')}\n`);
  try {
    steps.push('Upload a small test file');
    await putBuffer(name, content, 'text/plain');
    steps.push('Confirm the file exists at the expected size');
    steps.push('Download the file and compare contents');
    const got = await getBuffer(name);
    if (!got.equals(content)) throw new Error('Downloaded contents do not match what was uploaded.');
    steps.push('Delete the test file');
    await deleteObject(objectKey(c, name));
    steps.push('Confirm the test file is gone');
    if (await headObject(objectKey(c, name))) throw new Error('The test file still exists after delete.');
    return { ok: true, steps, bucket: c.bucket };
  } catch (e) {
    try { await deleteObject(objectKey(c, name)); } catch { /* the test file may never have been created */ }
    return { ok: false, steps, error: scrub(e.message).slice(0, 300) };
  }
}

/** Time-limited download URL (default 1 hour). */
function presignGet(key, expires = 3600) {
  const c = requireConfig();
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

/** Connection summary for the dashboard. Shows the endpoint host and bucket name, never any key. */
function status() {
  const c = cfg();
  let endpointHost = '';
  try { endpointHost = c.endpoint ? new URL(c.endpoint).host : ''; } catch { endpointHost = ''; }
  return {
    configured: c.ok,
    source: c.source,
    bucket: c.bucket || '',
    endpointHost,
    missing: c.missing,
    recentErrors: errors.slice(-10).reverse(),
  };
}

module.exports = {
  isConfigured, status, putFile, putBuffer, getBuffer, headObject, deleteObject, listAll, usage,
  testConnection, presignGet, videoFolder, recordError, FREE_STORAGE_BYTES,
};
