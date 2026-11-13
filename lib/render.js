'use strict';
/** ffmpeg rendering: scene visuals, subtitles (ASS), voiceover, background music, sound effects. */
const fs = require('fs');
const path = require('path');
const { FORMATS } = require('./config');
const { run, mediaDuration } = require('./util');

const FF = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
const PYTHON = process.env.PYTHON || 'python3';
const ANIMATE = path.join(__dirname, 'animate.py');
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

/** Is the cartoon animation engine usable on this machine? Returns null if yes, else the reason. */
async function animatorProblem() {
  try {
    await run(PYTHON, ['-I', '-c', 'import numpy, cv2, scipy.io.wavfile']);
    return null;
  } catch (e) {
    return `The animation engine needs python3 with numpy, opencv and scipy (apt: python3-numpy python3-opencv python3-scipy). ${String(e.message).slice(-160)}`;
  }
}

/** Does fontconfig know a font that covers this language? */
async function fontAvailableFor(lang) {
  if (lang !== 'hi') return true;
  try {
    const { out } = await run('fc-list', [':lang=hi', 'family']);
    return out.trim().length > 0;
  } catch { return true; }
}

const assTime = (t) => {
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const assEscape = (t) => String(t).replace(/\\/g, '').replace(/[{}]/g, '').replace(/\n/g, ' ');

function captionChunks(text, maxWords) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += maxWords) chunks.push(words.slice(i, i + maxWords).join(' '));
  return chunks;
}

