'use strict';
/** ffmpeg rendering: scene backgrounds, subtitles (ASS), voiceover track, background music. */
const fs = require('fs');
const path = require('path');
const { FORMATS, renderSize } = require('./config');
const { run, mediaDuration } = require('./util');
const memory = require('./memory');

const FF = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
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

/** Writes the subtitle file for ffmpeg and keeps a copy beside the video so it can be saved to cloud storage. */
function keepSubtitles(workDir, outFile, ass) {
  fs.writeFileSync(path.join(workDir, 'subs.ass'), ass, 'utf8');
  fs.copyFileSync(path.join(workDir, 'subs.ass'), path.join(path.dirname(outFile), 'subtitles.ass'));
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
    if (sc.cues) {
      // Exact per-line timings (animated mode): each line is shown while it is spoken.
      for (const c of sc.cues) {
        lines.push(`Dialogue: 0,${assTime(t0 + c.start)},${assTime(t0 + c.end)},Default,,0,0,0,,${assEscape(c.text)}`);
      }
      t0 += sc.duration;
      continue;
    }
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

/** Audio bed: voice-over, optionally with a music bed ducked under it. */
function audioGraph(music, fade) {
  return music
    ? `[1:a]asplit=2[vo][sc];[2:a]volume=0.22[m0];[m0][sc]sidechaincompress=threshold=0.04:ratio=8:attack=20:release=400[duck];[vo][duck]amix=inputs=2:duration=first:normalize=0,${fade}[a]`
    : `[1:a]${fade}[a]`;
}

/**
 * 2D cartoon mode: join the rendered clips (one per scene, in order), add the voice-over track,
 * subtitles and music, and encode the final MP4 at the target format size.
 */
async function renderFromClips({ clips, scenes, format, language, captions, musicFile, musicKind, voiceFile, outFile, workDir, onProgress = () => {} }) {
  const total = scenes.reduce((a, s) => a + s.duration, 0);
  const { w, h } = renderSize(format);
  const listFile = path.join(workDir, 'clips.txt');
  fs.writeFileSync(listFile, clips.map((c) => `file '${path.resolve(c.file)}'`).join('\n'));
  const silentVideo = path.join(workDir, 'video_joined.mp4');
  await run('ffmpeg', [...FF, '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', silentVideo]);
  onProgress(0.7);

  let music = musicFile || null;
  if (!music && musicKind) {
    music = path.join(workDir, 'music_bed.wav');
    await makeMusicBed(musicKind, total, music);
  }
  if (captions) keepSubtitles(workDir, outFile, buildAss({ scenes, format, language }));

  const args = [...FF, '-i', silentVideo, '-i', voiceFile];
  if (music) args.push('-stream_loop', '-1', '-i', music);
  const scale = `[0:v]scale=${w}:${h}:flags=lanczos,setsar=1`;
  const fontDir = process.env.FONTS_DIR ? `:fontsdir=${process.env.FONTS_DIR}` : '';
  const vf = captions ? `${scale},ass=subs.ass${fontDir}[v]` : `${scale}[v]`;
  const fade = `afade=t=out:st=${Math.max(0, total - 1.5).toFixed(2)}:d=1.5`;
  args.push(
    '-filter_complex', `${vf};${audioGraph(music, fade)}`, '-map', '[v]', '-map', '[a]',
    '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'
  );
  // One encoder thread keeps memory low on Railway. A kill by a signal (out of memory) or a timeout is retried once.
  const logFile = path.join(workDir, 'ffmpeg_final_error.log');
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      memory.log(`final encode attempt ${attempt}`);
      await run('ffmpeg', [...args, '-threads', '1', path.resolve(outFile)], { cwd: workDir, timeoutMs: 900000, logFile });
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      if (!e.signal && !e.timedOut) break;
    }
  }
  if (lastError) throw lastError;
  onProgress(1);
  // The job is only finished when the file itself checks out.
  return { duration: await verifyMp4(outFile, { width: w, height: h }) };
}

/**
 * Checks a finished MP4 with ffprobe: H.264 video at the expected size, AAC audio of matching length,
 * and a sane duration. Throws if the file is not valid and playable. Returns the duration in seconds.
 */
async function verifyMp4(file, { width, height }) {
  if (!fs.existsSync(file) || fs.statSync(file).size < 10000) throw new Error('Finished video file is missing or empty.');
  const { out } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  let info;
  try { info = JSON.parse(out); } catch (_) { throw new Error('Finished video could not be read by ffprobe.'); }
  const streams = info.streams || [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const duration = parseFloat((info.format && info.format.duration) || '0');
  const problems = [];
  if (!v || v.codec_name !== 'h264') problems.push('no H.264 video stream');
  if (v && (v.width !== width || v.height !== height)) problems.push(`video is ${v.width}x${v.height}, expected ${width}x${height}`);
  if (!a || a.codec_name !== 'aac') problems.push('no AAC audio stream');
  const audioLength = a ? parseFloat(a.duration || '0') : 0;
  if (audioLength > 0 && Math.abs(audioLength - duration) > 0.5) problems.push(`audio (${audioLength.toFixed(2)}s) and video (${duration.toFixed(2)}s) lengths differ`);
  if (!(duration > 1)) problems.push('duration is too short');
  if (problems.length) throw new Error(`Finished video is not valid: ${problems.join('; ')}.`);
  return duration;
}

async function makeThumbnail(videoFile, outFile, at = 1) {
  await run('ffmpeg', [...FF, '-ss', String(at), '-i', videoFile, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', outFile]);
}

module.exports = { renderFromClips, makeThumbnail, buildAss, fontAvailableFor, verifyMp4 };
