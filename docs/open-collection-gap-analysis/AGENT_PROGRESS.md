# Agent Progress Ledger

This is the shared coordination file for parallel agents. Update it before starting work, after meaningful progress, and before ending a session.

## Update Protocol

1. Run `but status -fv` and read the applied stacks plus unassigned changes.
2. Claim one task by setting `Owner`, `Status`, `GitButler Branch/Stack/PR`, and `Last Update`.
3. Create a task branch with `but branch new <name>` unless a suitable applied branch already exists.
4. Keep claims narrow. Split work into subtasks in the task log when needed.
5. Fill in `Coverage Plan` before editing implementation code.
6. Do not overwrite another agent's notes. Append to the task log instead.
7. Use `Blocked` only when progress is impossible without external input or a dependency.
8. Move to `Review Ready` only after automated tests for the coverage plan pass.
9. When done, add test evidence and links, then set `Status` to `Done`.

Status values: `Unclaimed`, `Claimed`, `In Progress`, `Review Ready`, `Blocked`, `Done`.

## Supervisor

| Role | Owner | Scope | Since | Current Focus |
| --- | --- | --- | --- | --- |
| Supervisor | Codex | Sanity-check completed tracks, run build/test/package/install verification, preserve GitButler branch hygiene, and append progress reports. | 2026-06-14 22:31 NZT | OC-000 and OC-060 implementation audit. |

## Test Coverage Rules

Every code change must include complete automated coverage for the behavior it adds or changes. Record the plan before implementation and the evidence before review:

| Requirement | Agent Responsibility |
| --- | --- |
| Coverage plan | Name the unit, service, fixture integration, extension-host, round-trip, or regression tests that will prove the change. |
| Happy paths | Cover every newly supported OpenCollection feature path in scope. |
| Failure paths | Cover validation errors, unsupported protocol behavior, auth/runtime failures, cleanup/cancellation, and diagnostics where relevant. |
| Regression safety | Run and, when needed, expand existing HTTP/import/export/editor tests touched by shared code. |
| Evidence | Record exact commands, pass/fail result, and links to PRs or commits. |
| Exceptions | If a scenario cannot be automated, document why, provide manual verification, and create follow-up work. Do not waive automatable tests. |

## GitButler Rules

Use GitButler for version-control writes so agents can work in parallel:

| Do | Command/Behavior |
| --- | --- |
| Inspect current workspace | `but status -fv` |
| View changes and hunk IDs | `but diff` |
| Create a branch | `but branch new <task-branch-name>` |
| Stage to a branch | `but stage <file-or-hunk-id> <branch-id>` |
| Commit specific changes | `but commit <branch-id> -m "<message>" --changes <id>,<id>` |
| Update from target branch | `but pull --check` then `but pull` |
| Push or open PR | `but push <branch-id>` or `but pr new <branch-id>` |

Do not use raw Git write commands: `git add`, `git commit`, `git push`, `git checkout`, `git merge`, `git rebase`, `git stash`, or `git cherry-pick`.

Use full branch names for stacking existing branches with `but move <child-branch> <parent-branch>`. Use `but move <branch> zz` to tear off a branch from a stack.

## Task Board

