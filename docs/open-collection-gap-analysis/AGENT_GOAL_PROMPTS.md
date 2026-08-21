# Agent Goal Prompts

Use these prompts to launch parallel agents for the OpenCollection implementation tracks. Run OC-000 and OC-060 first. Start the remaining tracks as their dependencies become stable.

If an agent host does not inject the project-local skills, tell the agent to read the matching `SKILL.md` file under `.agents/skills/` before starting.

## Foundation

```text
/goal Complete OC-000 foundation and protocol dispatch using $missio-agent-coordination and $missio-protocol-implementer without stopping until the OpenCollection item model, protocol type guards, load/save routing, execution facade, unsupported-protocol diagnostics, AGENT_PROGRESS updates, and complete automated regression tests are implemented and passing.
```

## Schema Safety

```text
/goal Complete OC-060 schema round-trip and validation using $missio-agent-coordination and $missio-editor-schema-implementer without stopping until protocol-aware validation, workspace validation, no-op editor round-trip coverage for schema-valid fixtures, AGENT_PROGRESS updates, and complete automated tests are implemented and passing.
```

## GraphQL

```text
/goal Complete OC-010 GraphQL support using $missio-agent-coordination, $missio-protocol-implementer, and $missio-demo-server-fixtures without stopping until schema-native GraphQL editing, execution, validation, tree/CodeLens/tool routing, body variants, local demo server GraphQL routes, user-verifiable demo GraphQL requests, AGENT_PROGRESS updates, and complete automated unit, integration, and round-trip tests are implemented and passing.
```

## WebSocket

```text
/goal Complete OC-020 WebSocket support using $missio-agent-coordination, $missio-protocol-implementer, and $missio-demo-server-fixtures without stopping until schema-native WebSocket editing, connect/send/receive/disconnect lifecycle, message variants, cleanup behavior, local demo server WebSocket fixtures, user-verifiable demo WebSocket requests, AGENT_PROGRESS updates, and complete automated tests with a local WebSocket fixture server are implemented and passing.
```

## gRPC

```text
/goal Complete OC-030 gRPC unary and protobuf support using $missio-agent-coordination, $missio-protocol-implementer, and $missio-demo-server-fixtures without stopping until protobuf config editing, gRPC request validation, metadata defaults, unary execution against a local fixture server, local demo gRPC server/proto fixtures, user-verifiable demo gRPC requests, explicit streaming diagnostics, AGENT_PROGRESS updates, and complete automated tests are implemented and passing.
```

## Runtime

```text
/goal Complete OC-040 scripts, tests, assertions, and actions using $missio-agent-coordination, $missio-runtime-implementer, and $missio-demo-server-fixtures without stopping until lifecycle execution, sandbox policy, assertions, set-variable actions, test result UI/tool output, local demo runtime fixture routes, user-verifiable demo runtime requests, AGENT_PROGRESS updates, and complete automated runtime, security, and failure-path tests are implemented and passing.
```

## Auth And Transport

```text
/goal Complete OC-050 auth, proxy, mTLS, redirects, and transport completion using $missio-agent-coordination and $missio-runtime-implementer without stopping until missing schema auth behavior, OAuth2 completeness, API-key query placement, redirect handling, proxy, mTLS, unsupported-auth diagnostics, AGENT_PROGRESS updates, and complete automated fixture-backed tests are implemented and passing.
```

## User And Agent Surfaces

```text
/goal Complete OC-070 request creation, import/export, snippet, and Copilot protocol surface polish using $missio-agent-coordination and $missio-editor-schema-implementer without stopping until protocol-specific new request templates, protocol-preserving get/dry-run/list/send tooling, explicit unsupported import/export/snippet diagnostics, baseline tree/CodeLens/command regressions, AGENT_PROGRESS updates, and complete automated tests are implemented and passing.
```

## Request Type UX

```text
/goal Complete OC-100 request type UX using $missio-agent-coordination and $missio-editor-schema-implementer without stopping until Bruno/Postman UX benchmarking is recorded, UI request creation supports HTTP/GraphQL/WebSocket/gRPC type selection, the visual editor clearly shows read-only request type identity without offering a saved-request switcher, AGENT_PROGRESS updates are complete, and complete automated creation, validation, round-trip, and regression tests are passing.
```

## Protocol Runtime Lifecycle

```text
/goal Complete OC-080 runtime lifecycle support for WebSocket and unary gRPC using $missio-agent-coordination, $missio-runtime-implementer, and $missio-demo-server-fixtures without stopping until before/after scripts, assertions, tests, actions, runtime variable mutation, response UI/tool output, local demo WebSocket and gRPC runtime fixtures, AGENT_PROGRESS updates, and complete automated unit, integration, security, failure-path, and cleanup tests are implemented and passing.
```

## Runtime Authoring UX

```text
/goal Complete OC-110 runtime authoring UX using $missio-agent-coordination and $missio-editor-schema-implementer without stopping until the visual request editor can create, edit, disable, reorder, and remove runtime scripts, tests, assertions, and set-variable actions; preserves schema-valid YAML for HTTP, GraphQL, WebSocket, and gRPC requests; includes user-verifiable demo guidance; updates AGENT_PROGRESS; and complete automated editor, model, validation, round-trip, and regression tests are implemented and passing.
```

## Preview Media Controls

```text
/goal Complete OC-120 preview media zoom and rotate controls using $missio-agent-coordination and $missio-editor-schema-implementer without stopping until image and PDF response previews support a compact Ctrl+F-style media toolbar, zoom in/out, reset, fit behavior, rotate left/right, Ctrl+scroll zoom within the preview pane, safe PDF re-render/cancellation, AGENT_PROGRESS updates, packaged PDF.js asset verification, and complete automated transform, UI, wheel, reset, image/PDF, and build/package regression tests are implemented and passing.
```

## gRPC Streaming

```text
/goal Complete OC-090 gRPC streaming support using $missio-agent-coordination, $missio-protocol-implementer, and $missio-demo-server-fixtures without stopping until client-streaming, server-streaming, and bidirectional-streaming execution, schema-native message sequences, validation, cancellation, response streaming UI/tool output, local demo streaming fixtures, AGENT_PROGRESS updates, and complete automated unit, integration, round-trip, failure-path, and cleanup tests are implemented and passing.
```

## Final Integration

```text
/goal Complete final OpenCollection compatibility integration across all Missio tracks using $missio-agent-coordination without stopping until all OC-000 through OC-120 task rows are Done, all GitButler branches or PRs are linked, the full test suite and required fixture integration tests pass, documentation is consistent, and AGENT_PROGRESS.md contains final verification evidence.
```
