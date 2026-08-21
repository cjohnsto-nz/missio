# OC-170 Request Action First-Click Reliability

## Goal

Make every primary request action fire on the first user activation immediately after opening a request editor.

Users should not need a priming click before Send, Connect, Disconnect, Send Message, or equivalent protocol actions work. If an action is not ready because the editor is still hydrating, the UI must show a clear disabled/loading state rather than accepting and silently dropping the first click.

## Current Gap

| Surface | Gap |
| --- | --- |
| Request editor startup | After opening a request, the first click on action buttons can be ignored outright. |
| HTTP and GraphQL | Send must fire on the first click after open, reload, and protocol-aware hydration. |
| WebSocket | Connect, Disconnect, and Send Message must be armed on first paint once visible and enabled. |
| gRPC | Unary and streaming send actions must not require a focus or hydration priming click. |
| Action routing | CodeLens, command palette, toolbar buttons, and Copilot-triggered actions should share a consistent ready-state contract. |
| Tests | There is no explicit automated coverage proving first-click behavior immediately after editor open. |

## Likely Causes To Investigate

- VS Code webview focus activation swallowing the first pointer event.
- Button handlers being attached after the buttons become visible.
- Request hydration replacing DOM nodes after the first click target is rendered.
- Disabled/loading attributes or CSS classes being cleared after the first user interaction.
- Invisible overlays, first-paint shells, response panes, or pointer-event CSS blocking the initial click.
- Debounced YAML/model updates racing with action dispatch and causing the action to no-op.
- Duplicate handler registration or teardown during protocol layout transitions.

## Scope

1. Reproduce or concretely rule out the issue for HTTP, GraphQL, WebSocket, and gRPC requests.
2. Audit request editor startup, hydration, action binding, ready state, and VS Code `postMessage` routing.
3. Ensure visible enabled controls are armed before they can be clicked.
4. Add deterministic tests that dispatch the first click immediately after initial render and after hydration.
5. Cover mouse activation, keyboard activation where the control supports it, and command/CodeLens parity.
6. Preserve protocol-native first-paint behavior from OC-130 and WebSocket lifecycle behavior from OC-140.
7. Update the central progress ledger before and after implementation.

## Implementation Guidance

- Prefer stable event delegation from the earliest request webview script initialization point over attaching late per-button handlers.
- Do not show enabled-looking controls before the request model, VS Code API bridge, action route, and protocol state are ready.
- If an action is clicked while hydration is legitimately incomplete, either keep the control disabled or queue the action explicitly. Do not silently drop it.
- Keep action dispatch single-shot. The fix must not create double sends, duplicate WebSocket connects, or repeated gRPC calls.
- Use shared request editor helpers where possible so HTTP, GraphQL, WebSocket, and gRPC do not drift.
- Keep Copilot tools and CodeLens behavior aligned with the same request action readiness rules.

## Acceptance Criteria

- The root cause is documented in `AGENT_PROGRESS.md`, or the issue is ruled out with concrete reproduction evidence and tests.
- First click after opening a request sends exactly one action for HTTP Send, GraphQL Send, gRPC Send, WebSocket Connect, WebSocket Disconnect, and WebSocket Send Message where applicable.
- Keyboard activation through Enter/Space works for the same visible controls where supported.
- Visible enabled buttons are never in a state where they can accept a click but no-op due to missing handlers or stale request state.
- Invalid YAML fallback, neutral/protocol first-paint shell, slow hydration, and reopen/reload flows are covered.
- No duplicate sends/connects are introduced by repeated hydration or event-handler registration.
- Request data posted by the first click uses the latest editor model/YAML and does not regress variable/runtime handling.
- Automated tests cover the failure mode, the fix, and shared request editor regressions.
- `npm run compile`, focused tests, `npm test`, `npm run build`, package, and local install verification pass before marking the task done.

## Suggested Test Coverage

- Add or extend request webview tests to render the initial shell, dispatch a click on each primary action as the first interaction, and assert exactly one message is posted.
- Add hydration-transition tests proving first-click behavior before and after the request model is applied.
- Extend protocol layout stability coverage for no stale HTTP controls, no blocked pointer events, and no duplicate handlers.
- Extend WebSocket lifecycle tests for connect/disconnect/send-message first-click readiness and no duplicate session actions.
- Extend gRPC and GraphQL editor/action tests as needed so protocol-specific send buttons are covered.
- Add command and CodeLens regressions if the root cause touches shared action routing.

Recommended verification:

```powershell
npm run compile
npx vitest run test/protocolLayoutStability.test.ts test/webSocketSupport.test.ts test/requestTypeUx.test.ts test/graphqlSupport.test.ts test/grpcSupport.test.ts test/sendRequestTool.test.ts
npm test
npm run build
npm run install:local
```

Package/install verification may use the project-local build/install script if that is the current supported flow.
