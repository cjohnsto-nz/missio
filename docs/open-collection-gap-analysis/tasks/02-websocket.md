# OC-020 WebSocket Support

## Goal

Implement OpenCollection `WebSocketRequest` support with connection lifecycle, outbound message variants, inbound message logging, auth, variables, and tests.

## Schema Surface

| Feature | Schema Shape |
| --- | --- |
| Request root | `info`, `websocket`, `runtime`, `docs`. |
| Details | `url`, `headers`, `message`. |
| Message | `WebSocketMessage` with `type` in `text`, `json`, `xml`, `binary` and `data`. |
| Variants | `WebSocketMessageVariant[]` with `title`, `selected`, `message`. |
| Runtime | `variables`, `scripts`, `auth`. |

## Current Gap

There is no WebSocket dependency, editor, connection manager, response/message UI, validation path, or tree handling. Current request commands only send HTTP.

## Implementation Plan

1. Depend on OC-000 type guards and execution facade.
2. Add a WebSocket runtime service that owns active connections by file path or generated request ID.
3. Add a WebSocket editor mode:

| Panel | Controls |
| --- | --- |
| URL bar | URL, connect/disconnect, send. |
| Headers/Auth | Handshake headers and auth. |
| Message | Message type, payload editor, variants. |
| Messages | Chronological inbound/outbound log with timestamps and close/error events. |

4. Add cancellation/disconnect behavior and cleanup on editor close.
5. Resolve variables and secrets in URL, headers, auth, and outbound messages.
6. Add tests with a local WebSocket echo server.

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Connection | Agent can connect and disconnect from `ws://` and `wss://` endpoints. |
| Send | Selected message variant sends with correct type and interpolated data. |
| Receive | Inbound messages are visible with timestamp and payload. |
| Auth | Header-compatible auth applies to handshake. |
| Safety | Closing editor or cancelling disconnects active sockets. |
| Validation | WebSocket request files validate against `WebSocketRequest`. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| Echo text message. | Inbound log shows echoed text. |
| Echo JSON message with variables. | JSON payload has interpolated values. |
| Connect with bearer auth. | Server receives `Authorization` header. |
| Invalid URL. | UI shows clear connection error. |

## Dependency Choice

Prefer the established `ws` package unless VS Code/Electron APIs provide a better fit. Add types and tests with a local in-process server.

