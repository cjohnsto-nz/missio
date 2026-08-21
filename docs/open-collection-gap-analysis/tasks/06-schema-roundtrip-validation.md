# OC-060 Schema Round-Trip And Validation

## Goal

Make Missio safe for schema-valid OpenCollection files even when a feature is not fully executable yet.

## Current Gap

Editors clone documents before editing known fields, which helps preserve unknown fields. However, they also overwrite entire managed branches. That can flatten or drop valid schema structures:

| Area | Risk |
| --- | --- |
| Request editor | Can add `http` fields to non-HTTP files before protocol routing is fixed. |
| Body editor | Body variants are not safely editable; multipart file parts are not represented. |
| Variable editors | Typed values and variants flatten to strings on edit. |
| Collection/folder editors | Managed `request` fields can drop scripts/settings/metadata. |
| Validation | Request files are validated only as `HttpRequest`; workspace files are skipped by collection validation. |
| VS Code YAML validation | Package contributes schemas only for collection/workspace filenames, not request/folder/protocol files. |

## Implementation Plan

1. Add golden round-trip tests:

| Fixture | Expected |
| --- | --- |
| Typed variable values | No-op edit preserves object form. |
| Variable variants | No-op edit preserves selected variant array. |
| HTTP body variants | No-op edit preserves all variants. |
| Multipart file part | No-op edit preserves `type: file` and value array. |
| GraphQL/gRPC/WebSocket file | Opening/saving does not inject `http`. |
| Folder defaults with metadata/scripts/settings | No-op edit preserves them. |

2. Update editor builders to merge field-level edits instead of replacing sibling schema fields.
3. Add protocol-aware editor selection once OC-000 lands.
4. Update validation service:

| File Kind | Validator |
| --- | --- |
| Collection | Full `OpenCollection`. |
| Folder | `Folder`. |
| Workspace | Workspace schema. |
| Request | Detect protocol and validate matching request schema. |
| Script file | `ScriptFile`. |

5. Consider bundled request/folder validation for `collection.items`.
6. Wire local schemas into `package.json` or document how dynamic request schema validation works.

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Round-trip | Schema-valid data survives no-op editor save. |
| Validation | Correct subschema is selected for every request protocol and script item. |
| Diagnostics | Invalid files report actionable schema errors with protocol label. |
| Safety | Unsupported features remain editable as YAML without being damaged by visual editors. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| No-op request editor save of GraphQL file. | No new `http` key appears. |
| Collection editor save with `request.scripts`. | `scripts` remains unchanged. |
| Folder editor save with `request.metadata`. | `metadata` remains unchanged. |
| Validate WebSocket file. | Uses `WebSocketRequest` schema, not `HttpRequest`. |

## Coordination Notes

This track can start immediately with tests. Many failing tests will document gaps before implementation tracks fix them.
