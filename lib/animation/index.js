'use strict';
/**
 * 2D cartoon renderer. The only renderer: headless Chrome drawing 2D cartoon scenes (Canvas 2D) on this
 * server. It is free: no paid service and no API key is used.
 */
const local2d = require('./local2d');

const IDS = ['local-2d'];

function config() {
  return { id: 'local-2d' };
}

/** Status of the renderer, so the dashboard can show whether it works and why not. */
function statuses() {
  return [local2d.status()];
}

function current() {
  return local2d.status();
}

async function renderScenes(specs, opts) {
  return local2d.renderClips(specs, opts);
}

module.exports = { config, statuses, current, renderScenes, IDS };
