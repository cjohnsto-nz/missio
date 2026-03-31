/**
 * Missio Demo Server – local binary upload test server
 *
 * Usage:
 *   node examples/demo-api/server.js
 *
 * Runs on http://localhost:3456
 *
 * Routes:
 *   GET  /health              – liveness check
 *   POST /upload              – accepts any binary body, returns upload info as JSON
 *   POST /upload/image        – accepts image, echoes bytes back with the same Content-Type
 *   POST /upload/pdf          – accepts PDF, returns byte count + first-line preview
 *   POST /upload/text         – accepts text/*, returns byte count + first-line preview
 *
 * On first run the server creates ./fixtures/ with a couple of sample files:
 *   fixtures/sample.png  – 1×1 red pixel PNG
 *   fixtures/sample.txt  – plain text file
 *
 * These are used by the "Binary Upload" requests in the demo collection.
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT         = 3456;
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// ── Minimal 1×1 red pixel PNG (base64) ───────────────────────────────────────
const SAMPLE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4' +
  'z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';

// ── Ensure sample fixtures exist ──────────────────────────────────────────────
function ensureFixtures() {
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }

  const pngPath = path.join(FIXTURES_DIR, 'sample.png');
  if (!fs.existsSync(pngPath)) {
    fs.writeFileSync(pngPath, Buffer.from(SAMPLE_PNG_B64, 'base64'));
    console.log('  [fixtures] created sample.png (1×1 red pixel PNG)');
  }

  const txtPath = path.join(FIXTURES_DIR, 'sample.txt');
  if (!fs.existsSync(txtPath)) {
    fs.writeFileSync(
      txtPath,
      'Hello from Missio!\nThis file is used to test binary (file) request bodies.\n'
    );
    console.log('  [fixtures] created sample.txt');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function collectBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end',  ()      => resolve(Buffer.concat(chunks)));
  });
}

function addCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

// ── Request handler ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  addCorsHeaders(res);

  const { method, url, headers } = req;
  const contentType = headers['content-type'] || 'application/octet-stream';

  // Pre-flight
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  console.log(`  ${method} ${url}  (${contentType})`);

  // ── GET /health ────────────────────────────────────────────────────────────
  if (method === 'GET' && url === '/health') {
    return json(res, 200, {
      status:  'ok',
      server:  'Missio Demo Server',
      version: '1.0.0',
      port:    PORT,
    });
  }

  // ── POST /upload ───────────────────────────────────────────────────────────
  // Generic binary upload: accepts anything, returns metadata.
  if (method === 'POST' && url === '/upload') {
    const body = await collectBody(req);
    return json(res, 200, {
      received:            true,
      contentType,
      contentLengthHeader: headers['content-length'] !== undefined
        ? parseInt(headers['content-length'], 10)
        : null,
      actualBytes:         body.length,
      isImage:             contentType.startsWith('image/'),
      isPdf:               contentType === 'application/pdf',
      isText:              contentType.startsWith('text/'),
    });
  }

  // ── POST /upload/image ─────────────────────────────────────────────────────
  // Echoes the image body back with the same Content-Type so it can be
  // previewed in the Missio response panel as an image.
  if (method === 'POST' && url === '/upload/image') {
    const body = await collectBody(req);
    if (!contentType.startsWith('image/')) {
      return json(res, 415, {
        error:          'Unsupported Media Type',
        expected:       'image/*',
        received:       contentType,
      });
    }
    res.writeHead(200, {
      'Content-Type':   contentType,
      'Content-Length': body.length,
      'X-Bytes-Received': body.length,
    });
    res.end(body);
    return;
  }

  // ── POST /upload/pdf ───────────────────────────────────────────────────────
  if (method === 'POST' && url === '/upload/pdf') {
    const body = await collectBody(req);
    const isPdf = contentType === 'application/pdf';
    return json(res, isPdf ? 200 : 415, {
      received:    isPdf,
      contentType,
      bytes:       body.length,
      ...(isPdf
        ? { firstBytes: body.slice(0, 5).toString('ascii') }
        : { error: 'Expected application/pdf' }),
    });
  }

  // ── POST /upload/text ──────────────────────────────────────────────────────
  if (method === 'POST' && url === '/upload/text') {
    const body = await collectBody(req);
    const isText = contentType.startsWith('text/');
    const preview = isText ? body.toString('utf8').split('\n')[0] : null;
    return json(res, 200, {
      received:    true,
      contentType,
      bytes:       body.length,
      firstLine:   preview,
    });
  }

  // ── 404 ────────────────────────────────────────────────────────────────────
  json(res, 404, { error: 'Not Found', path: url });
});

// ── Start ─────────────────────────────────────────────────────────────────────
ensureFixtures();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nMissio Demo Server  →  http://localhost:${PORT}\n`);
  console.log('Routes:');
  console.log(`  GET  http://localhost:${PORT}/health`);
  console.log(`  POST http://localhost:${PORT}/upload          (any binary body → JSON info)`);
  console.log(`  POST http://localhost:${PORT}/upload/image    (image body → echoed back)`);
  console.log(`  POST http://localhost:${PORT}/upload/pdf      (PDF body → JSON info)`);
  console.log(`  POST http://localhost:${PORT}/upload/text     (text body → JSON + preview)`);
  console.log('\nFixture files for demo requests:');
  console.log(`  ${path.join(FIXTURES_DIR, 'sample.png')}`);
  console.log(`  ${path.join(FIXTURES_DIR, 'sample.txt')}`);
  console.log('\nPress Ctrl+C to stop.\n');
});
