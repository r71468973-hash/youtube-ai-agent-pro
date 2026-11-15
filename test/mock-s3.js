'use strict';
/**
 * A small S3-compatible server for tests. It is NOT Cloudflare R2 and does not check SigV4 signatures.
 * It checks what matters for the app: the access key ID in each request, content lengths on PUT,
 * list paging, and a bucket named in failBuckets that always answers with an outage.
 */
const http = require('http');

function startMockS3({ accessKey, failBuckets = [] } = {}) {
  const buckets = new Map(); // bucket -> Map(key -> Buffer)
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const data = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://mock');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const bucket = parts.shift() || '';
      const key = parts.join('/');
      const auth = req.headers.authorization || '';
      if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${accessKey}/`)) {
        res.writeHead(403, { 'content-type': 'application/xml' });
        return res.end('<Error><Code>AccessDenied</Code></Error>');
      }
      if (failBuckets.includes(bucket)) {
        res.writeHead(500, { 'content-type': 'application/xml' });
        return res.end('<Error><Code>InternalError</Code><Message>simulated outage</Message></Error>');
      }
      if (!buckets.has(bucket)) buckets.set(bucket, new Map());
      const store = buckets.get(bucket);

      if (req.method === 'PUT') {
        if (Number(req.headers['content-length']) !== data.length) { res.writeHead(400); return res.end('length mismatch'); }
        store.set(key, data);
        res.writeHead(200);
        return res.end();
      }
      if (req.method === 'HEAD') {
        const o = store.get(key);
        if (!o) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-length': o.length });
        return res.end();
      }
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') || '';
        const all = [...store.entries()].filter(([k]) => k.startsWith(prefix)).sort((a, b) => a[0].localeCompare(b[0]));
        const start = Number(url.searchParams.get('continuation-token') || 0);
        const page = all.slice(start, start + 3); // small pages, so paging is exercised
        const more = start + 3 < all.length;
        const xml = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>'
          + `<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 3}</NextContinuationToken>` : ''}`
          + page.map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`).join('')
          + '</ListBucketResult>';
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(xml);
      }
      if (req.method === 'GET') {
        const o = store.get(key);
        if (!o) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-length': o.length });
        return res.end(o);
      }
      if (req.method === 'DELETE') {
        store.delete(key);
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(405);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({
      url: `http://127.0.0.1:${port}`,
      objects: (bucket) => buckets.get(bucket) || new Map(),
      close: () => new Promise((r) => server.close(r)),
    });
  }));
}

module.exports = { startMockS3 };
