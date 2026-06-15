# Missio OpenCollection Gap Implementation Wiki

This wiki breaks the OpenCollection feature gap assessment into implementation tracks that parallel AI agents can claim, execute, and report against.

## Start Here

1. Read [AGENT_PROGRESS.md](AGENT_PROGRESS.md).
2. For stack review and merge sequencing, read [REVIEW_GUIDE.md](REVIEW_GUIDE.md).
3. Run `but status -fv` and read the current GitButler workspace state.
4. Claim one unowned task by editing the owner and status fields in the central table.
5. Create or identify the GitButler branch/stack for the task.
6. Read the matching task page under [tasks/](tasks/).
7. Record a test coverage plan in the central ledger before editing implementation code.
8. Keep the progress ledger current before and after code changes.
9. Link PRs, branches, commits, test runs, and blockers in the ledger.

## GitButler Required Workflow

Missio uses GitButler so multiple agents can work in parallel branches/stacks inside one workspace.

| Rule | Required Behavior |
| --- | --- |
| Inspect state | Start every work session with `but status -fv`. Use IDs from the current output. |
| Use `but` for writes | Do not run `git add`, `git commit`, `git push`, `git checkout`, `git merge`, `git rebase`, `git stash`, or `git cherry-pick`. |
| Create task branches | Use `but branch new <name>` for independent work. Use stacked branches only when a task depends on another branch. |
| Assign changes | Use `but stage <file-or-hunk-id> <branch-id>` or `but commit <branch-id> -m "<msg>" --changes <id>,<id>`. |
| Commit safely | Prefer `--changes` with file/hunk IDs from `but status -fv` or `but diff` so unrelated agent work remains untouched. |
| Pull/push | Use `but pull --check` then `but pull`; use `but push <branch-id>` or `but pr new <branch-id>`. |
| Read-only Git | `git log`, `git show`, and `git blame` are allowed for inspection. Raw Git write commands are not. |

GitButler skill availability has been verified with `but skill check`:

| Install | Path | Version |
| --- | --- | --- |
| Agent Skills global | `C:\Users\chris\.agents\skills\gitbutler` | `0.20.0` |
| OpenCode local | `.opencode/skills/gitbutler` | `0.20.0` |

If an agent host injects the GitButler skill, use it. If not, read `.opencode/skills/gitbutler/SKILL.md` before performing version-control operations.

## Test Coverage Contract

Every implementation change needs complete automated coverage for the behavior it adds or changes. A task cannot move to `Review Ready` or `Done` until the task row and log include the coverage plan, exact commands run, results, and any remaining gaps.

| Area | Coverage Required |
| --- | --- |
| New behavior | Unit or service tests prove each supported happy path. |
| Changed behavior | Regression tests protect existing HTTP behavior, existing imports/exports, and existing editor serialization affected by the change. |
| Failure behavior | Tests cover invalid schema input, unsupported protocol paths, auth/runtime failures, cancellation or cleanup, and user-facing diagnostics where relevant. |
| Round-trip safety | Schema-valid fixtures load and save without losing unsupported-but-valid OpenCollection fields. |
| Runtime/security | Scripts, assertions, auth, proxy, mTLS, redirects, and sandbox behavior include negative/security-sensitive tests. |
| Protocol execution | GraphQL, WebSocket, and gRPC execution use local fixture servers, not external services. |
| UI/tooling | Tree, CodeLens, command, visual editor, import/export, and Copilot tool changes have focused tests or extension-host tests matching the existing repo pattern. |

If a scenario truly cannot be automated in this repo, document the reason, manual verification, and follow-up work in `AGENT_PROGRESS.md`. Do not use this exception for behavior that can be covered with unit, service, fixture, round-trip, or extension-host tests.

## Task Hierarchy

