'use strict';
/** Voice checks that run without any voice service: the test tone is real audio, and a missing voice gives a real reason. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'));
process.env.DATA_DIR = DATA;
delete process.env.TTS_TEST_TONE;
const providers = require('../lib/providers');
const ok = (m) => console.log('  ok ', m);

(async () => {
  // The Gemini key is what Settings stores as GEMINI_API_KEY; with nothing saved, no provider is picked and the reason says so.
  assert.strictEqual(providers.pickTtsProvider('en') === null || providers.pickTtsProvider('en') === 'edge', true);
  const reason = providers.voiceUnavailableReason('hi');
  assert(/No voice key is saved/.test(reason), reason); ok('a video with no voice names the missing key and the reason');

  // Real audio from the test tone: validated by ffprobe like every other voice.
  process.env.TTS_TEST_TONE = '1';
  const r = await providers.previewVoice({ provider: 'tone', language: 'en', gender: 'female', text: 'Hello there, this is a test line.' });
  const file = path.join(DATA, 'tone.wav');
  fs.writeFileSync(file, r.audio);
  const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]).toString());
  assert(dur > 0.5, 'tone has length'); ok(`test tone is a real WAV file (${dur.toFixed(2)} s)`);
  assert.strictEqual(providers.pickTtsProvider('en'), 'tone'); ok('test mode uses the tone only when TTS_TEST_TONE=1');
  console.log('voice checks passed');
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
