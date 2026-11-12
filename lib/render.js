'use strict';
/** ffmpeg rendering: scene backgrounds, subtitles (ASS), voiceover track, background music. */
const fs = require('fs');
const path = require('path');
const { FORMATS } = require('./config');
const { run, mediaDuration } = require('./util');

const FF = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
const PALETTE = [
  ['0x1b1f3b', '0x6a3ea1'], ['0x0f2027', '0x2c7a7b'], ['0x2b1055', '0xd53369'], ['0x141e30', '0x243b55'],
  ['0x42275a', '0x734b6d'], ['0x0b486b', '0xf56217'], ['0x232526', '0x414345'], ['0x1d2671', '0xc33764'],
];

let filterCache = null;
async function hasFilter(name) {
  if (!filterCache) {
    const { out } = await run('ffmpeg', ['-hide_banner', '-filters']);
    filterCache = out;
  }
  return new RegExp(`\\s${name}\\s`).test(filterCache);
}

/** Does fontconfig know a font that covers this language? Used to warn about missing Devanagari fonts. */
async function fontAvailableFor(lang) {
  if (lang !== 'hi') return true;
  try {
    const { out } = await run('fc-list', [':lang=hi', 'family']);
    return out.trim().length > 0;
  } catch { return true; } // cannot check: do not block
}

const assTime = (t) => {
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const assEscape = (t) => t.replace(/\\/g, '').replace(/[{}]/g, '').replace(/\n/g, ' ');

/** Split narration into short caption chunks, timed proportionally to length. */
function captionChunks(text, maxWords) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += maxWords) chunks.push(words.slice(i, i + maxWords).join(' '));
  return chunks;
}

function buildAss({ scenes, format, language }) {
  const { w, h } = FORMATS[format];
  const isShort = format === 'shorts';
  const font = language === 'hi' ? process.env.SUBTITLE_FONT_HI || 'Noto Sans Devanagari' : process.env.SUBTITLE_FONT_EN || 'DejaVu Sans';
  const size = isShort ? 74 : 52;
  const marginV = isShort ? 420 : 70;
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    `Style: Default,${font},${size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${isShort ? 5 : 4},1,2,70,70,${marginV},1`,
    '', '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
  ];
  let t0 = 0;
  for (const sc of scenes) {
    const chunks = captionChunks(sc.narration, isShort ? 4 : 8);
    const totalChars = chunks.reduce((a, c) => a + c.length, 0) || 1;
    let t = t0;
    const speech = Math.max(0.5, sc.duration - 0.4); // trailing pad has no speech
    for (const c of chunks) {
      const d = (c.length / totalChars) * speech;
      lines.push(`Dialogue: 0,${assTime(t)},${assTime(t + d)},Default,,0,0,0,,${assEscape(c)}`);
      t += d;
    }
    t0 += sc.duration;
  }
  return lines.join('\n') + '\n';
}

/** Synthesised, copyright-free background music beds. */
async function makeMusicBed(kind, seconds, outFile) {
  const chords = {
    'ambient-calm': [110, 164.81, 220, 261.63],
    'ambient-bright': [130.81, 164.81, 196, 261.63],
  };
  const f = chords[kind] || chords['ambient-calm'];
  const expr = f.map((hz, i) => `${(0.26 - i * 0.04).toFixed(2)}*sin(2*PI*${hz}*t)`).join('+');
  await run('ffmpeg', [
    ...FF, '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=44100:d=${Math.ceil(seconds) + 1}`,
    '-af', 'tremolo=f=0.15:d=0.4,lowpass=f=1400,aecho=0.8:0.7:500:0.35', '-ac', '2', outFile,
  ]);
}

/** Alternating camera moves (zoom in, zoom out, pan) so scenes feel animated. */
function motion(i, frames) {
  const m = [
    "z='min(zoom+0.0006,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
    "z='if(eq(on,1),1.2,max(zoom-0.0006,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
    "z=1.2:x='(iw-iw/zoom)*on/(d)':y='ih/2-(ih/zoom/2)'",
    `z=1.2:x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)'`,
  ];
  return m[i % m.length];
}

