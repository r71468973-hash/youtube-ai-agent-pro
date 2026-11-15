'use strict';
/** Memory monitoring for the 1 GB Railway container. Logs stay small and never throw. */

function rssMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function log(stage) {
  try {
    console.log(`[mem] ${stage}: rss ${rssMb()} MB`);
  } catch { /* logging must never break a render */ }
}

module.exports = { rssMb, log };
