# OC-150 Runtime Assertion Variables And WebSocket Results UX

## Goal

Make runtime assertions behave like the rest of Missio's variable-compatible request editor fields, and make runtime assertion results discoverable for WebSocket requests. Users should be able to type `{{variable}}` in assertion fields with the same highlighting, tooltip, and autocomplete support they get in headers, params, and bodies; runtime execution should resolve those variables before evaluating assertions; and WebSocket users should have a clear place to see runtime scripts, tests, assertions, actions, logs, and failures.

This task also owns the dark-mode contrast polish for WebSocket lifecycle buttons requested after OC-140.

## Current Gap

| Surface | Gap |
| --- | --- |
| Assertion field UX | `runtime.assertions[]` editor rows use plain text inputs for expression, expected value, and description. Variables are not visually highlighted and do not autocomplete. |
| Variable field reuse | Missio already has shared variable-aware input helpers in `src/webview/varFields.ts`, including `enableVarOverlay`. Runtime assertion rows should reuse that battle-tested path instead of adding a second autocomplete/highlight system. |
| Runtime evaluation | Assertion execution currently compares raw assertion strings. A value like `{{expectedStatus}}` remains literal instead of resolving through the same visible variable set used by runtime scripts and request execution. |
| Unresolved variable detection | Runtime assertion fields are not consistently scanned by unresolved-variable detection, so missing assertion variables can fail late and unclearly. |
| WebSocket result visibility | WebSocket runtime assertions may execute through the protocol runtime lifecycle, but the editor's WebSocket ledger-only response layout can hide the Runtime result surface. Users need a protocol-native way to see pass/fail details, logs, actions, and errors. |
| Lifecycle button contrast | Current WebSocket connect/disconnect button colors can render with dark text on bright red/green backgrounds in dark mode. Use white text and calmer dark-mode colors. |

## Implementation Plan

1. Reuse the shared variable field component for assertion authoring:

| Area | Expected Work |
| --- | --- |
| Field audit | Review existing uses of `enableVarOverlay`, especially header/form field rows in `src/webview/requestPanel.ts`, and mirror the same pattern for runtime assertion rows. |
| Assertion rows | Apply variable highlighting, hover details, and autocomplete to `.rt-assertion-expression`, `.rt-assertion-value`, and `.rt-assertion-description` where the field remains an input. |
| Dynamic rows | Ensure newly added assertions receive overlays immediately and existing rows refresh when variables are resolved or the document is rehydrated. |
| Shared helper | Prefer a small request-panel helper for runtime variable fields if multiple runtime row types need the same setup. Do not fork a bespoke variable parser or autocomplete menu. |
| Save behavior | Preserve current debounce/save behavior and make sure overlay wrappers do not change serialized YAML values. |

2. Resolve variables before assertion evaluation:

| Area | Expected Work |
| --- | --- |
| Interpolation helper | Add or reuse a safe template interpolation helper for assertion fields based on the runtime-visible variable map. Do not use raw script interpolation semantics for arbitrary JavaScript code without tests. |
| Expected value | Resolve `assertion.value` before calling the assertion comparator so `{{expectedName}}`, `{{token}}`, and nested environment/runtime variables work. |
| Expression | Support variable templates in `assertion.expression` where practical, for cases such as selecting a response field name from `{{assertionField}}`. Continue to support direct `variables.foo` access in expressions. |
| Description | Resolve or display description variables consistently in runtime output when descriptions are shown. Preserve the authored YAML text. |
| Protocol neutrality | Apply assertion interpolation for all runtime-capable protocols: HTTP, GraphQL, WebSocket, and gRPC. |
| Failure behavior | Missing variables should produce deterministic diagnostics or assertion failures. They must not silently pass or erase the placeholder. |

3. Extend unresolved-variable detection:

| Area | Expected Work |
| --- | --- |
| Assertion fields | Scan `runtime.assertions[].expression`, `runtime.assertions[].value`, and `runtime.assertions[].description` for `{{variable}}` references. |
| Runtime variables | Treat variables set earlier in the runtime lifecycle and inherited collection/folder/environment variables consistently with existing request variable detection. |
| Agent/tool paths | Ensure request panel sends, CodeLens sends, and Copilot/tool sends use the same unresolved-variable behavior. |
| Scope audit | Check sibling runtime authoring fields such as action selectors and descriptions. Expand coverage if they are also variable-compatible, or record a follow-up if that would be a larger task. |

4. Make WebSocket runtime results visible:

