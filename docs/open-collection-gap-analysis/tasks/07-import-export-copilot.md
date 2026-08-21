# OC-070 Request Creation, Import/Export, And Copilot Surface Polish

## Goal

Finish the user-facing and agent-facing protocol surface after OC-000 through OC-040 and OC-060. This task should polish the remaining creation, import/export, snippet, and Copilot paths without reimplementing protocol dispatch that already landed.

## Current Gap

| Surface | Gap |
| --- | --- |
| New request | Creation UX and templates are still HTTP-first and need schema-native GraphQL, WebSocket, and gRPC starters. |
| Importers | Importers are HTTP-oriented and need explicit preservation or unsupported-conversion diagnostics for scripts/events and non-HTTP metadata. |
| Exporters | Snippet export is HTTP-oriented and should either support protocol-specific snippets or clearly reject unsupported protocol conversions. |
| Copilot tools | Protocol-aware list/send support exists, but get/dry-run/extraction/tool metadata should be audited for all protocols and runtime result shapes. |
| Tree/CodeLens/commands | Protocol support exists from earlier tracks; this task should add regression coverage and fix remaining edge cases rather than rebuild the foundation. |
| Documentation | User-visible docs should describe what can be created, imported, exported, sent, and inspected for each protocol. |

## Implementation Plan

1. Re-audit existing protocol support before editing:

| Surface | Expected Baseline From Earlier Tracks |
| --- | --- |
| Tree | Mixed HTTP, GraphQL, WebSocket, gRPC, folder, and script nodes render without HTTP-only assumptions. |
| CodeLens | Executable protocol files receive send CodeLens labels. |
| Send command | Dispatches through `RequestExecutionService` or reports protocol-specific unsupported diagnostics. |
| Copilot list/send | Includes protocol metadata and protocol-specific execution output. |

2. Update request creation:

| Command | Work |
| --- | --- |
| `newRequest` | Offer protocol selection and create schema-valid starter YAML for HTTP, GraphQL, WebSocket, and gRPC. |
| `openRequest` | Confirm every created starter opens in the correct editor or YAML fallback. |
| Demo parity | Ensure new starter templates match patterns used in `examples/demo-api`. |

3. Update import/export behavior:

| Area | Work |
| --- | --- |
| Postman importer | Preserve scripts/events where mappable after OC-040; record unsupported mappings explicitly. |
| OpenAPI importer | Keep HTTP semantics by default; preserve source metadata and avoid inventing GraphQL/WebSocket/gRPC requests unless source metadata truly supports it. |
| Exporters | Add protocol-aware unsupported messages where export is not implemented and prevent silent data loss. |
| Snippet exporter | Keep HTTP snippets working; add clear non-HTTP diagnostics or implement protocol-specific snippets if the scope remains small. |

4. Update Copilot tools:

| Tool | Work |
| --- | --- |
| `list_requests` | Regression-test protocol and summary output for all supported protocols. |
| `get_request` | Return full schema-native requests without dropping non-HTTP fields. |
| `send_request` | Confirm response payloads include protocol, runtime results, metadata, and useful diagnostics for each supported executor. |
| Dry run/extraction | Redact secrets and preserve schema-native request shapes across protocols. |
| Tool metadata | Ensure package/tool descriptions match current protocol coverage. |

5. Add documentation and smoke instructions for user-verifiable protocol creation/import/export/Copilot flows.

## Dependency Notes

| Task | Impact |
| --- | --- |
| OC-050 | If OC-050 changes auth representation or transport settings, OC-070 should update starter templates, import/export preservation, and Copilot redaction tests to match. |
| OC-080 | If OC-080 changes runtime result shapes for WebSocket/gRPC, OC-070 should update Copilot `send_request` assertions and docs accordingly. |
| OC-090 | If OC-090 lands first, OC-070 should include gRPC streaming method summaries in list/get/dry-run tests. |

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Baseline audit | Existing tree, CodeLens, command, and send routing support is covered by regression tests for every supported protocol. |
| New request | User can create schema-valid HTTP, GraphQL, WebSocket, and gRPC starter YAML. |
| Copilot | Tools include protocol in outputs, preserve schema-native request data, and do not corrupt non-HTTP requests. |
| Imports/exports | Unsupported conversions report limitations instead of silently losing data. |
| Snippets | HTTP snippets still work, and non-HTTP snippet attempts are either implemented or rejected with clear protocol diagnostics. |
| Docs | User-facing docs explain supported and unsupported protocol surface behavior. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| Tree with mixed collection. | Nodes have protocol icons/descriptions. |
| CodeLens on GraphQL/WebSocket/gRPC files. | Shows protocol-specific send labels and does not show HTTP-only labels. |
| New GraphQL/WebSocket/gRPC request. | Creates schema-valid YAML that validates and opens cleanly. |
| Copilot get/dry-run for each protocol. | Returns schema-native request data with redacted secrets and protocol metadata. |
| Copilot send for each implemented executor. | Returns protocol-specific response and runtime result fields where applicable. |
| Non-HTTP snippet export. | Returns clear unsupported diagnostic or valid protocol-specific snippet. |
| Importer script/event preservation. | Mappable Postman scripts/events become OpenCollection runtime fields; unmappable data is reported. |
