'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const newId = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');

/** Remove anything that looks like a credential from text before it is logged or returned. */
function scrub(text) {
  return String(text == null ? '' : text)
    .replace(/([?&](?:key|api_key|access_token|client_secret|refresh_token)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z._-]+)/g, '[redacted]')
    .slice(0, 2000);
}

/**
 * Runs a command and resolves { out, err } on exit code 0. On failure it rejects with the exit code
 * or signal (a SIGKILL usually means the process ran out of memory), keeps the tail of stderr, and,
 * when opts.logFile is given, saves the full stderr there. opts.timeoutMs kills a hung process.
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, opts.timeoutMs) : null;
    p.stdout.on('data', (d) => { out += d; if (out.length > 1e6) out = out.slice(-1e6); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 2e5) err = err.slice(-2e5); });
    p.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    p.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) return resolve({ out, err });
      if (opts.logFile) { try { fs.writeFileSync(opts.logFile, err || '(no stderr output)'); } catch (_) { /* logging must not hide the error */ } }
      let why = `exit code ${code}`;
      if (timedOut) why = `timed out after ${opts.timeoutMs} ms`;
      else if (signal) why = `killed by ${signal}${signal === 'SIGKILL' ? ' (most likely out of memory)' : ''}`;
      const e = new Error(`${cmd} failed (${why}): ${scrub(err.slice(-700)) || 'no error output'}`);
      Object.assign(e, { code, signal, timedOut });
      reject(e);
    });
  });
}

async function mediaDuration(file) {
  const { out } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = parseFloat(out);
  if (!Number.isFinite(d)) throw new Error('Could not read media duration');
  return d;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { ensureDir, writeJsonAtomic, newId, scrub, run, mediaDuration, safeEqual, sleep };
