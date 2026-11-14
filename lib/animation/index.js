'use strict';
/**
 * Animation provider registry. Each provider renders one MP4 clip per scene spec.
 *  - local-3d       free, default: headless Chrome + three.js on this server (real 3D animation)
 *  - external-http  optional: any paid video-generation service that matches lib/animation/external.js
 */
const store = require('../store');
const vault = require('../vault');
const local3d = require('./local3d');
const external = require('./external');

const IDS = ['local-3d', 'external-http'];

function config() {
  const s = store.getSettings();
  return {
    id: IDS.includes(s.animationProvider) ? s.animationProvider : 'local-3d',
    endpoint: s.animationEndpoint || '',
    key: vault.get('VIDEO_API_KEY') || null,
  };
}

/** Status of every provider, so the dashboard can show what works and why not. */
function statuses() {
  const cfg = config();
  return [local3d.status(), external.status({ endpoint: cfg.endpoint, key: cfg.key })];
}

function current() {
  const cfg = config();
  return statuses().find((s) => s.id === cfg.id);
}

async function renderScenes(specs, opts) {
  const cfg = config();
  if (cfg.id === 'local-3d') return local3d.renderClips(specs, opts);
  if (cfg.id === 'external-http') return external.renderScenes(specs, { ...opts, endpoint: cfg.endpoint, key: cfg.key });
  throw new Error(`Unknown animation provider: ${cfg.id}`);
}

module.exports = { config, statuses, current, renderScenes, IDS };
