'use strict';
/**
 * Voice checks: retry behavior, valid audio verification, Hindi voices, and free Piper fallback.
 * A stand-in edge-tts executable keeps the test independent of Microsoft's network service.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
const fakeBin = path.join(work, 'edge-tts');
const callsFile = path.join(work, 'calls');
process.env.FAKE_EDGE_CALLS = callsFile;
fs.writeFileSync(fakeBin, `#!/bin/sh
out=""; txt=""
while [ $# -gt 0 ]; do
  case "$1" in --write-media) out="$2"; shift 2;; --file) txt="$2"; shift 2;; *) shift;; esac
done
[ -s "$txt" ] || { echo "empty text" >&2; exit 2; }
printf x >> "$FAKE_EDGE_CALLS"
grep -q FAILEDGE "$txt" && { echo "NoAudioReceived (stand-in)" >&2; exit 1; }
grep -q INVALIDEDGE "$txt" && { printf 'not an audio stream' > "$out"; exit 0; }
ffmpeg -v error -y -f lavfi -i "sine=frequency=440:duration=1" -codec:a libmp3lame "$out"
`);
fs.chmodSync(fakeBin, 0o755);
process.env.EDGE_TTS_BIN = fakeBin;
process.env.EDGE_TTS_RETRY_DELAY_MS = '10';
process.env.EDGE_TTS_TIMEOUT_MS = '5000';

const fakePiper = path.join(work, 'piper');
fs.writeFileSync(fakePiper, `#!/bin/sh
out=""
while [ $# -gt 0 ]; do case "$1" in --output_file) out="$2"; shift 2;; *) shift;; esac; done
cat > /dev/null
ffmpeg -v error -y -f lavfi -i "sine=frequency=330:duration=1" "$out"
`);
fs.chmodSync(fakePiper, 0o755);
fs.writeFileSync(path.join(work, 'model.onnx'), 'x');
process.env.PIPER_BIN = fakePiper;
process.env.PIPER_MODEL = path.join(work, 'model.onnx');
process.env.DATA_DIR = work;

const providers = require('../lib/providers');
let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

(async () => {
  assert.strictEqual(providers.edgeStatus().ok, true);
  ok('edge-tts is reported available when its binary exists');

  const direct = await providers.synthesize({ provider: 'edge', text: 'नमस्ते दोस्तों', language: 'hi', gender: 'male' });
  assert(direct.length > 500, 'edge produced audio');
  assert((await require('../lib/util').mediaDuration(await writeAudioForDuration(direct))).duration > 0);
  ok('Hindi male narration is generated and decoded as valid audio');

  assert.strictEqual(providers.isQuotaError(new Error('OpenAI TTS: HTTP 429 {"error":{"code":"insufficient_quota"}}')), true);
  assert.strictEqual(providers.isQuotaError(new Error('Piper failed')), false);
  ok('insufficient_quota / 429 is recognised as a quota error');

  const before = fs.existsSync(callsFile) ? fs.statSync(callsFile).size : 0;
  const fallback = await providers.synthesizeWithFallback({ provider: 'edge', text: 'FAILEDGE नमस्ते', language: 'hi', gender: 'male' });
  assert.strictEqual(fallback.provider, 'piper');
  assert.strictEqual(fallback.fallbackFrom, 'edge');
  assert(fallback.audio.length > 500);
  const retryCount = fs.statSync(callsFile).size - before;
  assert.strictEqual(retryCount, 4, 'one attempt plus three automatic retries');
  ok('NoAudioReceived is retried three times, then free offline Piper is used');

  const corrupt = await providers.synthesizeWithFallback({ provider: 'edge', text: 'INVALIDEDGE नमस्ते', language: 'hi', gender: 'female' });
  assert.strictEqual(corrupt.provider, 'piper', 'corrupt Edge output must never be returned');
  assert(corrupt.audio.length > 500);
  ok('corrupt/non-audio output is rejected before fallback audio is returned');

  const picked = providers.pickTtsProvider('hi');
  assert.strictEqual(picked, 'edge', 'auto mode prefers the free voice');
  ok('automatic mode picks the free Edge voice first');

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${passed} voice checks passed`);
})().catch((e) => {
  console.error('\nFAILED:', e.stack || e.message);
  fs.rmSync(work, { recursive: true, force: true });
  process.exitCode = 1;
});

async function writeAudioForDuration(audio) {
  const file = path.join(work, `verify-${Date.now()}.mp3`);
  fs.writeFileSync(file, audio);
  return file;
}
