# Missio Demo API

The demo collection is local-only and does not require internet access for protocol fixtures.

Start the HTTP, GraphQL, WebSocket, runtime, auth, redirect, and binary upload fixture:

```powershell
node examples/demo-api/server.js
```

Start the gRPC fixture in a second terminal before sending requests under `examples/demo-api/gRPC/`:

```powershell
node examples/demo-api/grpc-server.js
```

The gRPC fixture binds `127.0.0.1:50051`, matching `LOCAL.grpcBaseUrl=localhost:50051` in `opencollection.yml`. If a gRPC demo request reports `UNAVAILABLE` or `ECONNREFUSED`, start or restart that fixture and retry with the LOCAL environment selected.
