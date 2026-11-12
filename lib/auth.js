'use strict';
/** Single-owner dashboard login with signed, HttpOnly session cookies and CSRF tokens. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ADMIN_PASSWORD, BASE_URL, DATA_DIR } = require('./config');
const { signingKey } = require('./vault');
const { safeEqual, ensureDir } = require('./util');

const SESSION_COOKIE = 'aiv_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const secureCookie = BASE_URL.startsWith('https://');

let password = ADMIN_PASSWORD;
let generated = false;
function adminPassword() {
  if (password) return password;
  // No ADMIN_PASSWORD set: generate one, persist it (0600) so restarts keep working.
  const f = path.join(DATA_DIR, '.admin_password');
  ensureDir(DATA_DIR);
  if (fs.existsSync(f)) password = fs.readFileSync(f, 'utf8').trim();
  else {
    password = crypto.randomBytes(12).toString('base64url');
    fs.writeFileSync(f, password, { mode: 0o600 });
    generated = true;
  }
  return password;
}
const wasGenerated = () => generated;

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', signingKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', signingKey()).update(body).digest('base64url');
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureCookie ? '; Secure' : ''}`;
}

function getSession(req) {
  return verify(parseCookies(req)[SESSION_COOKIE]);
}

function startSession(res) {
  const csrf = crypto.randomBytes(18).toString('base64url');
  const token = sign({ exp: Date.now() + SESSION_TTL_MS, csrf });
  const prev = res.getHeader('Set-Cookie');
  const header = cookieHeader(SESSION_COOKIE, token, SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', prev ? [].concat(prev, header) : header);
  return csrf;
}

function endSession(res) {
  res.setHeader('Set-Cookie', cookieHeader(SESSION_COOKIE, '', 0));
}

// Naive in-memory login throttle (per IP).
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const rec = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  attempts.set(ip, rec);
  return rec.length >= 8;
}
function noteFailure(ip) {
  const rec = attempts.get(ip) || [];
  rec.push(Date.now());
  attempts.set(ip, rec);
}

function checkPassword(candidate) {
  return safeEqual(candidate || '', adminPassword());
}

/** Short-lived signed blob used for the OAuth `state` (carried in its own cookie). */
function signShort(payload, ttlMs) {
  return sign({ ...payload, exp: Date.now() + ttlMs });
}

module.exports = {
  SESSION_COOKIE, parseCookies, cookieHeader, getSession, startSession, endSession,
  throttled, noteFailure, checkPassword, adminPassword, wasGenerated, signShort, verify,
};
