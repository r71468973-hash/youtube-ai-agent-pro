'use strict';
/** Checks ffmpeg error handling, and that a finished MP4 is verified before it can count as done. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { run } = require('../lib/util');
const render = require('../lib/render');

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
  try {
    await assert.rejects(
      run('sh', ['-c', 'kill -9 $$'], {}),
      (e) => e.signal === 'SIGKILL' && /out of memory/.test(e.message),
    );
    ok('a SIGKILL is reported as a kill, with the out-of-memory hint');

    await assert.rejects(run('sleep', ['10'], { timeoutMs: 200 }), (e) => e.timedOut === true);
    ok('a hung command is stopped at its timeout');

    const log = path.join(work, 'err.log');
    await assert.rejects(
      run('sh', ['-c', 'echo boom-detail 1>&2; exit 3'], { logFile: log }),
      (e) => e.code === 3 && !e.signal,
    );
    assert.match(fs.readFileSync(log, 'utf8'), /boom-detail/);
    ok('a normal failure saves its complete stderr to a log file');

    const good = path.join(work, 'good.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', good]);
    const duration = await render.verifyMp4(good, { width: 1080, height: 1920 });
    assert(duration > 2.5 && duration < 3.5, `duration ${duration}`);
    ok('a finished 1080x1920 H.264 + AAC MP4 is verified');

    await assert.rejects(render.verifyMp4(good, { width: 1920, height: 1080 }), /expected 1920x1080/);
    ok('a video with the wrong size is rejected');

    const bad = path.join(work, 'bad.mp4');
    fs.writeFileSync(bad, Buffer.alloc(20000, 7));
    await assert.rejects(render.verifyMp4(bad, { width: 1080, height: 1920 }));
    ok('a corrupt file is never reported as a valid video');

    console.log(`\n${passed} render checks passed`);
  } catch (e) {
    console.error('\nFAILED:', e.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
})();