| ID | Task | Status | Owner | GitButler Branch/Stack/PR | Coverage Plan | Verification | Last Update | Next Action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OC-000 | Foundation and protocol dispatch | Done | Codex | feature/oc-000-foundation-dispatch (fo), stacked on docs/open-collection-agent-plan (do); implementation commit `c30cdec` | Satisfied by `test/openCollectionFoundation.test.ts`: schema item guards and mixed parsing, unbundled scan/tree routing for HTTP, GraphQL, gRPC, WebSocket, folder, and script items, execution facade HTTP delegation, unsupported GraphQL/WebSocket/gRPC diagnostics, validation schema routing, and non-HTTP editor save guard. Full suite covers shared HTTP/import/export regressions. | `npm run compile` passed; `npx vitest run test/openCollectionFoundation.test.ts` passed 9 tests; `npm test` passed 333 tests; `npm run build` passed. | 2026-06-14 22:24 NZT | OC-010/OC-020/OC-030/OC-070 can build on the stable item guards and execution facade. |
| OC-010 | GraphQL support | Unclaimed | - | - | - | - | - | Start after or alongside OC-000 interface design. |
| OC-020 | WebSocket support | Unclaimed | - | - | - | - | - | Start after OC-000 dispatch shape is stable. |
| OC-030 | gRPC support | Unclaimed | - | - | - | - | - | Start after OC-000 and dependency choice. |
| OC-040 | Scripts, tests, assertions, actions | Unclaimed | - | - | - | - | - | Can start with runtime design spike before OC-000 lands. |
| OC-050 | Auth, proxy, mTLS, transport completion | Unclaimed | - | - | - | - | - | Can start with HTTP-only fixes; proxy/mTLS need executor refactor. |
| OC-060 | Schema round-trip and validation | Done | Codex | feature/oc-060-schema-roundtrip-validation (sc), stacked on feature/oc-000-foundation-dispatch (fo); implementation commit `166c297` | Add golden no-op editor/serializer round-trip tests for schema-valid HTTP, GraphQL, WebSocket, gRPC, folder, environment, and collection fixtures; add validation tests proving protocol-aware request subschema selection, workspace validation in collection reports, protocol-labelled diagnostics, unknown-field preservation, and non-HTTP files not gaining `http` keys. Run targeted validation/editor/service tests plus existing touched HTTP/import-export/editor regressions. | `npx vitest run test/schemaRoundTrip.test.ts test/validationService.test.ts` passed (8 tests); `npm test` passed (15 files, 341 tests); `npm run compile` passed; `npm run build` passed. | 2026-06-14 22:30 NZT | OC-060 complete and committed; no OC-060-owned unassigned changes remain after implementation commit. |
| OC-070 | Imports, exports, tree, CodeLens, Copilot tools | Unclaimed | - | - | - | - | - | Start after type guards exist; some validation work can begin now. |

## Dependency Map

| Task | Depends On | Blocks |
| --- | --- | --- |
| OC-000 | None | OC-010, OC-020, OC-030, much of OC-070 |
| OC-010 | OC-000 dispatch shape | Protocol-aware UI/tools |
| OC-020 | OC-000 dispatch shape | WebSocket UI/tools |
| OC-030 | OC-000 dispatch shape, dependency choice | gRPC UI/tools |
| OC-040 | Runtime context contract from OC-000 is helpful | Full protocol lifecycle support |
| OC-050 | Can begin now; proxy/mTLS easier after OC-000 | Production-grade transport |
| OC-060 | None | Safe editor work across all tracks |
| OC-070 | OC-000 type guards, protocol executors | Agent/tool completeness |

## Shared Decisions

Record cross-cutting decisions here so parallel agents do not rediscover them.

| Date | Decision | Rationale | Owner |
| --- | --- | --- | --- |
| 2026-06-14 | Keep `schema/opencollectionschema-source.json` as upstream-only input and apply Missio additions through `schema/missio-extensions.json`. | Existing build system already separates upstream schema from Missio-specific extensions. | Codex |
| 2026-06-14 | Use GitButler for all version-control write operations. | `but` CLI 0.20.0 is installed, and `but skill check` reports current global Agent Skills and local OpenCode GitButler skills. This lets agents isolate work in parallel branches/stacks. | Codex |
| 2026-06-14 | Agent skills now require a finalization audit before marking tasks done. | Parallel agents need each task to classify uncommitted change IDs, commit only owned slices with GitButler, and log remaining unrelated IDs so completed work is not left only in `zz`. | Codex |

## Task Logs

### Supervisor Reports

- 2026-06-14 22:33 NZT - Codex: Declared Supervisor role and completed the first sanity audit for OC-000 and OC-060.
  GitButler: current applied stack includes `supervisor/oc-000-oc-060-audit` on top of `feature/oc-060-schema-roundtrip-validation` (sc), `feature/oc-000-foundation-dispatch` (fo), and `docs/open-collection-agent-plan` (do). Workspace had no unassigned changes before the supervisor ledger update.
  Coverage: inspected the OC-000 model/parser/execution/tree/tooling path and the OC-060 validation/round-trip/editor merge path; re-ran focused and full verification rather than relying only on agent notes.
  Changed: `docs/open-collection-gap-analysis/AGENT_PROGRESS.md` only.
  Verified: `npm run compile` passed; `npx vitest run test\openCollectionFoundation.test.ts test\schemaRoundTrip.test.ts test\validationService.test.ts` passed 17 tests; `npm test` passed 15 files and 341 tests; `npm run build` passed; `npx @vscode/vsce package --out %TEMP%\missio-0.7.7-supervisor.vsix` passed; `code.cmd --install-extension %TEMP%\missio-0.7.7-supervisor.vsix --force` installed successfully; `code.cmd --list-extensions --show-versions` shows `missio.missio@0.7.7`.
  Observed: `Code.exe --install-extension` failed because the executable does not accept the CLI flag on this install; `C:\Program Files\Microsoft VS Code\bin\code.cmd` is the correct wrapper. VSIX packaging currently includes `.agents/`, `.opencode/`, and docs folders; acceptable for this local install, but consider `.vscodeignore` cleanup before publishing.
  Next: proceed with OC-010/OC-020/OC-030/OC-070 kickoff as dependencies allow.

