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
const { WebSocketServer } = require('ws');

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

function parseJsonBody(buffer) {
  if (!buffer.length) return {};
  return JSON.parse(buffer.toString('utf8'));
}

function buildGraphQLFixture(payload, headers) {
  const query = String(payload.query || '');
  const variables = payload.variables && typeof payload.variables === 'object'
    ? payload.variables
    : {};
  const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase();
  const operation = normalized.startsWith('mutation') ? 'mutation' : 'query';
  const users = [
    { id: '1', name: 'Ada Lovelace', role: 'admin' },
    { id: '2', name: 'Grace Hopper', role: 'maintainer' },
  ];

  let data;
  if (operation === 'mutation') {
    data = {
      createDemoNote: {
        id: 'note-1',
        title: variables.title || 'Untitled note',
        ownerId: variables.ownerId || variables.userId || '1',
        saved: true,
      },
    };
  } else if (normalized.includes('health')) {
    data = {
      health: {
        status: 'ok',
        service: 'Missio Demo GraphQL',
      },
    };
  } else if (normalized.includes('user(') || normalized.includes('demo user')) {
    const id = String(variables.id || variables.userId || '1');
    data = {
      user: users.find(user => user.id === id) || users[0],
    };
  } else {
    data = { users };
  }

  return {
    data,
    extensions: {
      demo: true,
      operation,
      echoedVariables: variables,
      requestHeader: headers['x-demo-token'] || null,
    },
  };
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
  const requestUrl = new URL(url, `http://localhost:${PORT}`);

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
  if (method === 'GET' && url === '/graphql') {
    return json(res, 200, {
      status: 'ok',
      route: '/graphql',
      accepts: 'POST application/json with query and variables',
    });
  }

  if (method === 'POST' && url === '/graphql') {
    const body = await collectBody(req);
    let payload;
    try {
      payload = parseJsonBody(body);
    } catch (error) {
      return json(res, 400, {
        errors: [{ message: `Invalid JSON body: ${error.message}` }],
      });
    }

    return json(res, 200, buildGraphQLFixture(payload, headers));
  }

  if (method === 'GET' && requestUrl.pathname === '/auth/api-key-query') {
    const key = requestUrl.searchParams.get('demo_key');
    return json(res, key === 'demo-token' ? 200 : 401, {
      ok: key === 'demo-token',
      route: '/auth/api-key-query',
      receivedKey: key,
      placement: 'query',
    });
  }

  if (method === 'POST' && requestUrl.pathname === '/oauth/token') {
    const body = await collectBody(req);
    const params = new URLSearchParams(body.toString('utf8'));
    return json(res, 200, {
      access_token: 'demo-oauth-token',
      token_type: 'Bearer',
      expires_in: 3600,
      echoed: {
        queryTrace: requestUrl.searchParams.get('trace'),
        tenant: headers['x-demo-tenant'] || null,
        audience: params.get('audience'),
        grantType: params.get('grant_type'),
      },
    });
  }

  if (method === 'GET' && requestUrl.pathname === '/oauth/resource') {
    const queryToken = requestUrl.searchParams.get('access_token');
    const headerToken = (headers.authorization || '').replace(/^Bearer\s+/i, '');
    const token = queryToken || headerToken;
    return json(res, token === 'demo-oauth-token' ? 200 : 401, {
      ok: token === 'demo-oauth-token',
      route: '/oauth/resource',
      tokenPlacement: queryToken ? 'query' : headerToken ? 'header' : 'missing',
    });
  }

  if (method === 'GET' && requestUrl.pathname === '/redirect/start') {
    res.writeHead(302, { Location: '/redirect/final' });
    res.end();
    return;
  }

  if (method === 'GET' && requestUrl.pathname === '/redirect/final') {
    return json(res, 200, {
      ok: true,
      route: '/redirect/final',
      followed: true,
    });
  }

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
  if ((method === 'GET' || method === 'POST') && url === '/runtime/echo') {
    const body = method === 'POST' ? await collectBody(req) : Buffer.alloc(0);
    let parsedBody = body.toString('utf8');
    if ((contentType || '').includes('json') && parsedBody) {
      try {
        parsedBody = JSON.parse(parsedBody);
      } catch {
        // Keep raw text when intentionally testing bad JSON.
      }
    }
    return json(res, 200, {
      ok: true,
      route: '/runtime/echo',
      method,
      scriptedHeader: headers['x-runtime-script'] || null,
      requestToken: headers['x-runtime-token'] || null,
      body: parsedBody,
    });
  }

  if (method === 'POST' && url === '/runtime/token') {
    const body = await collectBody(req);
    let payload = {};
    try {
      payload = parseJsonBody(body);
    } catch (error) {
      return json(res, 400, {
        ok: false,
        error: `Invalid JSON body: ${error.message}`,
      });
    }
    return json(res, 200, {
      ok: true,
      token: 'runtime-token-123',
      nested: {
        count: 2,
        owner: payload.owner || 'missio-demo',
      },
      scriptedHeader: headers['x-runtime-script'] || null,
      echoedBody: payload,
    });
  }

  if (method === 'GET' && url === '/runtime/assert-fail') {
    return json(res, 200, {
      ok: false,
      expected: 'pass',
      actual: 'fail',
      message: 'This route intentionally fails the demo assertion.',
    });
  }

  json(res, 404, { error: 'Not Found', path: url });
});

