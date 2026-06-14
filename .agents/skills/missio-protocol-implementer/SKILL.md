---
name: missio-protocol-implementer
description: Implement OpenCollection protocol support in Missio for GraphQL, WebSocket, and gRPC. Use when editing protocol models, protocol request editors, executor dispatch, GraphQL execution, WebSocket sessions, gRPC/protobuf support, protocol validation, or protocol-specific tests.
---

# Missio Protocol Implementer

## First Steps

1. Run `but status -fv`; use GitButler for any version-control writes.
2. Read `docs/open-collection-gap-analysis/AGENT_PROGRESS.md`.
3. Claim the matching protocol task and record the GitButler branch/stack.
4. Read the specific task page:
   - GraphQL: `tasks/01-graphql.md`
   - WebSocket: `tasks/02-websocket.md`
   - gRPC: `tasks/03-grpc.md`
5. Check whether OC-000 foundation interfaces exist. If not, implement only isolated preparatory work or coordinate with the OC-000 owner.
6. Record a coverage plan in `AGENT_PROGRESS.md` before editing implementation code.

## Implementation Rules

- Keep `schema/opencollectionschema-source.json` upstream-only. Put Missio-only schema additions in `schema/missio-extensions.json`.
- Prefer schema-native YAML shapes over Missio-only convenience fields.
- Add protocol type guards before broad UI/runtime changes.
- Preserve current HTTP behavior and tests.
- Add local fixture servers for protocol execution tests.
- Commit only the protocol track's files with `but commit ... --changes <ids>`; leave unrelated agent changes unassigned or on their own branches.

## Protocol Notes

GraphQL should reuse HTTP-compatible headers, params, auth, settings, variable interpolation, response rendering, and examples where practical.

WebSocket needs connection ownership and cleanup. Ensure editor close, cancel, and extension disposal disconnect active sockets.

gRPC should land unary support before streaming. Treat client-streaming, server-streaming, and bidi-streaming as explicit follow-ups unless the task scope says otherwise.

## Required Verification

Run complete automated coverage for the protocol slice:

- Type guards, parsing, validation, and round-trip preservation for schema-native protocol fixtures.
- Editor, tree, CodeLens, command, and Copilot/tool tests for changed user-facing or agent-facing surfaces.
- Executor tests against local fixture servers; do not depend on external services.
- Failure-path tests for invalid schema, unsupported variants, connection errors, cancellation, cleanup, and diagnostics.
- Existing HTTP tests that touch shared execution, auth, variables, response rendering, or import/export code.

Update `AGENT_PROGRESS.md` with the exact commands, results, and any non-automated gap with a follow-up.
