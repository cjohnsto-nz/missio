'use strict';

const http = require('http');

const PORT = 3457;
const REQUIRED_AUTH = 'Basic ' + Buffer.from('demo-proxy:demo-proxy').toString('base64');

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.headers['proxy-authorization'] !== REQUIRED_AUTH) {
    res.writeHead(407, {
      'Proxy-Authenticate': 'Basic realm="Missio Demo Proxy"',
      'Content-Length': '0',
    });
    res.end();
    return;
  }

  json(res, 200, {
    ok: true,
    route: 'local-proxy',
    method: req.method,
    targetUrl: req.url,
    proxyAuthorized: true,
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Missio Proxy Demo Server -> http://127.0.0.1:${PORT}`);
  console.log('Temporarily set config.proxy.enabled=true in examples/demo-api/opencollection.yml to use it.');
});
