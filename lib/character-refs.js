'use strict';
/**
 * Persistent character reference images, stored under DATA_DIR/character-refs/<slug>.<png|jpg>.
 * A reference is a still drawing of one character. It is attached to paid clips only when the job asks for it
 * (useReferenceImages), because how Gemini Omni uses a reference image has not been verified with a paid test yet.
 */
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 4 * 1024 * 1024;
const MIN_BYTES = 2 * 1024;

function slugOf(name) {
  const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) throw Object.assign(new Error('Character name is empty.'), { code: 'bad_name' });
  return s.slice(0, 60);
}

/** Detects PNG or JPEG from the first bytes. Returns the MIME type or null. */
function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

function refDir(dir) {
  return dir;
}

/** Saves a reference image. Throws with a clear message if the file is not a usable PNG or JPEG. */
function saveRef(dir, name, buf) {
  const slug = slugOf(name);
  if (!Buffer.isBuffer(buf)) throw Object.assign(new Error('Reference image is missing.'), { code: 'bad_image' });
  if (buf.length < MIN_BYTES) throw Object.assign(new Error('Reference image is too small to be a drawing.'), { code: 'bad_image' });
  if (buf.length > MAX_BYTES) throw Object.assign(new Error('Reference image is larger than 4 MB.'), { code: 'bad_image' });
  const mime = sniffImage(buf);
  if (!mime) throw Object.assign(new Error('Reference image must be a PNG or JPEG file.'), { code: 'bad_image' });
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  fs.mkdirSync(refDir(dir), { recursive: true });
  // Remove an old file with the other extension so only one reference exists per character.
  for (const other of ['png', 'jpg']) {
    if (other !== ext) fs.rmSync(path.join(refDir(dir), `${slug}.${other}`), { force: true });
  }
  const file = path.join(refDir(dir), `${slug}.${ext}`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return { name: slug, mime, bytes: buf.length };
}

/** Returns { name, mime, base64 } for a saved reference, or null when there is none. */
function loadRef(dir, name) {
  const slug = slugOf(name);
  for (const [ext, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg']]) {
    const file = path.join(refDir(dir), `${slug}.${ext}`);
    if (fs.existsSync(file)) return { name: slug, mime, base64: fs.readFileSync(file).toString('base64') };
  }
  return null;
}

/** Lists saved references (names only). */
function listRefs(dir) {
  if (!fs.existsSync(refDir(dir))) return [];
  return fs.readdirSync(refDir(dir))
    .filter((f) => /\.(png|jpg)$/.test(f))
    .map((f) => ({ name: f.replace(/\.(png|jpg)$/, ''), file: f }));
}

/** Deletes a saved reference. Returns true when a file was removed. */
function deleteRef(dir, name) {
  const slug = slugOf(name);
  let removed = false;
  for (const ext of ['png', 'jpg']) {
    const file = path.join(refDir(dir), `${slug}.${ext}`);
    if (fs.existsSync(file)) { fs.rmSync(file); removed = true; }
  }
  return removed;
}

module.exports = { saveRef, loadRef, listRefs, deleteRef, sniffImage, slugOf, MAX_BYTES };
