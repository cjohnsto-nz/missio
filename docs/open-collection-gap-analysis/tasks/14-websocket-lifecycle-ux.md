# OC-140 First-Class WebSocket Lifecycle UX

## Goal

Make WebSocket testing in Missio feel like a first-class persistent connection workflow, not an HTTP-style one-shot request. Users should connect, observe connection state, send one or more messages, receive asynchronous messages, and disconnect through clear editor, VS Code status bar, CodeLens, command, and Copilot surfaces.

## Current Gap

Missio can execute WebSocket requests, but the primary UI still leans toward a combined "connect and send" action. That is useful as a smoke-test shortcut, but it is not the expected workflow for WebSocket API exploration. Tools such as Postman and Bruno treat connection lifecycle and message sending as separate operations: connect first, send messages while connected, inspect the message stream, then disconnect.

| Surface | Gap |
| --- | --- |
| Editor action model | Connect and send are coupled too tightly for interactive WebSocket debugging. |
| Connection state | Users need persistent visible states: disconnected, connecting, connected, disconnecting, error. |
| Message sending | Sending should be available independently after a connection is open and should support repeated sends. |
| Message history | Sent, received, close, error, and network events should remain inspectable during the session. |
| VS Code shell | Active WebSocket connections should be visible and manageable from the bottom status bar, similar to database or remote connections. |
| CodeLens and commands | WebSocket files should expose protocol-specific connect/disconnect/send actions instead of only generic request send behavior. |
| Copilot tools | Agent-facing tools should understand WebSocket session lifecycle, not only one-shot request execution. |

## Implementation Plan

1. Define the connection/session model:

| Area | Work |
| --- | --- |
| Session manager | Add or extend a service that owns WebSocket sessions by request URI or stable request identity. |
| State machine | Model disconnected, connecting, connected, disconnecting, closed, and error states with deterministic transitions. |
| Cleanup | Close sockets on editor disposal, extension deactivation, cancellation, and explicit disconnect. |
| Multiple connections | Support more than one open WebSocket request without cross-wiring messages or status. |
| Backward compatibility | Preserve any existing one-shot `send request` behavior as a secondary command or tool path where useful. |

2. Build editor UX around lifecycle:

| Area | Expected Behavior |
| --- | --- |
| Primary buttons | Show `Connect` when disconnected, `Disconnect` when connected or connecting, and a separate `Send` message action when connected. |
| Message editor | Let the user compose and resend messages without reconnecting. Preserve supported text, JSON, XML, and binary/base64 or hex paths already modeled by OpenCollection where available. |
| Message history | Show sent and received messages with direction, timestamp, payload preview, close/error events, and clear/copy affordances. |
| Status | Surface current connection state and last error without requiring the user to inspect logs. |
| Runtime integration | Apply supported before/after runtime behavior consistently with OC-080 without running after-response work until the relevant message/session event exists. |

3. Add VS Code shell integration:

| Area | Expected Behavior |
| --- | --- |
| Status bar item | Show active WebSocket connection count and active request state in the bottom bar. |
| Status bar command | Clicking the item opens a quick pick to view active sessions, focus a request, disconnect one, or disconnect all. |
| Command palette | Add explicit commands for connect, disconnect, send current message, show active WebSocket connections, and disconnect all WebSockets. |
| Lifecycle safety | Status bar state updates when sessions connect, fail, close, or are disposed. |

4. Update CodeLens, tree, and Copilot surfaces:

| Surface | Expected Behavior |
| --- | --- |
| CodeLens | WebSocket request files expose `Connect`, `Disconnect` when applicable, and `Send Message` lenses rather than only generic send semantics. |
| Tree/context menus | WebSocket nodes expose lifecycle-aware actions where VS Code UX patterns allow it. |
| Copilot list/get tools | Report WebSocket lifecycle capability and current connection state when available. |
| Copilot send/tooling | Add lifecycle-aware operations for connect, disconnect, send message, get status, and list recent messages. Keep one-shot execution explicit if retained. |
| Diagnostics | Return clear errors for sending while disconnected, connecting twice, unsupported message type, failed handshake, and closed sessions. |

5. Extend local fixtures and examples:

| Area | Work |
| --- | --- |
| Demo server | Ensure the local demo WebSocket server supports long-lived sessions, delayed server messages, close events, auth failure, and echo/message variants. |
| Demo requests | Add or update example WebSocket requests that demonstrate connect-only, repeated sends, server push, auth handshake, and disconnect behavior. |
| User verification | Include clear fixture names and predictable responses so users can verify the lifecycle manually inside VS Code. |

## Dependencies

| Task | Impact |
| --- | --- |
| OC-020 | Provides baseline WebSocket schema, client, execution, fixtures, and tests. |
| OC-070 | Copilot and CodeLens protocol identity patterns should be reused. |
| OC-080 | Runtime lifecycle semantics for WebSocket execution should remain consistent. |
| OC-100 | Request type identity and WebSocket editor shell should drive protocol-specific actions. |
| OC-130 | Coordinate if both tasks touch request editor startup, protocol-specific editor rendering, or shared toolbar layout. |

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Separate lifecycle | WebSocket users can connect without sending, send multiple messages while connected, and disconnect explicitly. |
| First-class state | Editor and status bar accurately reflect connection state and errors. |
| Message history | Sent, received, close, and error events are visible with stable ordering and useful metadata. |
| VS Code integration | Bottom status bar and command palette can inspect and manage active WebSocket sessions. |
| CodeLens integration | WebSocket files expose lifecycle-aware CodeLens actions with protocol-specific labels. |
| Copilot integration | Copilot tools can connect, disconnect, send a message over an existing session, report status, and diagnose invalid lifecycle operations. |
| Safe cleanup | Sessions close on disposal/deactivation/cancellation and do not leak listeners or timers. |
| Demo verification | Local demo API and example requests cover user-verifiable connect, send, receive, server push, auth failure, and disconnect flows. |
| Tests | Complete automated tests cover session state, editor UI, status bar commands, CodeLens, Copilot tools, fixture execution, cleanup, failure paths, and shared WebSocket regressions. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| WebSocket session manager unit tests | State transitions, multiple sessions, duplicate connect, send while disconnected, close, error, and cleanup are deterministic. |
| WebSocket client fixture tests | Local server proves connect-only, repeated sends, server push, close events, auth failure, and cancellation cleanup. |
| Request editor tests | WebSocket editor renders separate Connect/Disconnect and Send controls, disables invalid actions by state, and records message history. |
| Status bar command tests | Status item updates for active sessions and commands can focus, disconnect one, or disconnect all sessions. |
| CodeLens tests | WebSocket YAML receives protocol-specific connect/disconnect/send lenses without adding HTTP-specific actions. |
| Copilot tool tests | Lifecycle operations return useful status, message, and diagnostic payloads and preserve secret redaction. |
| Round-trip and validation tests | WebSocket request YAML remains schema-valid and unsupported-but-valid fields are preserved. |
| Regression suite | Re-run WebSocket, runtime lifecycle, request type UX, CodeLens, sendRequestTool, response provider, schema round-trip, and validation tests touched by shared code. |

## Out Of Scope

| Area | Reason |
| --- | --- |
| Full Socket.IO parity | Socket.IO has its own event/ack model and should be a separate task if needed. |
| Load testing | Persistent session UX is interactive/debugging-focused, not a performance runner. |
| WebSocket collection runner orchestration | Batch or monitor execution can follow after the interactive lifecycle is stable. |
| New request type switching | Saved-request type switching remains out of scope per OC-100. |
