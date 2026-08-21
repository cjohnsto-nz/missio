'use strict';

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const HOST = '127.0.0.1';
const PORT = Number(process.env.MISSIO_GRPC_PORT ?? '50051');
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`Invalid MISSIO_GRPC_PORT value: ${process.env.MISSIO_GRPC_PORT}`);
  process.exit(1);
}
const ADDRESS = `${HOST}:${PORT}`;
const PROTO_DIR = path.join(__dirname, 'proto');
const PROTO_PATH = path.join(PROTO_DIR, 'services', 'missio_demo.proto');

function metadataValue(call, name) {
  const values = call.metadata.get(name);
  if (!values || values.length === 0) return '';
  return String(values[0]);
}

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_DIR],
});

const proto = grpc.loadPackageDefinition(packageDefinition).missio.demo;

function echoUnary(call, callback) {
  const responseMetadata = new grpc.Metadata();
  responseMetadata.set('x-demo-grpc', 'ok');
  call.sendMetadata(responseMetadata);

  const request = call.request || {};
  callback(null, {
    message: `Hello ${request.name || 'friend'}`,
    name: request.name || '',
    userId: request.userId || 0,
    requestId: request.trace?.requestId || '',
    authorization: metadataValue(call, 'authorization'),
    defaultMetadata: metadataValue(call, 'x-demo-default'),
    folderMetadata: metadataValue(call, 'x-demo-folder'),
    requestMetadata: metadataValue(call, 'x-demo-request'),
  });
}

function streamUsers(call) {
  const request = call.request || {};
  const requestId = request.trace?.requestId || '';
  call.write({ id: request.userId || 1, name: request.name || 'Ada', requestId });
  call.write({ id: (request.userId || 1) + 1, name: 'Grace', requestId });
  call.end();
}

function uploadUsers(call, callback) {
  const requests = [];
  call.on('data', (request) => {
    requests.push(request || {});
  });
  call.on('end', () => {
    callback(null, {
      count: requests.length,
      names: requests.map(request => request.name || `user-${request.userId || 0}`).join(','),
      requestIds: requests.map(request => request.trace?.requestId || '').filter(Boolean).join(','),
      authorization: metadataValue(call, 'authorization'),
      defaultMetadata: metadataValue(call, 'x-demo-default'),
    });
  });
}

function chatUsers(call) {
  call.on('data', (request) => {
    call.write({
      id: request.userId || 0,
      name: `ack:${request.name || 'user'}`,
      requestId: request.trace?.requestId || '',
    });
  });
  call.on('end', () => call.end());
}

function streamUsersWithError(call) {
  const request = call.request || {};
  call.write({ id: request.userId || 1, name: request.name || 'Partial Ada', requestId: request.trace?.requestId || '' });
  const error = new Error('Demo stream failure after partial data');
  error.code = grpc.status.INTERNAL;
  error.details = 'Demo stream failure after partial data';
  call.emit('error', error);
}

const server = new grpc.Server();
server.addService(proto.DemoService.service, {
  echoUnary,
  streamUsers,
  uploadUsers,
  chatUsers,
  streamUsersWithError,
});

let shutdownStarted = false;

function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`Received ${signal}; shutting down the gRPC demo server.`);

  const forceTimer = setTimeout(() => {
    console.error('Graceful gRPC shutdown timed out; forcing shutdown.');
    server.forceShutdown();
    process.exitCode = 1;
  }, 2_000);
  forceTimer.unref();

  server.tryShutdown((error) => {
    clearTimeout(forceTimer);
    if (error) {
      console.error(error);
      server.forceShutdown();
      process.exitCode = 1;
      return;
    }
    console.log('Missio gRPC Demo Server stopped.');
  });
}

server.bindAsync(ADDRESS, grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  server.start();
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  const boundAddress = `${HOST}:${port}`;
  console.log(`Missio gRPC Demo Server -> ${boundAddress}`);
  console.log('Start command: node examples/demo-api/grpc-server.js');
  console.log(port === 50051
    ? 'OpenCollection LOCAL.grpcBaseUrl: localhost:50051'
    : `OpenCollection LOCAL.grpcBaseUrl override for this process: ${boundAddress}`);
  console.log(`Proto: ${PROTO_PATH}`);
  console.log('Methods:');
  console.log('  missio.demo.DemoService/EchoUnary');
  console.log('  missio.demo.DemoService/StreamUsers');
  console.log('  missio.demo.DemoService/UploadUsers');
  console.log('  missio.demo.DemoService/ChatUsers');
  console.log('  missio.demo.DemoService/StreamUsersWithError');
  console.log(`Listening on ${boundAddress}. Press Ctrl+C to stop.`);
});
