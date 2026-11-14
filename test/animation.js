'use strict';
/** Unit checks for the animation layer: story parsing, timelines, and the external-provider contract. */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const script = require('../lib/animation/script');
const external = require('../lib/animation/external');

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

// --- story parsing
const blocks = script.parseBlocks('रमेश: चलो पार्क चलते हैं।\nप्रिया [F]: हाँ!\nबाहर बारिश हो रही थी।');
assert.strictEqual(blocks[0].speaker, 'रमेश');
assert.strictEqual(blocks[1].gender, 'F');
assert.strictEqual(blocks[2].speaker, null);
ok('Hindi dialogue, gender tag and narration parsed');

assert.strictEqual(script.parseSpeaker('Once upon a time in a far away village: a girl walked'), null);
ok('a sentence with a colon stays narration');

// --- planning and timelines
const story = 'Ravi: Let us run to the park!\nSita [F]: Yes, I will walk with you.\nThe two friends played in the garden and were very happy. Later they walked home in the evening.';
const plan = script.planAnimatedScenes({ story, language: 'en', format: 'shorts', voiceGender: 'female' });
assert.strictEqual(plan.characters.length, 2);
assert.strictEqual(plan.characters[0].gender, 'M');
assert.strictEqual(plan.characters[1].gender, 'F');
assert.strictEqual(plan.characters[0].id, 'c1');
ok('cast built with stable ids and genders');
assert.strictEqual(plan.scenes[0].utterances[0].action, 'run');
ok('actions inferred from keywords');

const scenes = plan.scenes.map((s) => ({
  ...s,
  utterances: s.utterances.map((u, i) => ({ ...u, dur: 1.5 + i * 0.3, wav: `line_${i}.wav` })),
}));
const built = script.buildSpecs({ scenes, characters: plan.characters, protagonistId: plan.protagonistId, format: 'shorts' });
for (const [k, b] of built.entries()) {
  const sc = scenes[k];
  // Voice layout must add up to exactly the scene duration.
  let idx = 0;
  let total = 0;
  for (const p of b.layout) {
    if (p.file) total += sc.utterances[idx++].dur;
    else total += p.silence;
  }
  assert(Math.abs(total - b.duration) < 1e-6, `voice layout ${total} != duration ${b.duration}`);
  assert.strictEqual(b.duration * script.FPS, Math.round(b.duration * script.FPS), 'duration must be whole frames');
  // Every character has contiguous, non-overlapping segments covering the whole scene.
  for (const c of b.spec.characters) {
    const segs = b.spec.timeline.filter((t) => t.char === c.id).sort((x, y) => x.start - y.start);
    assert.strictEqual(segs[0].start, 0, `${c.id} starts at 0`);
    for (let i = 1; i < segs.length; i++) {
      assert(Math.abs(segs[i].start - segs[i - 1].end) < 1e-3, `${c.id} segments contiguous at ${segs[i].start}`);
    }
    assert(Math.abs(segs[segs.length - 1].end - b.duration) < 1e-3, `${c.id} covers the scene`);
  }
  // Lip-sync only while a dialogue line is playing.
  for (const t of b.spec.timeline.filter((t) => t.speak)) {
    assert(b.cues.some((cue) => Math.abs(cue.start - t.start) < 1e-3 && Math.abs(cue.end - t.end) < 1e-3), 'speaking window matches a subtitle cue');
  }
}
ok('voice layout equals scene length; timelines contiguous; lip-sync matches subtitles');

// --- external provider contract (mock job API serving a real MP4)
(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-'));
  const src = path.join(work, 'src.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24', '-t', '2', '-pix_fmt', 'yuv420p', src]);
  let polls = 0;
  const srv = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/video.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return fs.createReadStream(src).pipe(res); }
    if (req.headers.authorization !== 'Bearer test-key') return json(401, { error: 'bad key' });
    if (req.url === '/credits') return json(402, { error: 'insufficient credits' });
    if (req.method === 'POST' && req.url === '/jobs') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const b = JSON.parse(body);
        assert(b.prompt.includes('3D animated cartoon'));
        json(200, { jobId: 'j1' });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/jobs/j1') {
      polls++;
      return json(200, polls < 2 ? { status: 'running' } : { status: 'succeeded', videoUrl: `http://127.0.0.1:${srv.address().port}/video.mp4` });
    }
    json(404, { error: 'not found' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const spec = { setting: 'park', duration: 1.5, characters: [], timeline: [] };
    const clips = await external.renderScenes([spec], { endpoint: `${base}/jobs`, key: 'test-key', width: 540, height: 960, fps: 24, workDir: work });
    assert.strictEqual(clips.length, 1);
    assert(Math.abs(Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clips[0].file]).toString()) - 1.5) < 0.05, 'clip trimmed to scene length');
    assert(polls >= 2, 'job was polled until it succeeded');
    ok('external provider: submit, poll, download and normalise a clip');

    await assert.rejects(
      external.renderScenes([spec], { endpoint: `${base}/jobs`, key: 'wrong', width: 540, height: 960, fps: 24, workDir: work }),
      /HTTP 401/,
    );
    ok('external provider: wrong key reported');

    await assert.rejects(
      external.renderScenes([spec], { endpoint: `${base}/credits`, key: 'test-key', width: 540, height: 960, fps: 24, workDir: work }),
      /no credits or quota left/,
    );
    ok('external provider: no credits reported honestly (not faked)');
  } finally {
    srv.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(`\n${passed} animation checks passed`);
})().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exitCode = 1;
});
