# OC-000 Foundation And Protocol Dispatch

## Goal

Create the shared model, type guard, dispatch, and execution architecture needed for OpenCollection's non-HTTP request types without regressing current HTTP behavior.

## Current State

| Area | Evidence |
| --- | --- |
| Model | `Item` is `HttpRequest | Folder` in `src/models/types.ts`. |
| Loading | `readRequestFile` returns `HttpRequest`; directory scan treats every request file as HTTP-shaped. |
| Execution | `HttpClient.send()` accepts `HttpRequest` and uses `request.http`. |
| UI | Tree, command, request editor, and CodeLens assume `http.method`/`http.url`. |
| Validation | Request files are validated only against `HttpRequest`. |

## Scope

Add schema-aligned TypeScript types for:

| Type | Schema Definition |
| --- | --- |
| `GraphQLRequest` | `GraphQLRequest`, `GraphQLRequestDetails`, `GraphQLRequestRuntime`, `GraphQLRequestSettings`. |
| `GrpcRequest` | `GrpcRequest`, `GrpcRequestDetails`, `GrpcRequestRuntime`, metadata, messages. |
| `WebSocketRequest` | `WebSocketRequest`, details, runtime, message variants. |
| `ScriptFile` | Top-level shared script item with `type: script` and `script`. |
| `OpenCollectionItem` | Union of HTTP, GraphQL, gRPC, WebSocket, Folder, ScriptFile. |

## Implementation Plan

1. Replace the narrow `Item` union with a schema-complete union.
2. Add type guards such as `isHttpRequest`, `isGraphQLRequest`, `isGrpcRequest`, `isWebSocketRequest`, `isFolder`, and `isScriptFile`.
3. Update parser return types so request files return `OpenCollectionItem` or a protocol request union where appropriate.
4. Refactor collection scanning and tree construction to route by type guard instead of `http` assumptions.
5. Introduce an execution facade, for example `RequestExecutionService`, that dispatches to protocol executors.
6. Keep the existing HTTP executor behavior intact and covered by current tests.
7. Add explicit unsupported diagnostics for GraphQL, WebSocket, and gRPC until their task tracks land.

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Schema-complete model | `Item` includes all schema item variants. |
| Safe routing | Non-HTTP request files no longer get cast to HTTP or silently mutated as HTTP. |
| HTTP regression safety | Existing HTTP tests pass with no behavior change. |
| Better diagnostics | Sending an unsupported protocol request shows a clear protocol-specific message. |
| Parallel unblock | OC-010, OC-020, OC-030, and OC-070 can build against stable type guards and executor interfaces. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| Load mixed bundled collection with HTTP, GraphQL, gRPC, WebSocket, folder, script item. | All items classify correctly. |
| Scan unbundled directory containing protocol request YAML files. | Tree data includes protocol-aware nodes or clear placeholders. |
| Send existing HTTP request. | Existing response behavior unchanged. |
| Send non-HTTP request before protocol executor lands. | User receives clear unsupported protocol error. |

## Coordination Notes

This task should be claimed before major protocol implementation begins. If multiple agents need it, split by `models/types.ts`, parser/type guards, and executor facade, then coordinate through `AGENT_PROGRESS.md`.

OC-000 owns the shared model, type guards, parser routing, and execution facade. Protocol-specific tree, CodeLens, command, import, and export behavior remains with the protocol tracks or OC-070.

