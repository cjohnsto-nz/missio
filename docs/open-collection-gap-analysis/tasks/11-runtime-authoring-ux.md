# OC-110 Runtime Authoring UX

## Goal

Make OpenCollection runtime behavior editable from Missio's visual request editor. Users should be able to create and maintain scripts, tests, assertions, and set-variable actions without hand-editing YAML for common workflows.

## Current Gap

OC-040 added the runtime engine and result display. OC-080 extends runtime execution to WebSocket and gRPC. The remaining gap is authoring: runtime features exist in YAML and response output, but the request editor does not provide a first-class UI for managing them.

| Surface | Gap |
| --- | --- |
| Runtime scripts | Users must hand-edit `runtime.scripts[]` for `before-request`, `after-response`, and `tests` script code. |
| Assertions | Users must hand-edit `runtime.assertions[]` with expression, operator, expected value, disabled state, and descriptions. |
| Actions | Users must hand-edit `runtime.actions[]`, including `set-variable` phase, selector, target scope, and variable name. |
| Ordering and disabled state | Users cannot reorder runtime entries or toggle them from the visual editor. |
| YAML safety | A UI implementation must preserve unsupported-but-valid runtime fields and existing script/action data. |
| Documentation | User-facing docs and demo notes do not yet explain visual runtime authoring workflows. |

## Implementation Plan

1. Audit the current runtime schema and editor serializer:

| Area | Work |
| --- | --- |
| Schema | Review `runtime.scripts`, `runtime.assertions`, `runtime.actions`, request defaults, and top-level script files. |
| Editor model | Confirm no-op request editor saves preserve all runtime fields, including unknown valid fields. |
| Response UI | Confirm runtime result display remains output-only and is not conflated with authoring controls. |
| Existing demos | Use `examples/demo-api/Runtime/` as real authoring examples. |

2. Design the request editor runtime section:

| Need | Expected Behavior |
| --- | --- |
| Runtime entry point | Add a clear request-editor section or tab for runtime behavior. |
| Scripts | Add, remove, disable, reorder, and edit script entries with phase selection and code text. |
| Tests | Support test script authoring as `runtime.scripts[]` entries with `type: tests`. |
| Assertions | Add, remove, disable, reorder, and edit assertion expression/operator/expected value/description. |
| Actions | Add, remove, disable, reorder, and edit `set-variable` actions with phase, selector method/expression, target scope, and variable name. |
| Inheritance | Show collection/folder/request defaults clearly when available, without silently flattening inherited defaults into the request. |

3. Preserve schema-native YAML:

| Requirement | Behavior |
| --- | --- |
| No data loss | Unknown but schema-valid runtime fields survive visual no-op edits. |
| Stable ordering | Reordering in the UI produces deterministic YAML arrays. |
| Disabled entries | Disabled scripts/assertions/actions remain present and do not get dropped. |
| Protocol neutrality | The authoring UI works for HTTP, GraphQL, WebSocket, and gRPC request files without adding protocol-specific roots. |

4. Add documentation and user-verifiable examples:

| Area | Work |
| --- | --- |
| Demo notes | Update runtime demo request descriptions if needed so users know what to edit and what result to expect. |
| Wiki/docs | Document visual runtime authoring and the YAML escape hatch for advanced runtime fields. |
| Smoke guidance | Include local demo server instructions for verifying scripts, assertions, tests, and actions. |

## Dependencies

| Task | Impact |
| --- | --- |
| OC-040 | Provides runtime engine, result model, sandbox behavior, assertions, tests, and actions. |
| OC-060 | Provides no-op round-trip safety patterns for schema-valid runtime data. |
| OC-070 | May touch request editor import/export surfaces; coordinate before editing shared request panel files. |
| OC-080 | Defines non-HTTP runtime request/response shapes; authoring should remain protocol-neutral and not assume HTTP-only response data. |
| OC-100 | Provides request type identity in the editor shell; runtime authoring should fit into that layout without competing with protocol controls. |

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Script authoring | Visual editor can create, edit, disable, remove, and reorder before-request, after-response, and test scripts. |
| Assertion authoring | Visual editor can create, edit, disable, remove, and reorder runtime assertions with supported operators and expected values. |
| Action authoring | Visual editor can create, edit, disable, remove, and reorder `set-variable` actions with phase, selector, and target controls. |
| Round-trip safety | Existing runtime YAML, including disabled entries and unknown schema-valid fields, survives no-op and edited saves. |
| Protocol neutrality | Runtime authoring works for HTTP, GraphQL, WebSocket, and gRPC request files. |
| Usability | Users can verify common runtime workflows from the visual editor using local demo requests. |
| Tests | Complete automated editor/model/round-trip/validation tests cover happy paths, disabled entries, ordering, preservation, and protocol regressions. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| Add runtime script in editor model. | Saved YAML contains a schema-valid `runtime.scripts[]` entry with the selected phase and code. |
| Add assertion and action in editor model. | Saved YAML contains schema-valid `runtime.assertions[]` and `runtime.actions[]` entries. |
| Disable and reorder runtime entries. | Disabled state and array order persist after save/reload. |
| No-op edit of existing runtime fixture. | Existing scripts, assertions, actions, and unknown schema-valid fields are preserved. |
| Protocol fixture coverage. | HTTP, GraphQL, WebSocket, and gRPC requests can save runtime edits without stale protocol roots or validation failures. |
| UI shell regression. | Runtime authoring controls render with stable labels, controls, empty states, and no overlap with response Runtime results. |

## Out Of Scope

| Area | Reason |
| --- | --- |
| Runtime execution semantics | Covered by OC-040 and OC-080. |
| Protocol-specific snippet export | Covered by OC-070. |
| Postman script/event import conversion | Covered by OC-070 import/export work. |
| Interactive script debugger | This task covers authoring and save/round-trip behavior, not breakpoints or step debugging. |
