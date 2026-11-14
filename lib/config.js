'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '3000', 10);

module.exports = {
  ROOT,
  PORT,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  DATA_DIR: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
  BASE_URL: (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, ''),
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  // Where API keys may be stored/entered. Names outside this list are rejected.
  KEY_NAMES: [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'ELEVENLABS_API_KEY',
    'GOOGLE_TTS_API_KEY',
    'YOUTUBE_CLIENT_ID',
    'YOUTUBE_CLIENT_SECRET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'VIDEO_API_KEY',
  ],
  LIMITS: {
    storyMin: 20,
    storyMax: 20000,
    musicMaxBytes: 30 * 1024 * 1024,
    maxSceneWords: { shorts: 24, long: 48 },
    maxScenes: { shorts: 10, long: 40 },
  },
  FORMATS: {
    shorts: { w: 1080, h: 1920, label: 'YouTube Short (9:16)' },
    long: { w: 1920, h: 1080, label: 'Long video (16:9)' },
  },
};