async function renderSegment({ i, scene, format, workDir, fps }) {
  const { w, h } = FORMATS[format];
  const out = path.join(workDir, `seg_${i}.mp4`);
  const d = scene.duration.toFixed(3);
  const enc = ['-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps), '-t', d, out];
  if (scene.image) {
    const frames = Math.ceil(scene.duration * fps);
    const bw = Math.round(w * 1.25);
    const bh = Math.round(h * 1.25);
    await run('ffmpeg', [
      ...FF, '-i', scene.image,
      '-vf', `scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},zoompan=${motion(i, frames)}:d=${frames}:s=${w}x${h}:fps=${fps},format=yuv420p`,
      ...enc,
    ]);
  } else {
    const [c0, c1] = PALETTE[i % PALETTE.length];
    const src = (await hasFilter('gradients'))
      ? `gradients=s=${w}x${h}:d=${d}:c0=${c0}:c1=${c1}:speed=0.015:rate=${fps}`
      : `color=c=${c0}:s=${w}x${h}:d=${d}:r=${fps}`;
    await run('ffmpeg', [...FF, '-f', 'lavfi', '-i', src, ...enc]);
  }
  return out;
}

/**
 * scenes: [{narration, duration, voiceFile (wav, duration-padded), image?}]
 * opts: {format, language, captions, musicFile|musicKind|null, outFile, workDir, onProgress}
 */
async function renderVideo({ scenes, format, language, captions, musicFile, musicKind, outFile, workDir, onProgress = () => {} }) {
  const fps = 30;
  const total = scenes.reduce((a, s) => a + s.duration, 0);

  const segs = [];
  for (let i = 0; i < scenes.length; i++) {
    segs.push(await renderSegment({ i, scene: scenes[i], format, workDir, fps }));
    onProgress((i + 1) / scenes.length * 0.6);
  }

  const listFile = path.join(workDir, 'segs.txt');
  fs.writeFileSync(listFile, segs.map((s) => `file '${path.basename(s)}'`).join('\n'));
  const silentVideo = path.join(workDir, 'video_silent.mp4');
  await run('ffmpeg', [...FF, '-f', 'concat', '-safe', '0', '-i', 'segs.txt', '-c', 'copy', silentVideo], { cwd: workDir });

  const voiceList = path.join(workDir, 'voice.txt');
  fs.writeFileSync(voiceList, scenes.map((s) => `file '${path.basename(s.voiceFile)}'`).join('\n'));
  const voice = path.join(workDir, 'voice.wav');
  await run('ffmpeg', [...FF, '-f', 'concat', '-safe', '0', '-i', 'voice.txt', '-c', 'copy', voice], { cwd: workDir });
  onProgress(0.7);

  let music = musicFile || null;
  if (!music && musicKind) {
    music = path.join(workDir, 'music_bed.wav');
    await makeMusicBed(musicKind, total, music);
  }

  if (captions) fs.writeFileSync(path.join(workDir, 'subs.ass'), buildAss({ scenes, format, language }), 'utf8');

  const args = [...FF, '-i', 'video_silent.mp4', '-i', 'voice.wav'];
  if (music) args.push('-stream_loop', '-1', '-i', music);
  const vf = captions ? `[0:v]ass=subs.ass${process.env.FONTS_DIR ? `:fontsdir=${process.env.FONTS_DIR}` : ''}[v]` : '[0:v]null[v]';
  const fade = `afade=t=out:st=${Math.max(0, total - 1.5).toFixed(2)}:d=1.5`;
  const af = music
    ? `[1:a]asplit=2[vo][sc];[2:a]volume=0.22[m0];[m0][sc]sidechaincompress=threshold=0.04:ratio=8:attack=20:release=400[duck];[vo][duck]amix=inputs=2:duration=first:normalize=0,${fade}[a]`
    : `[1:a]${fade}[a]`;
  args.push(
    '-filter_complex', `${vf};${af}`, '-map', '[v]', '-map', '[a]',
    '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', path.resolve(outFile)
  );
  await run('ffmpeg', args, { cwd: workDir });
  onProgress(1);
  return { duration: await mediaDuration(outFile) };
}

async function makeThumbnail(videoFile, outFile, at = 1) {
  await run('ffmpeg', [...FF, '-ss', String(at), '-i', videoFile, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', outFile]);
}

module.exports = { renderVideo, makeThumbnail, buildAss, fontAvailableFor };