| ID | Track | Task Page | Primary Outcome |
| --- | --- | --- | --- |
| OC-000 | Foundation | [00-foundation-and-dispatch.md](tasks/00-foundation-and-dispatch.md) | Protocol-complete model, type guards, dispatch, and task-safe architecture. |
| OC-010 | GraphQL | [01-graphql.md](tasks/01-graphql.md) | Schema-native GraphQL editor, executor, validation, and tests. |
| OC-020 | WebSocket | [02-websocket.md](tasks/02-websocket.md) | WebSocket editor, connection lifecycle, message log, and tests. |
| OC-030 | gRPC | [03-grpc.md](tasks/03-grpc.md) | Protobuf config, gRPC editor, unary execution, and streaming plan. |
| OC-040 | Runtime | [04-runtime-scripting-testing.md](tasks/04-runtime-scripting-testing.md) | Scripts, tests, assertions, actions, and runtime variable mutation. |
| OC-050 | Auth/Transport | [05-auth-proxy-mtls.md](tasks/05-auth-proxy-mtls.md) | Missing auth methods, OAuth2 gaps, proxy, mTLS, redirects. |
| OC-060 | Schema Safety | [06-schema-roundtrip-validation.md](tasks/06-schema-roundtrip-validation.md) | Round-trip preservation, validation coverage, YAML schema wiring. |
| OC-070 | User/Agent Surface Polish | [07-import-export-copilot.md](tasks/07-import-export-copilot.md) | Protocol-aware request creation, import/export behavior, snippet limits, and Copilot polish. |
| OC-080 | Protocol Runtime Lifecycle | [08-runtime-non-http-protocols.md](tasks/08-runtime-non-http-protocols.md) | Apply scripts, assertions, tests, actions, and runtime variables to supported non-HTTP executors. |
| OC-090 | gRPC Streaming | [09-grpc-streaming.md](tasks/09-grpc-streaming.md) | Client, server, and bidirectional gRPC streaming execution, UI, fixtures, and tests. |
| OC-100 | Request Type UX | [10-request-type-ux.md](tasks/10-request-type-ux.md) | UI request type selection, read-only type visibility, and Bruno/Postman-aligned workflow review. |
| OC-110 | Runtime Authoring UX | [11-runtime-authoring-ux.md](tasks/11-runtime-authoring-ux.md) | Visual editor authoring for scripts, tests, assertions, and set-variable actions. |
| OC-120 | Preview Media Controls | [12-preview-media-controls.md](tasks/12-preview-media-controls.md) | Zoom, rotate, fit, reset, and Ctrl+scroll controls for image/PDF response previews. |
| OC-130 | Protocol Layout Stability | [13-protocol-layout-stability.md](tasks/13-protocol-layout-stability.md) | Protocol-native first paint and layout stability when opening non-HTTP requests. |
| OC-140 | WebSocket Lifecycle UX | [14-websocket-lifecycle-ux.md](tasks/14-websocket-lifecycle-ux.md) | First-class connect, disconnect, send, status bar, CodeLens, and Copilot lifecycle management for WebSocket sessions. |
| OC-150 | Runtime Assertion Variables And WebSocket Results UX | [15-runtime-assertion-variables.md](tasks/15-runtime-assertion-variables.md) | Variable-aware assertion fields, assertion interpolation, WebSocket runtime result visibility, and lifecycle button contrast. |
| OC-160 | gRPC Demo Server Reliability | [16-grpc-demo-server-reliability.md](tasks/16-grpc-demo-server-reliability.md) | User-verifiable gRPC demo startup, localhost fixture reliability, and live smoke coverage. |
| OC-170 | Request Action First-Click Reliability | [17-request-action-first-click.md](tasks/17-request-action-first-click.md) | Send, Connect, Disconnect, and related request actions fire on first click after opening a request. |

## Project Skills

Project-local skills live in [.agents/skills/](../../.agents/skills/). They are intentionally compact and point agents back to this wiki:

| Skill | Use For |
| --- | --- |
| `missio-agent-coordination` | Claiming tasks, updating the shared ledger, and working safely in parallel. |
| `missio-protocol-implementer` | GraphQL, WebSocket, and gRPC protocol work. |
| `missio-runtime-implementer` | Scripts, assertions, actions, auth, proxy, mTLS, and transport runtime work. |
| `missio-editor-schema-implementer` | Editors, validation, imports, exports, and schema round-trip safety. |
| `missio-demo-server-fixtures` | Extending the local demo API and example requests for user-verifiable protocol/runtime features. |
| `but` | Installed GitButler skill for branch, stack, commit, push, and PR operations. |

## Final Compatibility Evidence

OC-000 through OC-150 are implemented and tracked in [AGENT_PROGRESS.md](AGENT_PROGRESS.md). OC-160 and OC-170 are focused follow-ups for gRPC demo reliability and first-click request action reliability. The table below records the main evidence surfaces that remain useful for maintenance and future audits.

| Evidence Surface | Location |
| --- | --- |
| Request creation, starter templates, and visible request type identity. | [src/commands/requestCommands.ts](../../src/commands/requestCommands.ts), [src/services/requestTemplates.ts](../../src/services/requestTemplates.ts), [src/webview/requestPanel.ts](../../src/webview/requestPanel.ts) |
| Import/export protocol diagnostics and snippet limitations. | [src/importers](../../src/importers), [src/services/snippetExporter.ts](../../src/services/snippetExporter.ts) |
| Runtime scripting, tests, assertions, actions, and visual authoring. | [src/services/runtimeExecutionService.ts](../../src/services/runtimeExecutionService.ts), [src/webview/requestPanel.ts](../../src/webview/requestPanel.ts) |
| Request editor action readiness, first-click behavior, and protocol action routing. | [src/panels/requestPanel.ts](../../src/panels/requestPanel.ts), [src/webview/requestPanel.ts](../../src/webview/requestPanel.ts), [src/commands/requestCommands.ts](../../src/commands/requestCommands.ts) |
| Protocol execution for GraphQL, WebSocket, and gRPC unary/streaming requests. | [src/services/graphqlSupport.ts](../../src/services/graphqlSupport.ts), [src/services/webSocketClient.ts](../../src/services/webSocketClient.ts), [src/services/grpcClient.ts](../../src/services/grpcClient.ts) |
| Local fixture API, demo requests, and collection validation. | [examples/demo-api](../../examples/demo-api), [scripts/validate-collection.js](../../scripts/validate-collection.js) |
| gRPC demo startup and fixture smoke coverage. | [examples/demo-api/grpc-server.js](../../examples/demo-api/grpc-server.js), [examples/demo-api/gRPC](../../examples/demo-api/gRPC) |

## Definition Of Done For Any Track

Each task is done only when all relevant surfaces are handled:

| Surface | Required Work |
| --- | --- |
| Schema/model | TypeScript types align with `schema/opencollectionschema-source.json`; Missio extensions remain explicit. |
| YAML/load/save | Data loads, edits, and saves without losing unsupported-but-valid schema fields. |
| UI | Tree, editor, command, CodeLens, response view, and status UX are coherent. |
| Execution | Runtime behavior applies variables, defaults, auth, settings, secrets, cancellation, and diagnostics. |
| Validation | CLI/service validation and VS Code YAML validation cover the feature. |
| Tests | Complete automated tests cover happy path, failure path, regression risk, round-trip preservation, and fixture-backed integration paths relevant to the change. |
| Docs | README or wiki notes are updated where user-visible behavior changes. |