### OC-000 Foundation and Protocol Dispatch

- 2026-06-14 22:02 NZT - Codex: Claimed OC-000 and recorded coverage before implementation.
  GitButler: feature/oc-000-foundation-dispatch (fo); workspace also has docs/open-collection-agent-plan (do) and feature/scripting (sc) applied from existing work.
  Coverage: planned automated tests for schema item guards/mixed parsing, unbundled scan/tree routing, HTTP execution regression behavior, and unsupported protocol diagnostics.
  Changed: docs/open-collection-gap-analysis/AGENT_PROGRESS.md.
  Verified: `but status -fv` read successfully; implementation tests not run yet.
  Next: inspect current model/parser/executor/test structure and implement the OC-000 slice.
- 2026-06-14 22:17 NZT - Codex: Completed OC-000 foundation and protocol dispatch.
  GitButler: feature/oc-000-foundation-dispatch (fo); `but status -fv` shows OC-000 changes currently in unassigned change IDs including model/parser/executor/tree/tool/test files, with parallel OC-060 round-trip/webview work also present in the workspace.
  Coverage: implemented `test/openCollectionFoundation.test.ts` for item guards, non-HTTP parsing, unbundled mixed scan, protocol-aware tree nodes, execution facade dispatch, unsupported diagnostics, validation routing, Copilot send diagnostics, and the non-HTTP request editor save guard.
  Changed: `src/models/types.ts`, `src/services/yamlParser.ts`, `src/services/collectionService.ts`, `src/services/requestExecutionService.ts`, `src/services/validationService.ts`, `src/providers/collectionTreeProvider.ts`, `src/commands/*`, `src/copilot/tools/*`, `src/extension.ts`, `src/panels/requestPanel.ts`, `test/mocks/vscode.ts`, `test/openCollectionFoundation.test.ts`; also made minimal type-only compile fixes in unassigned `src/models/schemaRoundTrip.ts` that belongs to the parallel round-trip slice.
  Verified: `npm run compile` passed; `npx vitest run test/openCollectionFoundation.test.ts` passed 9 tests; `npm test` passed 333 tests; `npm run build` passed.
  Next: OC-010, OC-020, OC-030, and OC-070 can use `OpenCollectionItem`, protocol type guards, and `RequestExecutionService`; protocol executors remain explicit follow-up work.
- 2026-06-14 22:24 NZT - Codex: Finalized OC-000 into GitButler.
  GitButler: stacked `feature/oc-000-foundation-dispatch` on `docs/open-collection-agent-plan`; committed implementation as `c30cdec` (`Add OC-000 protocol dispatch foundation`). Agent skill feedback committed separately on `docs/open-collection-agent-plan` as `98c9d3d`.
  Coverage: unchanged from the 22:17 verification; no implementation files changed after the passing compile/test/build run.
  Changed: committed OC-000-owned implementation/test files to `fo`; left parallel OC-060 files (`src/models/schemaRoundTrip.ts`, `src/webview/*Panel.ts`, `test/schemaRoundTrip.test.ts`, `test/validationService.test.ts`) out of the OC-000 commit.
  Verified: `but commit feature/oc-000-foundation-dispatch -m "Add OC-000 protocol dispatch foundation" --changes ...` succeeded; final status audit pending after this ledger commit.
  Next: commit this ledger update to `fo`, then hand off protocol tracks to build on `OpenCollectionItem`, protocol guards, and `RequestExecutionService`.

### OC-010 GraphQL Support

