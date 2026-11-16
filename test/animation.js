'use strict';
/** Unit checks for the 2D cartoon layer: story parsing, timelines, backgrounds, sound effects and the renderer. */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const script = require('../lib/animation/script');
const fs2 = fs;
const sfx = require('../lib/sfx');
const { status: rendererStatus } = require('../lib/animation/local2d');

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

// --- backgrounds: forest, courtyard, village default
assert.strictEqual(script.inferSetting('रमेश जंगल में गया'), 'forest');
assert.strictEqual(script.inferSetting('Ravi went to the forest'), 'forest');
assert.strictEqual(script.inferSetting('उसके घर के आंगन में'), 'courtyard');
assert.strictEqual(script.inferSetting('नदी किनारे'), 'river');
const noPlace = script.planAnimatedScenes({ story: 'Ravi: Hello friend!\nThe day was bright and warm.', language: 'en', format: 'shorts', voiceGender: 'male' });
assert.strictEqual(noPlace.scenes[0].setting, 'village');
ok('forest, house courtyard, river and the Indian village default are chosen from the story');

// --- 2D renderer: no 3D code is left in the stage
const stageSrc = fs2.readFileSync(require('path').join(__dirname, '..', 'lib', 'animation', 'stage2d', 'stage.js'), 'utf8');
assert(!/THREE\.|three\.module|WebGLRenderer|getContext\('webgl/i.test(stageSrc), 'the 2D stage must not use 3D code');
assert(fs2.existsSync(require('path').join(__dirname, '..', 'lib', 'animation', 'stage2d', 'index.html')));
assert(!fs2.existsSync(require('path').join(__dirname, '..', 'lib', 'animation', 'stage')), 'the old 3D stage folder must be gone');
ok('the renderer is 2D only: no three.js, no WebGL, no 3D stage files');
const st = rendererStatus();
assert.strictEqual(st.id, 'local-2d');
ok(`2D renderer status reported honestly (${st.ok ? 'Chrome found' : 'Chrome missing: ' + st.reason})`);

// --- sound effects: footsteps for walking and running, a whoosh for jumps; the track has the video's exact length
const fakeScenes = [
  { duration: 3, spec: { timeline: [{ char: 'c1', start: 0.2, end: 2.2, action: 'walk', from: [-3, 0], to: [-1, 0] }] } },
  { duration: 2, spec: { timeline: [{ char: 'c1', start: 0, end: 1.5, action: 'jump', from: [0, 0], to: [0, 0] }] } },
];
const events = sfx.eventsFromScenes(fakeScenes);
assert(events.filter((e) => e.kind === 'step').length >= 4, 'walking makes footsteps');
assert(events.some((e) => e.kind === 'whoosh' && Math.abs(e.t - 3) < 1e-6), 'jump at the start of scene 2 makes a whoosh');
assert(events.every((e) => e.t >= 0 && e.t < 5));
ok('footsteps follow walking and a whoosh follows jumping');
const linked = script.linkTransitions(built.map((b) => ({ duration: b.duration, spec: JSON.parse(JSON.stringify(b.spec)) })));
assert(!linked[0].spec.transition, 'the first scene has no dissolve');
if (linked.length > 1) {
  assert.strictEqual(linked[1].spec.transition.seconds, script.TRANSITION_SEC);
  assert(!linked[1].spec.transition.from.transition, 'no nested dissolves');
  assert(Math.abs(linked[1].spec.transition.fromT - (linked[0].duration - 1 / script.FPS)) < 1e-6);
}
ok('each new scene dissolves in from the final frame of the one before, without nesting');
const sfxWav = require('path').join(require('os').tmpdir(), `sfx-${process.pid}.wav`);
sfx.buildSfxTrack(fakeScenes, 5, sfxWav);
const sfxLen = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', sfxWav]).toString());
assert(Math.abs(sfxLen - 5) < 0.02, 'sound track length ' + sfxLen);
fs2.rmSync(sfxWav, { force: true });
ok('sound-effects track is exactly the video length');

(async () => {
  // --- time of day and camera shots
  assert.strictEqual(script.inferTime('सुबह का सूरज निकला'), 'sunrise');
  assert.strictEqual(script.inferWeather('बाहर बारिश हो रही थी'), 'rain');
  assert.strictEqual(script.inferWeather('तेज़ धूप थी'), 'sun');
  assert.strictEqual(script.inferAction('किसान ने खेत में बीज बोया'), 'sow');
  ok('farm weather (rain, strong sun) and sowing action recognised');
  const { FILLERS } = require('../lib/duration');
  for (const line of [...FILLERS.hi, ...FILLERS.en]) assert.ok(!/रात|सुबह|sunset|night|morning/i.test(line), 'filler changes time of day: ' + line);
  ok('filler lines do not change the time of day');
  assert.strictEqual(script.inferTime('The sun rose over the hills at dawn'), 'sunrise');
  assert.strictEqual(script.inferTime('शाम को दादाजी घर लौटे'), 'evening');
  assert.strictEqual(script.inferTime('Rohan walked to the park.'), null);
  ok('sunrise, evening and unspecified times are detected from Hindi and English');
  const shots = [0, 1, 2, 3].map((k) => script.cameraFor(['wide', 'medium', 'closeup', 'tracking'][k], 1));
  assert.notDeepStrictEqual(shots[0].from, shots[1].from);
  assert.notDeepStrictEqual(shots[1].from, shots[3].from);
  assert(Math.abs(shots[3].to[0] - shots[3].from[0]) > 10, 'tracking shot pans across the scene');
  ok('camera shots differ: wide, medium, close-up and a tracking pan');

  console.log(`\n${passed} animation checks passed`);
})().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exitCode = 1;
});
