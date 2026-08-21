# OC-100 Request Type UX

## Goal

Make request type management obvious and deliberate in Missio's UI. Users should be able to choose the request type when creating a request and see the current type while editing without needing to inspect YAML.

## Product Benchmark

Review current request-type workflows in industry-standard REST/API clients before implementation:

| Tool | UX Pattern To Inspect |
| --- | --- |
| Bruno | Request creation flow, request type/protocol labels, GraphQL/gRPC/WebSocket affordances, and whether type changes are supported after creation. |
| Postman | New request protocol picker, type labels in tabs/sidebar, request conversion behavior, and guardrails when switching protocols with incompatible fields. |
| Missio current state | Command palette/tree context creation, request editor header, YAML fallback, and how `type: http`, `type: graphql`, `type: websocket`, and `type: grpc` are represented. |

Record the benchmark findings in `AGENT_PROGRESS.md` before implementation. Prefer patterns that are familiar to users of Bruno/Postman, but keep Missio aligned with the OpenCollection schema rather than copying product-specific data models. Do not add a saved-request type switcher unless future benchmark evidence or product direction calls for one; current Bruno/Postman behavior emphasizes protocol selection at creation, and Postman documents protocol lock-in after saving.

## Current Gap

| Surface | Gap |
| --- | --- |
| New request | Users cannot choose `http`, `graphql`, `websocket`, or `grpc` from the UI when creating a request. |
| Editor header | The current request type is not prominent or editable in the visual editor. |
| Tree/context actions | Context menus do not expose protocol-specific creation commands at collection/folder scope. |
| Tests | Existing protocol tests prove execution/editor behavior, but not request-type creation UX. |

## Implementation Plan

1. Audit the current UI entry points:

| Entry Point | Work |
| --- | --- |
| Command palette | Find `newRequest` and related command handlers. |
| Tree context menu | Find folder/collection context commands and menu contribution points. |
| Request editor | Find the visual editor header and protocol-specific panels. |
| YAML fallback | Confirm manual `type:` edits remain supported and validated. |

2. Design the request type UX:

| Need | Expected Behavior |
| --- | --- |
| Creation | User selects HTTP, GraphQL, WebSocket, or gRPC before the starter YAML is written. |
| Current type | Editor shows a clear protocol/type control near the request title or primary request controls. |
| Current type | The visual editor shows the saved request type as read-only protocol identity; users create a new request when they need a different protocol. |
| Defaults | New templates use realistic schema-valid defaults and line up with demo requests. |

3. Add guardrails:

| Guardrail | Behavior |
| --- | --- |
| Non-destructive default | Do not change `info.type` or protocol roots from the visual editor. |
| YAML round-trip | Unknown but schema-valid fields must survive no-op edits. |
| Validation | Created starter requests validate against the selected type's schema before saving. |
| Manual YAML edits | Manual `type:` changes remain possible through YAML and must keep protocol-aware validation diagnostics. |

4. Add tests and docs:

| Area | Coverage |
| --- | --- |
| Command/service unit tests | Creation templates for all supported request types. |
| Editor/webview tests | Type identity rendering and save payloads. |
| Round-trip tests | Created and existing protocol requests preserve shared/schema-valid fields and do not leak stale protocol roots. |
| Regression tests | Existing HTTP, GraphQL, WebSocket, and gRPC fixtures still load, edit, validate, and execute. |
| User docs | Briefly document how to create request types and that existing request type changes are done by editing YAML or creating a new request. |

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Protocol creation | UI can create schema-valid HTTP, GraphQL, WebSocket, and gRPC requests. |
| Type visibility | Visual editor makes the current request type obvious without requiring YAML inspection. |
| No unsafe switching | Visual editor does not present a saved-request type switcher; request type remains schema-owned and visible. |
| Schema alignment | Saved YAML uses the OpenCollection `type:` field and protocol-specific roots correctly. |
| Industry alignment | Progress log records Bruno/Postman UX observations and the resulting Missio decisions. |
| Tests | Complete automated tests cover creation, conversion, validation, round-trip preservation, and regressions for existing protocol fixtures. |

## Out Of Scope

| Area | Reason |
| --- | --- |
| Implementing missing protocol execution | Covered by OC-010, OC-020, OC-030, OC-090, and OC-080. |
| Import/export/snippet protocol polish | Covered by OC-070. |
| Auth/transport behavior | Covered by OC-050. |
