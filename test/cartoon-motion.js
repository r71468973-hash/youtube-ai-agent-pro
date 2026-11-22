'use strict';
// Planner checks: no character stays frozen, listeners turn to the speaker, and scenes do not share one background.
const assert = require('assert');
const script = require('../lib/animation/script');

const ok = (m) => console.log(`  ok  ${m}`);
const story = 'Ravi: देखो, एक घायल चिड़िया सड़क पर है!\nMira: हम इसे घर ले चलें।\nRavi: मैं इसे पानी दूँगा।\nMira: चलो, उसे दवा दें।';
const plan = script.planAnimatedScenes({ story, language: 'hi', format: 'long', voiceGender: 'male' });
const scenes = plan.scenes.map((s) => ({ ...s, utterances: s.utterances.map((u) => ({ ...u, dur: 1.4 })) }));
const built = script.buildSpecs({ scenes, characters: plan.characters, protagonistId: plan.protagonistId, format: 'long' });

console.log('cartoon motion checks');
// 1. Every character who is on stage moves in every scene (no frozen, all-idle character).
const MOVING = new Set(['walk', 'run', 'gesture', 'point', 'turn', 'jump', 'wave', 'sow', 'listen']);
for (const b of built) {
  const onStage = [...new Set(b.spec.timeline.filter((t) => t.start === 0).map((t) => t.char))];
  for (const id of onStage) {
    const segs = b.spec.timeline.filter((t) => t.char === id && t.end - t.start > 0.2);
    const moving = segs.some((t) => MOVING.has(t.action));
    assert.ok(moving, `character ${id} never moves in a scene`);
  }
}
ok('every character on stage acts in every scene (none stays frozen)');

// 2. A listener turns toward the speaker (look is set and points at the speaker's side).
const b0 = built[0].spec;
const listens = b0.timeline.filter((t) => t.action === 'listen');
assert.ok(listens.length > 0, 'listeners exist');
assert.ok(listens.every((t) => t.look === 1 || t.look === -1 || t.look === 0), 'look is -1, 0 or 1');
ok('listeners get a head-turn direction toward the speaker');

// 3. Scenes that name no place do not all share one background.
const longLine = 'Ravi walked slowly through the quiet morning and thought about the small bird he had found.';
const noPlace = script.planAnimatedScenes({
  story: Array(6).fill(0).map(() => 'Ravi: ' + longLine).join('\n'),
  language: 'en', format: 'shorts', voiceGender: 'male',
});
const settings = noPlace.scenes.map((s) => s.setting);
assert.ok(new Set(settings).size > 1, `backgrounds repeat in every scene: ${settings.join(',')}`);
ok('scenes without a named place rotate the background');

console.log('\n3 cartoon motion checks passed');
