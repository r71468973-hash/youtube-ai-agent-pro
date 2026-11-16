'use strict';
/**
 * Free sound effects, made in code: no sound files, no downloads, no paid service.
 *  - footsteps while a character walks or runs (timed from the same timeline that moves the character)
 *  - a short whoosh when a character jumps
 * The effects are written to a WAV track and mixed under the voice-over.
 */
const fs = require('fs');

const SR = 44100;

/** Deterministic pseudo-random noise in -1..1 (so the same story always gets the same sounds). */
function noise(i) {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** A soft footstep: a short, low-passed burst of noise with a fast decay. */
function stepSound(len = 0.07) {
  const n = Math.round(len * SR);
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += 0.2 * (noise(i) - lp);
    out[i] = lp * Math.exp(-i / (n * 0.22)) * 0.9;
  }
  return out;
}

/** A whoosh for a jump: noise whose brightness rises, with a smooth in-and-out envelope. */
function whooshSound(len = 0.4) {
  const n = Math.round(len * SR);
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const k = 0.02 + 0.18 * (i / n);
    lp += k * (noise(i + 9000) - lp);
    out[i] = lp * Math.sin((Math.PI * i) / n) * 0.7;
  }
  return out;
}

/**
 * The sound events of every scene, in order. `scenes` is the built list from script.buildSpecs
 * (each has spec.timeline with times inside its scene and a scene duration); scene starts are added up.
 */
function eventsFromScenes(scenes) {
  const events = [];
  let offset = 0;
  for (const sc of scenes) {
    for (const seg of sc.spec.timeline) {
      const moved = Math.abs(seg.to[0] - seg.from[0]) > 0.02;
      if ((seg.action === 'walk' || seg.action === 'run') && moved) {
        const every = seg.action === 'run' ? 0.28 : 0.42;
        for (let t = seg.start + every / 2; t < seg.end; t += every) events.push({ t: offset + t, kind: 'step' });
      } else if (seg.action === 'jump') {
        events.push({ t: offset + seg.start, kind: 'whoosh' });
      }
    }
    offset += sc.duration;
  }
  return events.sort((a, b) => a.t - b.t);
}

/** Writes one 16-bit mono WAV file from float samples (-1..1). */
function writeWav(file, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

/** Builds the effects track for the whole video and writes it as a WAV file. Returns the number of effects. */
function buildSfxTrack(scenes, totalSeconds, file) {
  const events = eventsFromScenes(scenes);
  const samples = new Float32Array(Math.round(totalSeconds * SR));
  const step = stepSound();
  const whoosh = whooshSound();
  events.forEach((ev, k) => {
    const sound = ev.kind === 'step' ? step : whoosh;
    const gain = 0.8 + 0.2 * Math.abs(noise(k)); // small variation so footsteps do not sound identical
    const at = Math.round(ev.t * SR);
    for (let i = 0; i < sound.length && at + i < samples.length; i++) samples[at + i] += sound[i] * gain;
  });
  writeWav(file, samples);
  return events.length;
}

module.exports = { eventsFromScenes, buildSfxTrack, writeWav, stepSound, whooshSound };