| Area | Expected Work |
| --- | --- |
| UX decision | Add a protocol-native Runtime result surface to the WebSocket session area, or conditionally reveal the existing Runtime tab when a WebSocket response contains runtime results. |
| No HTTP flash | Keep OC-130/OC-140 layout stability: do not reintroduce an empty HTTP response placeholder/body for WebSocket requests. |
| Result detail | Show assertion pass/fail state, expression, expected/resolved value, actual value, tests, logs, actions, errors, and timing where available. |
| Session timing | For persistent sessions, make clear which response/session event produced the runtime result, especially after disconnect or lifecycle completion. |
| Tool parity | Preserve response provider and Copilot result payload behavior so agents can also inspect runtime failures. |

5. Polish WebSocket lifecycle button contrast:

| Area | Expected Work |
| --- | --- |
| Dark mode connect | In dark mode, use background `#2aa32a` and white text for the connected/connect action state. |
| Dark mode disconnect | In dark mode, use background `#a33e2a` and white text for the disconnect/destructive action state. |
| States | Preserve disabled, hover, active, and focus-visible states with accessible contrast. |
| Theme safety | Keep light/high-contrast themes readable. Use scoped CSS and VS Code theme selectors where appropriate. |

## Dependencies

| Task | Impact |
| --- | --- |
| OC-040 | Provides the runtime assertion engine and result model. |
| OC-080 | Extends runtime lifecycle execution to WebSocket and gRPC. Assertion interpolation must stay protocol-neutral. |
| OC-110 | Provides runtime authoring rows that this task should extend rather than replace. |
| OC-130 | Protects protocol-native first paint and no HTTP-default flash. |
| OC-140 | Provides WebSocket lifecycle controls and ledger-only response layout that this task must refine. |

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Variable-aware assertion fields | Runtime assertion expression, expected value, and description fields highlight `{{variables}}`, expose variable hover/autocomplete behavior, and serialize clean YAML values. |
| Runtime interpolation | Assertions resolve variable templates before evaluation across HTTP, GraphQL, WebSocket, and gRPC runtime execution. |
| Clear unresolved behavior | Missing variables in assertion fields are detected before execution or reported through deterministic assertion diagnostics. |
| WebSocket result visibility | WebSocket users can see runtime script/test/assertion/action output in the editor after the relevant lifecycle response or disconnect event. |
| Stable WebSocket layout | Result visibility does not bring back an empty HTTP response pane or stale HTTP controls for WebSocket requests. |
| Button contrast | Dark-mode WebSocket lifecycle buttons use white text, connect green `#2aa32a`, and disconnect red `#a33e2a` without black text. |
| Tests | Complete automated tests cover editor field behavior, runtime interpolation, unresolved-variable detection, WebSocket result visibility, button contrast, and shared runtime/protocol regressions. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| Runtime authoring UI variable tests | `test/runtimeAuthoringUx.test.ts` proves assertion inputs are wired through the shared variable-aware field path and dynamically added rows get overlays/autocomplete. |
| Runtime execution interpolation tests | `test/runtimeExecutionService.test.ts` proves assertion expected values and supported expression templates resolve from environment/request/runtime variables before comparison. Include unresolved-variable and disabled-assertion cases. |
| Unresolved variable tests | `test/unresolvedVars.test.ts` or protocol-specific tests prove missing variables in assertion expression/value/description fields are reported before send/tool execution. |
| WebSocket runtime result visibility tests | `test/webSocketSupport.test.ts` proves a WebSocket request with runtime assertions surfaces pass/fail details in the editor after lifecycle completion or disconnect. |
| Protocol layout regression tests | `test/protocolLayoutStability.test.ts` proves the WebSocket runtime result surface does not reintroduce HTTP-default first paint or hidden/stale HTTP response controls. |
| CSS contrast tests | Existing CSS/source tests assert dark-mode connect/disconnect colors and white text for WebSocket lifecycle buttons. |
| Shared runtime regression suite | Re-run runtime, WebSocket, gRPC, GraphQL, response provider, send tool, request type UX, and validation tests touched by shared code. |

Recommended verification commands:

```powershell
npm run compile
npx vitest run test/runtimeAuthoringUx.test.ts test/runtimeExecutionService.test.ts test/unresolvedVars.test.ts test/webSocketSupport.test.ts test/protocolLayoutStability.test.ts test/responseProvider.test.ts test/sendRequestTool.test.ts
node scripts/validate-collection.js examples/demo-api
npm test
npm run build
```

## Out Of Scope

| Area | Reason |
| --- | --- |
| Full runtime debugger | This task improves authoring and result visibility, not breakpoints or step-through script debugging. |
| New runtime assertion operators | Keep the operator model stable unless a missing operator is required to prove interpolation. |
| WebSocket load testing or monitors | OC-140/OC-150 are interactive debugging workflows, not batch monitoring. |
| Request type switching | Covered by OC-100 decisions and remains out of scope. |
