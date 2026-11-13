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

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; if (out.length > 1e6) out = out.slice(-1e6); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 2e5) err = err.slice(-2e5); });
    p.on('error', reject);
    p.on('close', (code, signal) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} failed (${code == null ? `killed by ${signal || 'signal'}; likely out of memory` : code}): ${err.slice(-700)}`));
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
