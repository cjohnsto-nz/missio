# OC-080 Runtime Lifecycle For Non-HTTP Protocols

## Goal

Extend OC-040 runtime behavior across the supported non-HTTP executors so scripts, assertions, tests, actions, and runtime variable mutation work consistently for WebSocket and unary gRPC requests.

## Current Gap

OC-040 delivered the runtime engine and verified it through HTTP and GraphQL-over-HTTP execution. WebSocket and unary gRPC requests can execute through their protocol clients and can use variables/auth metadata, but they do not yet run the same before-request, after-response, assertion, test, and action lifecycle as HTTP-backed requests.

| Surface | Gap |
| --- | --- |
| WebSocket lifecycle | Runtime scripts/actions do not run around connect/send/receive/close exchange summaries. |
| gRPC unary lifecycle | Runtime scripts/actions do not run before metadata/message construction or after unary responses/errors. |
| Runtime context | Non-HTTP request/response objects need stable protocol-neutral shapes for scripts, assertions, tests, actions, and Copilot output. |
| Variables | Runtime variable mutation must apply before URL/header/metadata/message resolution and after response actions. |
| Response UI | Runtime test/assertion/action output needs to appear for WebSocket and gRPC responses the same way it does for HTTP. |
| Demo coverage | Local demo server requests should prove user-verifiable WebSocket and gRPC runtime behavior. |

## Implementation Plan

1. Define protocol lifecycle semantics:

| Protocol | Before Lifecycle | After Lifecycle |
| --- | --- | --- |
| WebSocket | Run before-request scripts/actions before handshake and before selected message payload resolution. | Run after-response scripts/actions/tests/assertions after the exchange summary is complete or after a terminal error is captured. |
| gRPC unary | Run before-request scripts/actions before URL, metadata, and message resolution. | Run after-response scripts/actions/tests/assertions after unary response, metadata, status, or error capture. |

2. Generalize the runtime execution adapter if needed so non-HTTP executors can share OC-040 sandbox, assertion, action, and diagnostics behavior without duplicating logic.
3. WebSocket support:

| Area | Work |
| --- | --- |
| Request mutation | Allow scripts/actions to mutate URL, headers, selected message body, and runtime variables before connect/send. |
| Response shape | Expose status-like connection metadata, close code/reason, sent messages, received messages, and errors to tests/assertions. |
| Cleanup | Preserve cancellation, timeout, disconnect, and socket cleanup guarantees when runtime scripts fail. |

4. gRPC unary support:

| Area | Work |
| --- | --- |
| Request mutation | Allow scripts/actions to mutate URL, metadata, message JSON, and runtime variables before unary execution. |
| Response shape | Expose response message, response metadata, status/code, elapsed time, and errors to tests/assertions. |
| Diagnostics | Preserve existing missing-proto, invalid-method, connection, and unsupported-streaming diagnostics. |

5. Extend Copilot send-request output, response provider output, and request execution result types to surface runtime results for non-HTTP protocols.
6. Add demo fixtures:

| Fixture | Expected Behavior |
| --- | --- |
| WebSocket runtime demo | Scripted header or message variable is visible to the local WebSocket fixture response. |
| gRPC runtime demo | Scripted metadata or message variable is visible in unary fixture response. |
| Failure demo | Assertion/test failure is visible in the response UI/tool result without crashing execution. |

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| WebSocket runtime | WebSocket requests execute before/after scripts, assertions, tests, and set-variable actions with fixture-backed tests. |
| gRPC runtime | Unary gRPC requests execute before/after scripts, assertions, tests, and set-variable actions with fixture-backed tests. |
| Runtime shape | Scripts receive documented protocol-specific request/response objects and stable shared helpers. |
| UI/tooling | Runtime results are shown in response views and Copilot send-request results for WebSocket and gRPC. |
| Safety | Sandbox, secret redaction, failure diagnostics, cancellation, and cleanup behavior remain covered by automated tests. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| WebSocket before-request script mutates header/message. | Local fixture receives mutation and response assertions pass. |
| WebSocket assertion failure. | Response includes failed assertion/test diagnostics and socket closes cleanly. |
| gRPC before-request script mutates metadata/message. | Unary fixture echoes mutation and response assertions pass. |
| gRPC after-response action sets runtime variable. | Follow-up variable lookup sees the new value. |
| Sandbox denial in non-HTTP runtime. | Filesystem/process/network globals are denied and execution returns clear diagnostics. |
| Cancellation during scripted WebSocket/gRPC execution. | Active socket/call resources are cleaned up and no unhandled rejection occurs. |

## Out Of Scope

| Area | Reason |
| --- | --- |
| gRPC streaming runtime lifecycle | Covered by OC-090 after streaming execution exists. |
| Persistent interactive WebSocket session scripting | This task covers request-style exchange execution, not a long-running session debugger. |