function buildAss({ scenes, format, language, captions = true }) {
  const { w, h } = FORMATS[format];
  const isShort = format === 'shorts';
  const font = language === 'hi' ? process.env.SUBTITLE_FONT_HI || 'Noto Sans Devanagari' : process.env.SUBTITLE_FONT_EN || 'DejaVu Sans';
  const size = isShort ? 86 : 56;
  const marginV = isShort ? 420 : 70;
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    `Style: Default,${font},${size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${isShort ? 5 : 4},1,2,70,70,${marginV},1`,
    `Style: Card,${font},${isShort ? 96 : 78},&H0000E6FF,&H000000FF,&H00301040,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,5,90,90,40,1`,
    `Style: CardSub,${font},${isShort ? 54 : 44},&H00FFFFFF,&H000000FF,&H00301040,&H80000000,0,0,0,0,100,100,0,0,1,4,1,5,90,90,40,1`,
    '', '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
  ];
  let t0 = 0;
  for (const sc of scenes) {
    if (sc.card) {
      const a = t0 + 0.15;
      const b = t0 + sc.duration - 0.15;
      lines.push(`Dialogue: 1,${assTime(a)},${assTime(b)},Card,,0,0,0,,{\\an5\\pos(${w / 2},${Math.round(h * (isShort ? 0.16 : 0.2))})\\fad(350,350)}${assEscape(sc.card.title)}`);
      if (sc.card.subtitle) lines.push(`Dialogue: 1,${assTime(a + 0.3)},${assTime(b)},CardSub,,0,0,0,,{\\an5\\pos(${w / 2},${Math.round(h * (isShort ? 0.16 : 0.2) + (isShort ? 175 : 115))})\\fad(350,350)}${assEscape(sc.card.subtitle)}`);
    } else if (captions && sc.narration) {
      const chunks = captionChunks(sc.narration, isShort ? 4 : 8);
      const totalChars = chunks.reduce((a, c) => a + c.length, 0) || 1;
      let t = t0;
      const speech = Math.max(0.5, sc.duration - 0.4);
      for (const c of chunks) {
        const d = (c.length / totalChars) * speech;
        lines.push(`Dialogue: 0,${assTime(t)},${assTime(t + d)},Default,,0,0,0,,${assEscape(c)}`);
        t += d;
      }
    }
    t0 += sc.duration;
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ audio */

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

/** Synthesised sound effects (whoosh, footsteps, chime) placed at scene starts. */
async function makeSfxTrack(scenes, total, outFile) {
  const cues = [];
  let t0 = 0;
  for (const sc of scenes) {
    for (const kind of sc.sfx || []) cues.push({ kind, at: t0, dur: sc.duration });
    t0 += sc.duration;
  }
  if (!cues.length) return null;
  const src = {
    whoosh: () => ({ input: 'anoisesrc=d=0.8:c=pink:a=0.6:r=44100', af: 'highpass=f=250,lowpass=f=3200,afade=t=in:d=0.3,afade=t=out:st=0.35:d=0.45,volume=0.55' }),
    chime: () => ({ input: "aevalsrc='0.3*(sin(2*PI*880*t)+0.6*sin(2*PI*1320*t)+0.4*sin(2*PI*1760*t))*exp(-3.2*t)':s=44100:d=1.8", af: 'volume=0.8' }),
    steps: (c) => ({ input: `aevalsrc='0.9*sin(2*PI*70*t)*exp(-26*mod(t,0.38))':s=44100:d=${c.dur.toFixed(2)}`, af: 'lowpass=f=320,volume=0.5' }),
  };
  const args = [...FF];
  const chains = [];
  cues.forEach((c, k) => {
    const d = src[c.kind](c);
    args.push('-f', 'lavfi', '-i', d.input);
    const delay = Math.max(0, Math.round((c.kind === 'steps' ? c.at + 0.3 : c.at) * 1000));
    chains.push(`[${k}:a]${d.af},adelay=${delay}:all=1[c${k}]`);
  });
  const mixIn = cues.map((_, k) => `[c${k}]`).join('');
  args.push('-filter_complex', `${chains.join(';')};${mixIn}amix=inputs=${cues.length}:normalize=0:duration=longest[a]`, '-map', '[a]', '-t', total.toFixed(2), '-ac', '2', '-ar', '44100', outFile);
  await run('ffmpeg', args);
  return outFile;
}

/* ----------------------------------------------------------------- visuals */

async function renderAnimated({ i, scene, format, workDir, fps }) {
  const { w, h } = FORMATS[format];
  const out = path.join(workDir, `seg_${i}.mp4`);
  const specFile = path.join(workDir, `anim_${i}.json`);
  fs.writeFileSync(specFile, JSON.stringify({
    ...scene.anim, w, h, fps, duration: scene.duration,
    wav: scene.silent ? null : scene.voiceFile,
  }));
  await run(PYTHON, ['-I', ANIMATE, specFile, out]);
  return out;
}

async function renderSegment({ i, scene, format, workDir, fps }) {
  if (scene.anim) return renderAnimated({ i, scene, format, workDir, fps });
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
      '-vf', `scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},zoompan=z='min(zoom+0.0006,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=${fps},format=yuv420p`,
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
 * scenes: [{narration, duration, voiceFile, image?, anim?, card?, silent?, sfx?}]
 */
async function renderVideo({ scenes, format, language, captions, musicFile, musicKind, outFile, workDir, onProgress = () => {}, onStage = () => {} }) {
  const fps = 30;
  const total = scenes.reduce((a, s) => a + s.duration, 0);
  const hasCards = scenes.some((s) => s.card);

  const segs = [];
  for (let i = 0; i < scenes.length; i++) {
    onStage(`${scenes[i].anim ? 'Animating' : 'Rendering'} scene ${i + 1} of ${scenes.length}`);
    segs.push(await renderSegment({ i, scene: scenes[i], format, workDir, fps }));
    onProgress(((i + 1) / scenes.length) * 0.6);
  }

  onStage('Editing: joining scenes and voice');
  fs.writeFileSync(path.join(workDir, 'segs.txt'), segs.map((s) => `file '${path.basename(s)}'`).join('\n'));
  const silentVideo = path.join(workDir, 'video_silent.mp4');
  await run('ffmpeg', [...FF, '-f', 'concat', '-safe', '0', '-i', 'segs.txt', '-c', 'copy', silentVideo], { cwd: workDir });

  fs.writeFileSync(path.join(workDir, 'voice.txt'), scenes.map((s) => `file '${path.basename(s.voiceFile)}'`).join('\n'));
  const voice = path.join(workDir, 'voice.wav');
  await run('ffmpeg', [...FF, '-f', 'concat', '-safe', '0', '-i', 'voice.txt', '-c', 'copy', voice], { cwd: workDir });
  onProgress(0.7);

  let music = musicFile || null;
  if (!music && musicKind) {
    music = path.join(workDir, 'music_bed.wav');
    await makeMusicBed(musicKind, total, music);
  }
  const sfx = await makeSfxTrack(scenes, total, path.join(workDir, 'sfx.wav'));

  const wantAss = hasCards || captions;
  if (wantAss) fs.writeFileSync(path.join(workDir, 'subs.ass'), buildAss({ scenes, format, language, captions }), 'utf8');

  onStage('Editing: subtitles, music, effects and final render');
  const args = [...FF, '-i', 'video_silent.mp4', '-i', 'voice.wav'];
  let idx = 2;
  const mIdx = music ? idx++ : -1;
  const sIdx = sfx ? idx++ : -1;
  if (music) args.push('-stream_loop', '-1', '-i', music);
  if (sfx) args.push('-i', 'sfx.wav');

  const vf = wantAss ? `[0:v]ass=subs.ass${process.env.FONTS_DIR ? `:fontsdir=${process.env.FONTS_DIR}` : ''}[v]` : '[0:v]null[v]';
  const fade = `afade=t=out:st=${Math.max(0, total - 1.5).toFixed(2)}:d=1.5`;
  const parts = [];
  const mix = [];
  if (music) {
    parts.push('[1:a]asplit=2[vo][sc]', `[${mIdx}:a]volume=0.22[m0]`, '[m0][sc]sidechaincompress=threshold=0.04:ratio=8:attack=20:release=400[duck]');
    mix.push('[vo]', '[duck]');
  } else {
    parts.push('[1:a]anull[vo]');
    mix.push('[vo]');
  }
  if (sfx) { parts.push(`[${sIdx}:a]volume=0.6[sf]`); mix.push('[sf]'); }
  parts.push(`${mix.join('')}amix=inputs=${mix.length}:duration=first:normalize=0,${fade}[a]`);

  args.push(
    '-filter_complex', `${vf};${parts.join(';')}`, '-map', '[v]', '-map', '[a]',
    '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-ac', '2', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', path.resolve(outFile)
  );
  await run('ffmpeg', args, { cwd: workDir });
  onProgress(1);
  return { duration: await mediaDuration(outFile) };
}

async function makeThumbnail(videoFile, outFile, at = 1, format = 'long') {
  const wd = format === 'shorts' ? 720 : 1280;
  await run('ffmpeg', [...FF, '-ss', String(at), '-i', videoFile, '-frames:v', '1', '-vf', `scale=${wd}:-2`, '-q:v', '3', outFile]);
}

module.exports = { renderVideo, makeThumbnail, buildAss, fontAvailableFor, animatorProblem };
