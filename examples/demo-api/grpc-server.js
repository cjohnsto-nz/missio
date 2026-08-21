'use strict';

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const HOST = '127.0.0.1';
const PORT = 50051;
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
  call.write({ id: request.userId || 1, name: 'Ada' });
  call.write({ id: (request.userId || 1) + 1, name: 'Grace' });
  call.end();
}

const server = new grpc.Server();
server.addService(proto.DemoService.service, {
  echoUnary,
  streamUsers,
});

server.bindAsync(ADDRESS, grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  server.start();
  console.log(`Missio gRPC Demo Server -> ${ADDRESS}`);
  console.log(`Proto: ${PROTO_PATH}`);
  console.log('Methods:');
  console.log('  missio.demo.DemoService/EchoUnary');
  console.log('  missio.demo.DemoService/StreamUsers');
  console.log(`Listening on ${HOST}:${port}. Press Ctrl+C to stop.`);
});
