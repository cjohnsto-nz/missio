# OC-100 Request Type UX

## Goal

Make request type management obvious and deliberate in Missio's UI. Users should be able to choose the request type when creating a request, see the current type while editing, and convert between compatible request types without corrupting schema data.

## Product Benchmark

Review current request-type workflows in industry-standard REST/API clients before implementation:

| Tool | UX Pattern To Inspect |
| --- | --- |
| Bruno | Request creation flow, request type/protocol labels, GraphQL/gRPC/WebSocket affordances, and whether type changes are supported after creation. |
| Postman | New request protocol picker, type labels in tabs/sidebar, request conversion behavior, and guardrails when switching protocols with incompatible fields. |
| Missio current state | Command palette/tree context creation, request editor header, YAML fallback, and how `type: http`, `type: graphql`, `type: websocket`, and `type: grpc` are represented. |

Record the benchmark findings in `AGENT_PROGRESS.md` before implementation. Prefer patterns that are familiar to users of Bruno/Postman, but keep Missio aligned with the OpenCollection schema rather than copying product-specific data models.

## Current Gap

| Surface | Gap |
| --- | --- |
| New request | Users cannot choose `http`, `graphql`, `websocket`, or `grpc` from the UI when creating a request. |
| Editor header | The current request type is not prominent or editable in the visual editor. |
| Type switching | There is no guided way to change request type, even when common fields such as name, URL, headers, auth, variables, runtime, and settings can be preserved. |
| Data safety | Switching between incompatible protocols needs explicit confirmation and a preview of fields that will be preserved, transformed, or dropped. |
| Tree/context actions | Context menus do not expose protocol-specific creation commands at collection/folder scope. |
| Tests | Existing protocol tests prove execution/editor behavior, but not request-type creation or conversion UX. |

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
| Switching | Type control offers compatible conversions and marks destructive conversions with confirmation. |
| Preservation preview | Conversion explains preserved, transformed, and removed fields before applying. |
| Defaults | New templates use realistic schema-valid defaults and line up with demo requests. |

3. Implement schema-aware conversion:

| Source/Target | Minimum Preservation |
| --- | --- |
| HTTP to GraphQL | Name, URL, method where relevant, headers, auth, params, variables, runtime, settings. |
| GraphQL to HTTP | Name, URL, method, headers, auth, params, variables, runtime, settings; GraphQL query/variables become a safe body representation only with user confirmation. |
| HTTP/GraphQL to WebSocket | Name, URL where compatible, headers, auth, variables, runtime, settings. |
| HTTP/GraphQL to gRPC | Name, auth, variables, runtime, settings; URL/metadata preserved only when semantically valid. |
| WebSocket/gRPC to other protocols | Preserve shared schema fields and require confirmation for protocol-specific message/method/proto data loss. |

4. Add guardrails:

| Guardrail | Behavior |
| --- | --- |
| Non-destructive default | Do not discard protocol-specific fields without explicit confirmation. |
| YAML round-trip | Unknown but schema-valid fields must survive no-op edits and safe conversions. |
| Validation | Converted requests validate against the selected type's schema before saving. |
| Undo | Conversion should be a normal editor/workspace edit that users can undo. |

5. Add tests and docs:

| Area | Coverage |
| --- | --- |
| Command/service unit tests | Creation templates and conversion helpers for all supported request types. |
| Editor/webview tests | Type selector rendering, conversion confirmation messaging, and save payloads. |
| Round-trip tests | Converted requests preserve shared fields and do not leak old protocol roots. |
| Regression tests | Existing HTTP, GraphQL, WebSocket, and gRPC fixtures still load, edit, validate, and execute. |
| User docs | Briefly document how to create and switch request types, including destructive conversion warnings. |

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Protocol creation | UI can create schema-valid HTTP, GraphQL, WebSocket, and gRPC requests. |
| Type visibility | Visual editor makes the current request type obvious without requiring YAML inspection. |
| Safe switching | Users can switch request type with clear preservation/loss preview and confirmation for destructive conversions. |
| Schema alignment | Saved YAML uses the OpenCollection `type:` field and protocol-specific roots correctly. |
| Industry alignment | Progress log records Bruno/Postman UX observations and the resulting Missio decisions. |
| Tests | Complete automated tests cover creation, conversion, validation, round-trip preservation, and regressions for existing protocol fixtures. |

## Out Of Scope

| Area | Reason |
| --- | --- |
| Implementing missing protocol execution | Covered by OC-010, OC-020, OC-030, OC-090, and OC-080. |
| Import/export/snippet protocol polish | Covered by OC-070. |
| Auth/transport behavior | Covered by OC-050. |
