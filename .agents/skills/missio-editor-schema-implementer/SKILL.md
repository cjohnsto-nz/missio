---
name: missio-editor-schema-implementer
description: Implement Missio editor, validation, import/export, tree, CodeLens, and Copilot tool changes needed for OpenCollection schema completeness and round-trip safety. Use when preserving schema fields, adding validation subschemas, changing visual editors, or making protocol-aware UI/tooling.
---

# Missio Editor Schema Implementer

## First Steps

1. Run `but status -fv`; use GitButler for any version-control writes.
2. Read `docs/open-collection-gap-analysis/AGENT_PROGRESS.md`.
3. Claim OC-060 for schema round-trip/validation or OC-070 for UI/tooling surfaces and record the GitButler branch/stack.
4. Read the matching task page before editing:
   - `tasks/06-schema-roundtrip-validation.md`
   - `tasks/07-import-export-copilot.md`
5. Record a coverage plan in `AGENT_PROGRESS.md` before editing implementation code.

## Editing Rules

- Protect schema-valid data even when Missio cannot execute it yet.
- Prefer field-level merges over replacing whole schema branches.
- Add no-op round-trip tests before changing visual editor serializers.
- Preserve Missio-specific extensions through `schema/missio-extensions.json`.
- Keep visual editors from creating `http` keys in non-HTTP request files.
- Commit only schema/editor/tooling changes with `but commit ... --changes <ids>`; do not use raw Git write commands.

## Validation Rules

- Select validation subschema by protocol/type, not by "any YAML request file is HTTP".
- Include workspace validation in collection validation reports.
- Make validation messages name the protocol schema used.

## UI And Tooling Rules

- Tree nodes, CodeLens, commands, imports, exports, and Copilot tools should expose protocol identity.
- Unsupported protocol-specific exports should produce explicit limitations rather than dropping data.
- Run both UI serializer tests and service/tool tests for any shared schema change.

## Required Verification

Run complete automated coverage for schema/editor/tooling changes:

- Golden no-op round-trip tests for HTTP, GraphQL, WebSocket, gRPC, folder, environment, and collection fixtures relevant to the changed code.
- Validation tests that prove the selected OpenCollection subschema is protocol-aware and reports useful diagnostics.
- Serializer/editor tests that prove valid unknown fields are preserved and non-HTTP files do not gain `http` keys.
- Import/export, tree, CodeLens, command, and Copilot tool tests for any changed user-facing or agent-facing surface.
- Existing HTTP/import/export/editor regression tests touched by shared code.

Update `AGENT_PROGRESS.md` with exact commands and results. Any manual-only verification needs a reason and follow-up work.
