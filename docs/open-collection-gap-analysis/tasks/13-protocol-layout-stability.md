# OC-130 Protocol-Native Request Editor First Paint

## Goal

Make the request editor render protocol-native UI from its first visible paint. Opening a WebSocket, GraphQL, or gRPC request must not briefly show the HTTP layout before switching to the correct protocol.

## Current Gap

HTTP was historically the only first-class request type, and parts of the request editor still appear to initialize as HTTP before the real request document is loaded into the webview. With WebSocket, GraphQL, and gRPC now supported, that creates a visible layout disturbance and makes non-HTTP protocols feel bolted on rather than native.

| Surface | Gap |
| --- | --- |
| Initial webview state | The editor appears to render an HTTP-shaped default layout before `requestLoaded` applies the actual protocol. |
| Non-HTTP request open | WebSocket, GraphQL, and gRPC requests can visibly switch layout after opening. |
| Loading state | There is no protocol-neutral or protocol-aware first-paint shell while the document is being parsed and sent. |
| Layout stability | Header, URL, body, tabs, auth/runtime, and response areas can shift as protocol-specific controls appear or disappear. |
| First-class protocol feel | The UI still implicitly treats HTTP as the default rather than one of several supported protocol modes. |

## Implementation Plan

1. Audit the request editor load path:

| Area | Work |
| --- | --- |
| Extension host | Review `RequestEditorProvider._getHtml`, `_sendDocumentToWebview`, and `resolveCustomTextEditor` message ordering. |
| Webview startup | Review `src/webview/requestPanel.ts` startup state, default model creation, `ready` handling, and `requestLoaded` rendering. |
| Protocol render branches | Inspect HTTP, GraphQL, WebSocket, and gRPC layout activation paths for stale/default HTTP assumptions. |
| CSS/layout | Review request editor CSS for controls that resize or appear late without reserved space. |

2. Design the first-paint behavior:

| Need | Expected Behavior |
| --- | --- |
| Neutral loading shell | Before request data is available, render a stable neutral shell or hidden editor body rather than an HTTP-specific request. |
| Protocol-aware prehydration | If practical, parse enough document metadata in the extension host to pass the initial protocol into the generated HTML before scripts load. |
| Direct protocol render | Once request data arrives, render the correct protocol layout directly without flashing through HTTP controls. |
| Stable dimensions | Reserve predictable header, URL, tab, and body/response dimensions so mode changes do not cause avoidable layout jumps. |
| No stale controls | HTTP-only controls, labels, body tabs, auth affordances, and method selectors must not appear while opening non-HTTP requests. |

3. Make all protocols first-class:

| Protocol | Expected First Visible Editor State |
| --- | --- |
| HTTP | HTTP method, URL, body/auth/runtime controls render normally. |
| GraphQL | GraphQL query/variables/body controls render without an HTTP method flash. |
| WebSocket | WebSocket connection/message controls render without HTTP body/auth controls flashing first. |
| gRPC | gRPC method/proto/message controls render without HTTP method/body controls flashing first. |

4. Preserve editor safety:

| Requirement | Behavior |
| --- | --- |
| YAML source of truth | Startup improvements must not mutate request YAML or change save semantics. |
| Invalid YAML | Invalid or incomplete YAML should show a stable loading/error/editor fallback without inventing an HTTP request. |
| Existing request lifecycle | Dirty indicators, undo/redo, Ctrl+S, and no-op save behavior remain unchanged. |
| Runtime/media panels | Runtime authoring, response rendering, and preview controls should not regress or compete with startup loading UI. |

## Dependencies

| Task | Impact |
| --- | --- |
| OC-000/OC-100 | Protocol type guards and request type identity should drive first-paint mode. |
| OC-010/OC-020/OC-030/OC-090 | Protocol editor layouts must be treated as native targets, not delayed replacements for HTTP. |
| OC-110 | Runtime authoring controls share the request editor shell and must remain stable during startup. |
| OC-120 | Preview media controls touch response/preview UI; coordinate on shared request panel CSS and layout assumptions. |

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| No HTTP flash | Opening GraphQL, WebSocket, or gRPC requests does not show HTTP-specific controls before the correct protocol layout appears. |
| Stable first paint | The editor uses a neutral or protocol-aware loading state with stable dimensions while request data hydrates. |
| Protocol parity | HTTP, GraphQL, WebSocket, and gRPC all have direct first visible layouts. |
| Invalid YAML handling | Invalid YAML does not fall back to an HTTP-shaped editor by default. |
| Regression safety | Existing request editing, save, round-trip, runtime authoring, and response preview behavior remains intact. |
| Tests | Complete automated tests cover startup state, protocol-specific initial render, no HTTP-default fallback for non-HTTP requests, invalid YAML fallback, and shared editor regressions. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| Initial HTML/source test. | The request panel startup state does not contain a hard-coded HTTP request model as the visible default. |
| Protocol load render tests. | GraphQL, WebSocket, and gRPC `requestLoaded` messages render protocol-specific shells without first applying HTTP method/body state. |
| Invalid YAML startup test. | Invalid document parse path leaves the editor in a neutral/loading/error-safe state, not an HTTP default. |
| CSS/source regression test. | Startup/loading shell and protocol sections reserve stable dimensions and avoid overlapping controls on narrow layouts. |
| Existing protocol editor tests. | Re-run request type UX, runtime authoring UX, GraphQL, WebSocket, gRPC, schema round-trip, and validation tests touched by shared request panel changes. |

## Out Of Scope

| Area | Reason |
| --- | --- |
| New protocol execution behavior | Covered by existing protocol/runtime tracks. |
| Saved-request type switching | Product decision from OC-100 keeps saved request type identity read-only in the visual editor. |
| Full visual regression harness | Add focused automated source/model tests now; create a follow-up only if deeper screenshot automation is needed. |
| Response preview media controls | Covered by OC-120. |
