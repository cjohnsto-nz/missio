# OC-090 gRPC Streaming

## Goal

Add schema-native gRPC client-streaming, server-streaming, and bidirectional-streaming execution with editor support, response streaming UI, local demo fixtures, and automated coverage.

## Current Gap

OC-030 implemented protobuf configuration, metadata defaults, unary execution, demo fixtures, and explicit diagnostics for streaming methods. OpenCollection gRPC request schema supports method types beyond unary, so Missio needs streaming support to close the remaining gRPC protocol gap.

| Surface | Gap |
| --- | --- |
| Method resolution | Proto loader resolves unary execution only. |
| Request payloads | Streaming requests need message lists, selected variants, or repeatable payload controls. |
| Execution | Client-streaming, server-streaming, and bidirectional-streaming calls are not executed. |
| Response UI | Streamed messages, metadata, status, cancellation, and errors need incremental display. |
| Runtime | Streaming lifecycle should coordinate with OC-080 once non-HTTP runtime support exists. |
| Demo coverage | Local gRPC server currently proves unary and unsupported-streaming diagnostics, not real streaming. |

## Implementation Plan

1. Extend gRPC method discovery:

| Method Type | Work |
| --- | --- |
| Server streaming | Detect response stream methods and invoke readable stream client calls. |
| Client streaming | Detect request stream methods and write selected message sequence before ending the stream. |
| Bidirectional streaming | Detect full duplex methods and support ordered send/receive event capture. |

2. Define schema-native message editing:

| Need | Work |
| --- | --- |
| Message variants | Preserve existing OpenCollection message variants and selected variant behavior. |
| Message sequences | Support ordered message lists for client and bidirectional streaming without corrupting unary requests. |
| Validation | Add diagnostics for invalid method type, invalid stream payload shape, and unresolved proto symbols. |

3. Implement streaming execution in `GrpcClient` and `RequestExecutionService`:

| Area | Work |
| --- | --- |
| Cancellation | Cancel active streaming calls and clean listeners/timers. |
| Timeouts | Respect request/collection settings and surface timeout diagnostics. |
| Metadata | Apply inherited metadata, auth-derived metadata, and request metadata consistently. |
| Errors | Preserve gRPC status/code/details and partial received message history. |

4. Add response and tooling support:

| Surface | Work |
| --- | --- |
| Response provider | Render streamed event log, final status, metadata, and elapsed time. |
| Request panel | Display streaming response state without blocking the extension UI. |
| Copilot tools | Return protocol, method type, sent message count, received message count, status, metadata, and errors. |

5. Extend local demo fixtures:

| Fixture | Expected Behavior |
| --- | --- |
| Server streaming | One request receives multiple ordered response messages. |
| Client streaming | Multiple request messages receive one summarized response. |
| Bidirectional streaming | Multiple request messages receive correlated streamed responses. |
| Error stream | Stream emits partial responses then a deterministic error for diagnostics tests. |

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Server streaming | Executes against local fixture server, displays ordered responses, and passes automated tests. |
| Client streaming | Sends ordered request messages, receives final response/status, and passes automated tests. |
| Bidirectional streaming | Sends and receives ordered event logs with cancellation and timeout coverage. |
| Schema safety | Streaming fixtures validate and round-trip without losing method type or message variants. |
| Regression safety | Unary gRPC behavior, HTTP, GraphQL, and WebSocket tests continue to pass. |
| User verification | Demo gRPC requests let a user run each streaming mode locally. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| Server-streaming fixture call. | Response contains multiple ordered messages and final OK status. |
| Client-streaming fixture call. | Server receives all request messages and returns aggregate response. |
| Bidirectional-streaming fixture call. | Response event log correlates sent and received messages. |
| Stream cancellation. | Call is cancelled, listeners are cleaned up, and no unhandled rejection occurs. |
| Stream error with partial data. | Partial messages and final gRPC error details are retained. |
| Streaming round-trip fixture. | YAML validates and no-op save preserves method type and message sequence. |

## Dependencies

| Dependency | Reason |
| --- | --- |
| OC-030 | Provides proto loading, unary client, metadata defaults, and fixture server foundation. |
| OC-080 | Needed if streaming runtime scripts/assertions/actions are included in the final streaming lifecycle. Streaming execution can start before OC-080, but final runtime parity should be verified after both branches are applied. |
