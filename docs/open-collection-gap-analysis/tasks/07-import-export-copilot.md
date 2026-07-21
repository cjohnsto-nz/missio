# OC-070 Imports, Exports, Tree, CodeLens, And Copilot Tools

## Goal

Make Missio's user-facing and agent-facing surfaces protocol-aware after the model and executor foundation lands.

## Current Gap

| Surface | Gap |
| --- | --- |
| Tree provider | Request nodes assume HTTP method and URL. |
| CodeLens | Only appears for files containing `http:` and `method:`. |
| Commands | `missio.sendRequest` rejects non-HTTP files. |
| New request | Only creates HTTP request templates. |
| Importers | Importers produce HTTP-only OpenCollection files. |
| Exporters | Snippet export is HTTP-only. |
| Copilot tools | `send_request`, dry-run, extraction, and list/get flows are HTTP-shaped. |

## Implementation Plan

1. Depend on OC-000 type guards and execution facade.
2. Update tree rendering:

| Protocol | Label/Description |
| --- | --- |
| HTTP | Method and URL. |
| GraphQL | Method or `GRAPHQL`, URL, operation hint if available. |
| WebSocket | `WS`/`WSS`, URL. |
| gRPC | Method type and RPC method. |
| Script | Script item label. |

3. Update commands:

| Command | Work |
| --- | --- |
| `sendRequest` | Dispatch through protocol execution facade. |
| `newRequest` | Offer protocol pick and create schema-native template. |
| `openRequest` | Route to correct visual editor or YAML fallback. |

4. Update CodeLens to detect protocol keys and show protocol-specific send labels.
5. Update Copilot tools:

| Tool | Work |
| --- | --- |
| `list_requests` | Include protocol and protocol-specific summary. |
| `get_request` | Return full schema-native request. |
| `send_request` | Dispatch by protocol; include protocol-specific response. |
| Dry run | Redact secrets across protocols. |

6. Update import/export behavior:

| Area | Work |
| --- | --- |
| Postman importer | OC-070 owns preserving mappable scripts/events after the OC-040 runtime contract lands; record unsupported mappings and cover collection, folder, and request event scopes with importer tests. |
| OpenAPI importer | Detect GraphQL only if source metadata supports it; otherwise keep HTTP. |
| Snippet exporter | Keep HTTP exporters, add clear unsupported messages for non-HTTP until implemented. |

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Tree | Mixed-protocol collections render without HTTP assumptions. |
| CodeLens | GraphQL/WebSocket/gRPC files receive useful CodeLens where executable. |
| Commands | Send command dispatches by protocol or reports clear unsupported state. |
| New request | User can create protocol-specific starter YAML. |
| Copilot | Tools include protocol in outputs and do not corrupt non-HTTP requests. |
| Imports/exports | Unsupported conversions report limitations instead of silently losing data. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| Tree with mixed collection. | Nodes have protocol icons/descriptions. |
| CodeLens on GraphQL file. | Shows send label and summary. |
| Copilot dry-run for GraphQL. | Shows method, URL, headers, body without sending. |
| New WebSocket request. | Creates schema-valid `websocket` YAML. |

