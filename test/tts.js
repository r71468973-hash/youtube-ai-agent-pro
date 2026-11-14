'use strict';
/**
 * Voice checks: free Edge-TTS path, and the fallback when a paid voice returns 429 insufficient_quota.
 * A stand-in edge-tts script is used so the spawn/file plumbing is exercised without internet.
 * The real Microsoft endpoint is NOT contacted here; that needs a live run on the server.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
const fakeBin = path.join(work, 'edge-tts');
// Fake CLI: reads --file and --write-media, writes a real 1-second MP3 to the output path.
fs.writeFileSync(fakeBin, `#!/bin/sh
out=""; txt=""
while [ $# -gt 0 ]; do
  case "$1" in --write-media) out="$2"; shift 2;; --file) txt="$2"; shift 2;; *) shift;; esac
done
[ -s "$txt" ] || { echo "empty text" >&2; exit 2; }
ffmpeg -v error -y -f lavfi -i "sine=frequency=440:duration=1" -codec:a libmp3lame "$out"
`);
fs.chmodSync(fakeBin, 0o755);
process.env.EDGE_TTS_BIN = fakeBin;
process.env.DATA_DIR = work;

const providers = require('../lib/providers');
let passed = 0;
const ok = (n) => { passed++; console.log(`  ok  ${n}`); };

(async () => {
  assert.strictEqual(providers.edgeStatus().ok, true);
  ok('edge-tts is reported available when its binary exists');

  const direct = await providers.synthesize({ provider: 'edge', text: 'नमस्ते दोस्तों', language: 'hi', gender: 'male' });
  assert(direct.length > 500, 'edge produced an mp3');
  ok('Edge-TTS returns an MP3 for Hindi male narration (stand-in binary)');

  assert.strictEqual(providers.isQuotaError(new Error('OpenAI TTS: HTTP 429 {"error":{"code":"insufficient_quota"}}')), true);
  assert.strictEqual(providers.isQuotaError(new Error('Piper failed')), false);
  ok('insufficient_quota / 429 is recognised as a quota error');

  // OpenAI cannot be reached from this sandbox, so it fails the same way a quota error does.
  const r = await providers.synthesizeWithFallback({ provider: 'openai', text: 'नमस्ते', language: 'hi', gender: 'male' });
  assert.strictEqual(r.provider, 'edge');
  assert.strictEqual(r.fallbackFrom, 'openai');
  assert(r.audio.length > 500);
  ok('a failing paid voice falls back to the free Edge voice instead of failing the video');

  const picked = providers.pickTtsProvider('hi');
  assert.strictEqual(picked, 'edge', 'auto mode prefers the free voice');
  ok('automatic mode picks the free Edge voice first, so no paid credits are needed');

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${passed} voice checks passed`);
})().catch((e) => { console.error('\nFAILED:', e.message); fs.rmSync(work, { recursive: true, force: true }); process.exitCode = 1; });
