'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3443;
const CERT_PATH = path.join(__dirname, 'fixtures', 'mtls-client.crt');
const KEY_PATH = path.join(__dirname, 'fixtures', 'mtls-client.key');

const cert = fs.readFileSync(CERT_PATH);
const key = fs.readFileSync(KEY_PATH);

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = https.createServer(
  {
    key,
    cert,
    ca: cert,
    requestCert: true,
    rejectUnauthorized: true,
  },
  (req, res) => {
    if (req.method === 'GET' && req.url === '/secure') {
      const peer = req.socket.getPeerCertificate();
      return json(res, req.client.authorized ? 200 : 401, {
        ok: req.client.authorized,
        route: '/secure',
        clientCommonName: peer && peer.subject ? peer.subject.CN : null,
      });
    }

    return json(res, 404, { error: 'Not Found', path: req.url });
  },
);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Missio mTLS Demo Server -> https://127.0.0.1:${PORT}`);
  console.log('Set missio.rejectUnauthorized=false for this self-signed local fixture.');
});
