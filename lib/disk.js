'use strict';
/**
 * Free-space checks for the data volume. A full volume used to surface as a generic "Internal server error";
 * now it returns a clear 507 message that tells the owner what to do.
 */
const fs = require('fs');

const MIN_FREE_MB = 80; // room for one job's temporary files plus the database write

const STORAGE_FULL_MESSAGE = 'The server storage is full. Delete old videos in the Videos tab, or increase the volume size in Railway, then try again.';

function freeMb(dir) {
  const s = fs.statfsSync(dir);
  return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
}

function isNoSpace(e) {
  return !!e && (e.code === 'ENOSPC' || /no space left on device/i.test(String((e && e.message) || '')));
}

/** Throws a 507 error (with a clear message) when the volume has less than minMb free. */
function assertRoom(dir, minMb = MIN_FREE_MB) {
  const free = freeMb(dir);
  if (free < minMb) {
    throw Object.assign(new Error(`${STORAGE_FULL_MESSAGE} (${free} MB free, ${minMb} MB needed.)`), { code: 507 });
  }
  return free;
}

/** Maps a raw disk-full error to the clear 507 error; other errors are returned unchanged. */
function asStorageError(e) {
  if (!isNoSpace(e)) return e;
  return Object.assign(new Error(STORAGE_FULL_MESSAGE), { code: 507 });
}

module.exports = { freeMb, isNoSpace, assertRoom, asStorageError, MIN_FREE_MB, STORAGE_FULL_MESSAGE };
