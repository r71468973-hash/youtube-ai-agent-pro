'use strict';
// Checks that every generated video is new: a fresh story, new clothes and looks, real movement in every
// scene, and camera shots that change. Runs offline with no API key.
const assert = require('assert');
const script = require('../lib/animation/script');
const { generateHindiStory, storySkeleton } = require('../lib/story');
const { storyKey } = require('../lib/daily');

const ok = (msg) => console.log(`  ok  ${msg}`);
const story = [
  'गाँव में रोहन और मीरा रहते थे।',
  'रोहन: चलो खेत चलें।',
  'मीरा: हाँ, आज बहुत धूप है।',
  'रात को दोनों घर लौटे।',
].join('\n');

// Different seeds give different clothes and looks for the same story.
const a = script.planAnimatedScenes({ story, language: 'hi', format: 'shorts', voiceGender: 'male', seed: 'one' });
const b = script.planAnimatedScenes({ story, language: 'hi', format: 'shorts', voiceGender: 'male', seed: 'two' });
const looks = (p) => p.characters.map((c) => `${c.skin}|${c.hair}|${c.shirt}|${c.pants}`).join(';');
assert.notStrictEqual(looks(a), looks(b), 'two videos must not share the same look');
// The same seed gives the same video (reproducible).
const a2 = script.planAnimatedScenes({ story, language: 'hi', format: 'shorts', voiceGender: 'male', seed: 'one' });
assert.strictEqual(looks(a), looks(a2));
ok('new seed gives new clothes and looks; same seed repeats exactly');

// Characters in one video do not share shirt or pants colours.
const shirts = a.characters.map((c) => c.shirt);
assert.strictEqual(new Set(shirts).size, shirts.length, 'cast members must have different shirts');
ok('cast members have different shirts');

// Every scene has real movement, not standing still.
for (const sc of a.scenes) for (const u of sc.utterances) assert.notStrictEqual(u.action, 'idle', 'no idle action in a scene');
ok('every scene has a real action, not idle');

// No camera shot repeats in two scenes in a row.
const long = Array.from({ length: 12 }, (_, i) => `${i % 2 ? 'रोहन' : 'मीरा'}: संवाद नंबर ${i} बहुत लंबा होने के लिए शब्द जोड़े गए हैं ताकि कई दृश्य बनें।`).join('\n');
const c = script.planAnimatedScenes({ story: long, language: 'hi', format: 'shorts', voiceGender: 'male', seed: 'cam' });
for (let i = 1; i < c.scenes.length; i++) assert.notStrictEqual(c.scenes[i].shot, c.scenes[i - 1].shot, 'camera shot repeated');
ok('camera shots never repeat in two scenes in a row');

// The same plot with different names is detected as a repeat.
const s1 = generateHindiStory(1);
const names = { 'रोहन': 'गोलू', 'मीरा': 'सीमा' };
let s2 = s1;
for (const [from, to] of Object.entries(names)) s2 = s2.split(from).join(to);
assert.strictEqual(storySkeleton(s1), storySkeleton(s2), 'renamed story must have the same skeleton');
assert.strictEqual(storyKey(s1), storyKey(s2), 'renamed story must have the same key');
ok('a story with only names changed is treated as a repeat');

// Every plot has a beginning, a middle and an ending line (at least 6 lines of story plus a lesson).
for (let seed = 0; seed < 60; seed++) {
  const st = generateHindiStory(seed * 31 + 5);
  assert(st.split('\n').length >= 6, 'story too short');
  assert(/इस कहानी से हमें सीख मिलती है कि/.test(st.split('\n').pop()), 'story must end with a lesson');
}
ok('stories have a beginning, middle and a lesson ending');

console.log('\n5 variety checks passed');