function socketPath(requestUrl) {
  try {
    return new URL(requestUrl, `http://localhost:${PORT}`).pathname;
  } catch {
    return requestUrl || '/';
  }
}

function rejectUpgrade(socket, status, message) {
  socket.write([
    `HTTP/1.1 ${status} ${message}`,
    'Connection: close',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n'));
  socket.destroy();
}

function parseSocketMessage(data, isBinary) {
  if (isBinary) {
    return { type: 'binary', base64: Buffer.from(data).toString('base64') };
  }

  const text = Buffer.from(data).toString('utf8');
  try {
    return { type: 'json', value: JSON.parse(text), text };
  } catch {
    return { type: 'text', text };
  }
}

function attachWebSocketFixtures(httpServer) {
  const wss = new WebSocketServer({ noServer: true });
  const supportedRoutes = new Set(['/ws/echo', '/ws/auth', '/ws/close']);

  httpServer.on('upgrade', (req, socket, head) => {
    const route = socketPath(req.url);
    if (route === '/ws/reject') {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    if (!supportedRoutes.has(route)) {
      rejectUpgrade(socket, route.startsWith('/ws/') ? 404 : 400, route.startsWith('/ws/') ? 'Not Found' : 'Bad Request');
      return;
    }

    if (route === '/ws/auth') {
      const bearer = req.headers.authorization === 'Bearer demo-token';
      const client = req.headers['x-demo-client'] === 'missio-demo';
      if (!bearer || !client) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.demoRoute = route;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const route = ws.demoRoute || socketPath(req.url);
    console.log(`  WS ${route}`);

    if (route === '/ws/close') {
      ws.close(4000, 'Missio demo close');
      return;
    }

    ws.on('message', (data, isBinary) => {
      if (route === '/ws/auth') {
        ws.send(JSON.stringify({
          ok: true,
          route,
          authorized: true,
          client: req.headers['x-demo-client'] || null,
          message: parseSocketMessage(data, isBinary),
        }, null, 2));
        return;
      }

      ws.send(data, { binary: isBinary });
    });
  });

  return wss;
}

// ── Start ─────────────────────────────────────────────────────────────────────
ensureFixtures();
attachWebSocketFixtures(server);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nMissio Demo Server  →  http://localhost:${PORT}\n`);
  console.log('Routes:');
  console.log(`  GET  http://localhost:${PORT}/health`);
  console.log(`  GET  http://localhost:${PORT}/graphql        (GraphQL fixture info)`);
  console.log(`  POST http://localhost:${PORT}/graphql        (GraphQL JSON body -> JSON response)`);
  console.log(`  GET  http://localhost:${PORT}/auth/api-key-query?demo_key=demo-token`);
  console.log(`  POST http://localhost:${PORT}/oauth/token    (OAuth2 token fixture)`);
  console.log(`  GET  http://localhost:${PORT}/oauth/resource (OAuth2 protected resource)`);
  console.log(`  GET  http://localhost:${PORT}/redirect/start (302 to /redirect/final)`);
  console.log(`  POST http://localhost:${PORT}/upload          (any binary body → JSON info)`);
  console.log(`  POST http://localhost:${PORT}/upload/image    (image body → echoed back)`);
  console.log(`  POST http://localhost:${PORT}/upload/pdf      (PDF body → JSON info)`);
  console.log(`  POST http://localhost:${PORT}/upload/text     (text body → JSON + preview)`);
  console.log(`  POST http://localhost:${PORT}/runtime/echo    (runtime header/body echo)`);
  console.log(`  POST http://localhost:${PORT}/runtime/token   (runtime token fixture)`);
  console.log(`  GET  http://localhost:${PORT}/runtime/assert-fail (intentional runtime failure)`);
  console.log(`  WS   ws://localhost:${PORT}/ws/echo        (text/json/binary echo)`);
  console.log(`  WS   ws://localhost:${PORT}/ws/auth        (requires bearer + X-Demo-Client headers)`);
  console.log(`  WS   ws://localhost:${PORT}/ws/close       (deterministic server close)`);
  console.log(`  WS   ws://localhost:${PORT}/ws/reject      (deterministic upgrade rejection)`);
  console.log('\nFixture files for demo requests:');
  console.log(`  ${path.join(FIXTURES_DIR, 'sample.png')}`);
  console.log(`  ${path.join(FIXTURES_DIR, 'sample.txt')}`);
  console.log('\nPress Ctrl+C to stop.\n');
});
