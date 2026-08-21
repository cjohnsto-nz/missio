# OC-030 gRPC Support

## Goal

Implement OpenCollection gRPC support, starting with protobuf configuration and unary requests, then expanding to streaming modes.

## Schema Surface

| Feature | Schema Shape |
| --- | --- |
| Collection config | `config.protobuf.protoFiles[]` and `config.protobuf.importPaths[]`. |
| Request root | `info`, `grpc`, `runtime`, `docs`. |
| Details | `url`, `method`, `methodType`, `protoFilePath`, `metadata`, `message`. |
| Method types | `unary`, `client-streaming`, `server-streaming`, `bidi-streaming`. |
| Metadata defaults | `RequestDefaults.metadata`. |
| Runtime | `variables`, `scripts`, `assertions`, `auth`. |

## Current Gap

Missio has no protobuf config model, no gRPC metadata/defaults handling, no proto loader, no gRPC client, and no gRPC editor mode.

## Implementation Plan

1. Depend on OC-000 type guards and executor facade.
2. Add TypeScript types for protobuf config, metadata, message variants, and gRPC request.
3. Add collection editor support for protobuf:

| Config | Controls |
| --- | --- |
| `protoFiles` | Path, disabled, add/remove. |
| `importPaths` | Path, disabled, add/remove. |

4. Choose gRPC dependencies, likely `@grpc/grpc-js` and `@grpc/proto-loader`.
5. Implement unary execution first:

| Step | Behavior |
| --- | --- |
| Load proto | Resolve request `protoFilePath` and collection import paths. |
| Select method | Parse `package.Service/Method` from `grpc.method`. |
| Build metadata | Merge collection/folder/request metadata, interpolate variables. |
| Build message | Parse JSON-like string message and interpolate variables. |
| Execute | Return response body, metadata, timing, and status details. |

6. Add streaming UI and executor follow-up:

| Streaming Type | Minimum UX |
| --- | --- |
| Client-streaming | Multi-message send list, finish stream. |
| Server-streaming | Inbound message log. |
| Bidi-streaming | Send list and inbound log. |

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Config | Collection protobuf config is editable and preserved. |
| Unary | Unary gRPC request executes against local fixture server. |
| Metadata | Defaults and request metadata apply in correct precedence. |
| Variables | Variables interpolate in URL, metadata, auth, and message. |
| Validation | gRPC request files validate against `GrpcRequest`. |
| Streaming | Unsupported streaming modes produce explicit diagnostics until implemented. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| Load proto with import path. | Service and method can be resolved. |
| Unary request with metadata. | Server receives metadata and message. |
| Missing proto file. | Clear error includes resolved path. |
| Invalid method name. | Clear method resolution error. |

## Coordination Notes

Keep the unary implementation small and well-tested. Streaming support is larger and should be split into separate subtasks after unary lands.