No updates yet.

### OC-020 WebSocket Support

No updates yet.

### OC-030 gRPC Support

No updates yet.

### OC-040 Scripts, Tests, Assertions, Actions

No updates yet.

### OC-050 Auth, Proxy, mTLS, Transport Completion

No updates yet.

### OC-060 Schema Round-Trip and Validation

- 2026-06-14 22:04 NZT - Codex: Claimed OC-060 and recorded the coverage plan before implementation.
  GitButler: feature/oc-060-schema-roundtrip-validation (he); workspace also has docs/open-collection-agent-plan (do), feature/scripting (cr), and feature/oc-000-foundation-dispatch (fo) applied from existing work.
  Coverage: planned golden no-op editor/serializer round-trip tests for HTTP, GraphQL, WebSocket, gRPC, folder, environment, and collection fixtures; validation tests for protocol-aware subschema selection, workspace validation in collection reports, protocol-labelled diagnostics, unknown-field preservation, and non-HTTP safety.
  Changed: docs/open-collection-gap-analysis/AGENT_PROGRESS.md.
  Verified: `but status -fv`, `but diff`, and task page review completed; implementation tests not run yet.
  Next: inspect validation/editor serializer structure, add failing coverage, implement fixes, and run complete automated coverage.

- 2026-06-14 22:22 NZT - Codex: Completed OC-060 schema round-trip and validation implementation with automated coverage passing.
  GitButler: feature/oc-060-schema-roundtrip-validation (sc); latest `but status -fv` shows OC-060 files unassigned alongside unrelated OC-000 work, so commit/review must use explicit change IDs.
  Coverage: implemented no-op editor/serializer round-trip coverage for schema-valid HTTP, GraphQL, WebSocket, gRPC, folder, environment, and collection fixtures; validation coverage for protocol-aware request schema selection, workspace validation in collection reports, protocol-labelled diagnostics, unknown-field/defaults preservation, and non-HTTP files not gaining `http` keys.
  Changed: src/models/schemaRoundTrip.ts; src/services/validationService.ts; src/webview/requestPanel.ts; src/webview/collectionPanel.ts; src/webview/folderPanel.ts; test/schemaRoundTrip.test.ts; test/validationService.test.ts; docs/open-collection-gap-analysis/AGENT_PROGRESS.md.
  Verified: `npx vitest run test/schemaRoundTrip.test.ts test/validationService.test.ts` passed (8 tests); final `npm test` passed (15 files, 341 tests); final `npm run compile` passed; final `npm run build` passed.
  Next: Review or commit OC-060 with explicit GitButler change IDs only; do not include the parallel OC-000 files.

- 2026-06-14 22:30 NZT - Codex: Finalized OC-060 into GitButler after the updated finalization audit.
  GitButler: moved `feature/oc-060-schema-roundtrip-validation` onto `feature/oc-000-foundation-dispatch`; committed implementation as `166c297` (`Add OC-060 schema round-trip validation`) with only OC-060-owned change IDs `nq`, `vm`, `rz`, `rol`, `opy`, and `np`.
  Coverage: no-op schema round-trip coverage for HTTP, GraphQL, WebSocket, gRPC, folder, environment, and collection fixtures; validation coverage for protocol-aware request schemas, collection workspace validation, protocol-labelled diagnostics, unknown-field/default preservation, and non-HTTP safety.
  Changed: committed `src/models/schemaRoundTrip.ts`, `src/webview/collectionPanel.ts`, `src/webview/folderPanel.ts`, `src/webview/requestPanel.ts`, `test/schemaRoundTrip.test.ts`, and `test/validationService.test.ts` to `sc`; left OC-000 (`c3:*`, `46:*`) and planning docs (`98:*`, `11:*`) as stack dependencies.
  Verified: `npx vitest run test/schemaRoundTrip.test.ts test/validationService.test.ts` passed (8 tests); `npm test` passed (15 files, 341 tests); `npm run compile` passed; `npm run build` passed.
  Blockers/parallel changes: none; `but status -fv` was empty in `zz` immediately after the implementation commit, before this ledger-only update.
  Next: commit this ledger update separately to `sc`, then confirm no OC-060-owned unassigned changes remain.

### OC-070 Imports, Exports, Tree, CodeLens, Copilot Tools

No updates yet.
