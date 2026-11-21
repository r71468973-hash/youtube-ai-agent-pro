'use strict';
// Full data volume: clear 507 messages, failed jobs clean up, orphaned temp files are swept, finished videos are kept.
// Runs in a child process with a temporary DATA_DIR, so real data is never touched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const disk = require('../lib/disk');

const ok = (m) => console.log(`  ok  ${m}`);

// 1. Disk-full errors become a clear 507 message.
const raw = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
const mapped = disk.asStorageError(raw);
assert.strictEqual(mapped.code, 507);
assert(/storage is full/.test(mapped.message) && !/ENOSPC/.test(mapped.message));
assert.strictEqual(disk.asStorageError(new Error('other')).message, 'other');
ok('a raw disk-full error becomes a 507 "storage is full" message; other errors pass through');

// 2. assertRoom refuses when there is not enough free space.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-'));
assert(disk.freeMb(dir) > 0);
assert.throws(() => disk.assertRoom(dir, 1e12), (e) => e.code === 507 && /MB free/.test(e.message));
assert.strictEqual(typeof disk.assertRoom(dir, 1), 'number');
ok('assertRoom refuses with 507 when free space is below the minimum');

// 3. Startup sweep and failed-job cleanup, in a child process with a temporary DATA_DIR.
const data = path.join(dir, 'data');
const script = `
  process.env.DATA_DIR = ${JSON.stringify(data)};
  const fs = require('fs'); const path = require('path');
  const store = require('../lib/store'); store.init();
  const pipeline = require('../lib/pipeline');
  const mk = (id, status) => { store.saveVideo({ id, status, story: 'x' }); };
  mk('run1', 'generating'); mk('old', 'done'); mk('bad', 'failed');
  for (const id of ['run1', 'old', 'bad', 'none']) {
    fs.mkdirSync(path.join(pipeline.VIDEOS_DIR, id, 'work'), { recursive: true });
    fs.writeFileSync(path.join(pipeline.VIDEOS_DIR, id, 'work', 'a.wav'), Buffer.alloc(200000));
  }
  fs.writeFileSync(path.join(pipeline.VIDEOS_DIR, 'old', 'final.mp4'), Buffer.alloc(1000));
  const freed = pipeline.sweepOrphanWork();
  const exists = (p) => fs.existsSync(p);
  const V = pipeline.VIDEOS_DIR;
  console.log(JSON.stringify({
    running_work_kept: exists(path.join(V, 'run1', 'work')),
    done_work_removed: !exists(path.join(V, 'old', 'work')),
    finished_video_kept: exists(path.join(V, 'old', 'final.mp4')),
    failed_work_removed: !exists(path.join(V, 'bad', 'work')),
    unknown_work_removed: !exists(path.join(V, 'none', 'work')),
    freed_mb_ok: freed >= 0,
  }));
`;
const scriptFile = path.join(dir, 'child.js');
fs.writeFileSync(scriptFile, script.replace(/require\('\.\.\/lib\//g, `require(${JSON.stringify(path.resolve(__dirname, '..', 'lib'))}+'/`).replace(/'\);/g, "');"));
const out = JSON.parse(execFileSync(process.execPath, [scriptFile], { encoding: 'utf8' }).trim().split('\n').pop());
assert.strictEqual(out.running_work_kept, true);
assert.strictEqual(out.done_work_removed, true);
assert.strictEqual(out.finished_video_kept, true);
assert.strictEqual(out.failed_work_removed, true);
assert.strictEqual(out.unknown_work_removed, true);
ok('startup sweep: running job kept; finished/failed/unknown temp files removed; finished video kept');

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n4 storage-full checks passed');
