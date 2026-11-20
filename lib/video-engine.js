'use strict';
/**
 * Picks the engine for one scene and falls back safely.
 *  - Gemini Omni (paid) runs only when GEMINI_API_KEY is set AND the job carries an approval for its exact estimate.
 *  - Otherwise, or if Gemini fails or its clip fails the quality gate, the free 2D renderer is used.
 * Every result says which engine made the clip, so the app never reports a generated clip as Gemini output
 * when it was not.
 */
const gemini = require('./gemini-video');
const quality = require('./video-quality');

/**
 * opts: {
 *   index, prompt, duration, aspectRatio, resolution, outFile,
 *   approvedUsd,            // approval for this scene's exact estimate; undefined = no paid call
 *   localRender,            // async () => file path, the free 2D renderer for this scene
 *   fetchImpl,              // tests only
 * }
 * Returns { engine: 'gemini' | 'local', file, usd, reason, geminiError? }.
 */
async function renderScene(opts, env = process.env) {
  const expectedSec = opts.duration;
  const notes = [];

  const status = gemini.configStatus(env);
  if (!status.ok) {
    notes.push('Gemini is not configured: GEMINI_API_KEY is missing');
  } else if (opts.approvedUsd === undefined) {
    notes.push('Gemini not used: no approval for paid generation on this job');
  } else {
    try {
      const made = await gemini.generateClip({
        prompt: opts.prompt, duration: opts.duration, aspectRatio: opts.aspectRatio, resolution: opts.resolution,
        outFile: opts.outFile, approvedUsd: opts.approvedUsd, fetchImpl: opts.fetchImpl,
      }, env);
      const check = await quality.checkClip(made.file, { expectedSec });
      if (check.ok) return { engine: 'gemini', file: made.file, usd: made.usd, reason: 'Gemini Omni clip passed the quality check' };
      notes.push(`Gemini clip rejected: ${check.problems.join('; ')}`);
    } catch (e) {
      notes.push(`Gemini failed: ${e.message}`);
      if (e.code === 'approval_required' || e.code === 'spend_limit') throw e;
    }
  }

  // Fallback: the free renderer. It is labelled as such.
  const file = await opts.localRender();
  const check = await quality.checkClip(file, { expectedSec });
  if (!check.ok) {
    throw Object.assign(new Error(`No acceptable clip for scene ${opts.index + 1}: ${check.problems.join('; ')}`), { code: 'scene_rejected' });
  }
  return { engine: 'local', file, usd: 0, reason: notes.join('. ') || 'Free 2D renderer (no paid engine requested)' };
}

module.exports = { renderScene };
