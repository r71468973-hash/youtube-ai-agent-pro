'use strict';
/** Cloud storage checks against a local S3-compatible mock (not Cloudflare R2). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
process.env.DATA_DIR = DATA;
process.env.APP_SECRET = 'x'.repeat(32);
const { startMockS3 } = require('./mock-s3');

const R2 = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_ENDPOINT'];
const SECRET = 'r2-secret-VALUE-54321';
const ACCESS = 'test-access-key-id';
const clear = () => R2.forEach((n) => delete process.env[n]);

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

(async () => {
  const mock = await startMockS3({ accessKey: ACCESS, failBuckets: ['broken-bucket'] });
  const storage = require('../lib/storage');
  try {
    // 1. Not configured: clear what is missing (names only), and refuse uploads.
    clear();
    let st = storage.status();
    assert.strictEqual(st.configured, false); ok('no R2 variables means not configured');
    assert(st.missing.length > 0 && st.missing.every((m) => !m.includes(SECRET))); ok('missing items are named, never valued');
    await assert.rejects(storage.putBuffer('videos/x.txt', Buffer.from('x')), /not configured/); ok('upload refused when not configured');

    // 2. Partial R2 config reports exactly what is missing and never echoes the one value given.
    process.env.R2_ACCESS_KEY_ID = ACCESS;
    st = storage.status();
    assert.strictEqual(st.configured, false);
    assert(st.missing.some((m) => /R2_SECRET_ACCESS_KEY/.test(m))); ok('partial config names the missing secret variable');
    assert(!JSON.stringify(st).includes(ACCESS)); ok('access key ID is not shown in the status');

    // 3. Full R2 config from environment variables (endpoint from the account ID, default bucket).
    process.env.R2_ACCOUNT_ID = 'acct123';
    process.env.R2_SECRET_ACCESS_KEY = SECRET;
    process.env.R2_ENDPOINT = mock.url;
    process.env.R2_BUCKET_NAME = 'youtube-ai-agent-storage';
    st = storage.status();
    assert.strictEqual(st.configured, true); assert.strictEqual(st.source, 'environment'); ok('R2 environment variables are recognised');
    assert.strictEqual(st.bucket, 'youtube-ai-agent-storage'); ok('bucket name comes from R2_BUCKET_NAME');
    assert(!JSON.stringify(st).includes(SECRET) && !JSON.stringify(st).includes(ACCESS)); ok('no secret is present in the status output');
    delete process.env.R2_ENDPOINT;
    assert.strictEqual(storage.status().endpointHost, 'acct123.r2.cloudflarestorage.com'); ok('endpoint defaults to the R2 host for the account ID');
    process.env.R2_ENDPOINT = mock.url;

    // 4. Organised keys and unique, safe names.
    assert.strictEqual(storage.videoFolder('abc123', '2026-11-15T10:00:00.000Z'), '2026/11/15/abc123'); ok('files are organised by date and video ID');
    await assert.rejects(storage.putBuffer('../escape.txt', Buffer.from('x')), /Unsafe storage name/); ok('path traversal in storage names is refused');

    // 5. Upload, confirm, download and compare.
    const folder = storage.videoFolder('vid1', '2026-11-15T10:00:00Z');
    const movie = Buffer.from('fake mp4 bytes '.repeat(500));
    const file = path.join(DATA, 'video.mp4');
    fs.writeFileSync(file, movie);
    const saved = await storage.putFile(`${folder}/video.mp4`, file, 'video/mp4');
    assert.strictEqual(saved.key, `videos/${folder}/video.mp4`); assert.strictEqual(saved.verified, true); ok('video uploaded and confirmed at the expected size');
    assert.deepStrictEqual(await storage.getBuffer(`${folder}/video.mp4`), movie); ok('downloaded contents match the upload exactly');

    // 6. Connection test uploads, downloads, deletes its own file, and leaves nothing behind.
    const before = mock.objects('youtube-ai-agent-storage').size;
    const t = await storage.testConnection();
    assert.strictEqual(t.ok, true, t.error); ok('storage connection test passes');
    assert.strictEqual(t.steps.length, 5); ok('test reports each step');
    assert.strictEqual(mock.objects('youtube-ai-agent-storage').size, before); ok('test removes only its own test file');

    // 7. Usage counts by file type, with paging.
    const other = { 'thumb.jpg': 'image/jpeg', 'voice.m4a': 'audio/mp4', 'subtitles.ass': 'text/plain', 'metadata.json': 'application/json', 'scene_1.png': 'image/png' };
    for (const [n, ct] of Object.entries(other)) await storage.putBuffer(`${folder}/${n}`, Buffer.from(n), ct);
    const u = await storage.usage();
    assert.strictEqual(u.counts.videos, 1); assert.strictEqual(u.counts.thumbnails, 1); assert.strictEqual(u.counts.audio, 1);
    assert.strictEqual(u.counts.subtitles, 1); assert.strictEqual(u.counts.metadata, 1); assert.strictEqual(u.counts.images, 1);
    assert.strictEqual(u.objects, 6); ok('usage counts videos, audio, thumbnails, subtitles, images and metadata');
    assert(u.bytes >= movie.length); ok('usage reports bytes stored');
    assert.strictEqual(u.warnings.length, 0); ok('no free-tier warning well under 10 GB');

    // 8. Delete removes the object; a second check finds nothing.
    await storage.deleteObject(`videos/${folder}/thumb.jpg`);
    assert.strictEqual(await storage.headObject(`videos/${folder}/thumb.jpg`), null); ok('delete removes the object');

    // 9. Presigned download link carries no secret value.
    const link = storage.presignGet(`videos/${folder}/video.mp4`);
    assert(link.includes('X-Amz-Signature=') && !link.includes(SECRET)); ok('download link is signed and contains no secret');

    // 10. Outage: failure is reported honestly, recorded, and the secret never appears in the message.
    process.env.R2_BUCKET_NAME = 'broken-bucket';
    await assert.rejects(storage.putBuffer('videos/v/video.mp4', Buffer.from('x')), (e) => {
      assert(/HTTP 500/.test(e.message) && !e.message.includes(SECRET)); return true;
    }); ok('upload failure is raised with the storage status, without secrets');
    assert(storage.status().recentErrors.length > 0); ok('failure is recorded for the dashboard');
    const bad = await storage.testConnection();
    assert.strictEqual(bad.ok, false); assert(!bad.error.includes(SECRET)); ok('connection test reports an outage as a failure');
    process.env.R2_BUCKET_NAME = 'youtube-ai-agent-storage';

    // 11. Wrong access key is refused by the store.
    process.env.R2_ACCESS_KEY_ID = 'wrong-key';
    await assert.rejects(storage.putBuffer('videos/x.txt', Buffer.from('x')), /HTTP 403/); ok('wrong access key is refused');
    process.env.R2_ACCESS_KEY_ID = ACCESS;

    console.log(`\n${passed} storage checks passed`);
  } finally {
    clear();
    await mock.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
