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
| Supervisor | Codex | Sanity-check completed tracks, run build/test/package/install verification, preserve GitButler branch hygiene, and append progress reports. | 2026-06-14 22:31 NZT | OC-080/OC-090 task planning and OC-070 refresh. |

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
| OC-010 | GraphQL support | Done | Codex | feature/oc-010-graphql-support (ra), stacked on supervisor/demo-server-fixtures; implementation commit `a67a3ad` | Satisfied by `test/graphqlSupport.test.ts`, `test/schemaRoundTrip.test.ts`, `test/openCollectionFoundation.test.ts`, and `test/sendRequestTool.test.ts`: GraphQL body/variant adapter, schema-native editor round-trip, request panel save guard, execution facade query/mutation integration, unresolved variables/auth scanning, tree/CodeLens labels, command/Copilot routing, demo API schema validation, and shared HTTP regressions. | `npx vitest run test/graphqlSupport.test.ts test/schemaRoundTrip.test.ts test/validationService.test.ts test/openCollectionFoundation.test.ts test/unresolvedVars.test.ts test/sendRequestTool.test.ts` passed 51 tests; post-commit `npm test` passed 20 files/380 tests; `npm run compile` passed; `npm run build` passed; live `POST http://127.0.0.1:3456/graphql` smoke returned `health.status=ok`. | 2026-06-14 23:17 NZT | OC-010 complete and committed; final status has no unassigned changes, with shared runtime extension wiring commit `7a9dea5` also on the ra stack. |
| OC-020 | WebSocket support | Done | Codex | feature/oc-020-websocket-support (we); WebSocket demo/test commit `d599906`; shared runtime/editor/tooling is in applied protocol/runtime commits `a67a3ad`, `7a9dea5`, `872660b`, and dependency commit `0daa7be` | Satisfied by `test/webSocketSupport.test.ts`: WebSocketClient connect/send/receive/close/cancel cleanup, text/JSON/binary message types, selected message variants, inherited headers, bearer auth, invalid URL diagnostics, RequestExecutionService dispatch/cancel, schema-native editor merge and save guard, unresolved variable scanning, CodeLens/list/send Copilot routing, demo collection validation, and committed demo request smoke coverage. | `npx vitest run test/webSocketSupport.test.ts` passed 13 tests; targeted protocol/editor suite passed 54 tests; `npm test` passed 20 files/380 tests; `npm run compile` passed; `node scripts/validate-collection.js examples/demo-api` passed 32/32 files; live `node examples/demo-api/server.js` WebSocket smoke returned echo `hello demo`, auth `true`, close code `4000`; `npm run build` passed. | 2026-06-14 23:18 NZT | OC-020 complete; no OC-020-owned changes remain uncommitted. |
| OC-030 | gRPC support | Done | Codex | feature/oc-030-grpc-unary-protobuf (rp); implementation commit `02155e6` | Satisfied by `test/grpcSupport.test.ts`: protobuf config editing and preservation, gRPC validation/demo validation, metadata defaults and precedence, proto import path loading, unary fixture execution, variables/auth metadata, missing proto and invalid method diagnostics, unsupported streaming diagnostics, `RequestExecutionService` gRPC dispatch, and demo server smoke coverage. | `npx vitest run test/grpcSupport.test.ts test/schemaRoundTrip.test.ts test/validationService.test.ts` passed 16 tests; `npx vitest run test/openCollectionFoundation.test.ts test/runtimeExecutionService.test.ts test/grpcSupport.test.ts test/sendRequestTool.test.ts` passed 30 tests; `node scripts/validate-collection.js examples/demo-api` passed 32/32 files; `npm run compile`, `npm test` (20 files, 380 tests), and `npm run build` passed; demo `node examples/demo-api/grpc-server.js` unary smoke returned `ok: true`. | 2026-06-14 23:16 NZT | OC-030 complete; gRPC unary/protobuf is implemented and streaming remains explicitly unsupported with diagnostics. |
| OC-040 | Scripts, tests, assertions, actions | Done | Codex | feature/oc-040-runtime-scripting-testing (ru); primary implementation commit `Add OC-040 runtime scripting support`; shared runtime dependency commits `Add OC-010 GraphQL request support`, `Wire shared runtime execution services`, and `Add OC-030 gRPC unary protobuf support` on the applied stack | Satisfied by `test/runtimeExecutionService.test.ts`, `test/sendRequestTool.test.ts`, `test/responseProvider.test.ts`, and foundation/runtime regressions: lifecycle ordering, protocol-neutral context, sandbox-denied filesystem/process/network globals, console/test diagnostics, assertions, JSON selector `set-variable` actions, runtime variable mutation, HTTP request mutation, Runtime response tab/provider/tool output, fixture-backed demo runtime routes/requests, deterministic pass/fail diagnostics, demo collection validation, and shared HTTP no-op regression coverage. | `npx vitest run test/openCollectionFoundation.test.ts test/runtimeExecutionService.test.ts test/sendRequestTool.test.ts test/responseProvider.test.ts` passed 4 files/24 tests; `npm run compile` passed; `npm test` passed 20 files/380 tests; `npm run build` passed; `node scripts/validate-collection.js examples/demo-api` passed 32/32 files; live `node examples/demo-api/server.js` smoke verified `POST /runtime/echo`, `POST /runtime/token`, and `GET /runtime/assert-fail`. | 2026-06-14 23:42 NZT | OC-040 complete; no-change GitButler retry commits were removed during supervisor stack cleanup. |
| OC-050 | Auth, proxy, mTLS, transport completion | In Progress | Codex | feature/oc-050-auth-transport (ut) | Add fixture-backed executor tests for API-key query placement, OAuth2 header/query placement, token/additional params, redirect follow/stop/max handling, proxy routing/auth/bypass failure, mTLS success/failure, URL encoding, and explicit diagnostics for unsupported digest/NTLM/WSSE/AWS/implicit auth. Add demo server routes/requests for user-verifiable auth, redirects, proxy, and mTLS. Run targeted transport tests, demo collection validation, compile, full test, and build. | Pending | 2026-06-14 23:48 NZT | Inspect auth/transport models, executor, OAuth2 service, export/dry-run paths, and demo fixture shape; then implement the smallest HTTP-compatible slice with automated tests. |
| OC-060 | Schema round-trip and validation | Done | Codex | feature/oc-060-schema-roundtrip-validation (sc), stacked on feature/oc-000-foundation-dispatch (fo); implementation commit `166c297` | Add golden no-op editor/serializer round-trip tests for schema-valid HTTP, GraphQL, WebSocket, gRPC, folder, environment, and collection fixtures; add validation tests proving protocol-aware request subschema selection, workspace validation in collection reports, protocol-labelled diagnostics, unknown-field preservation, and non-HTTP files not gaining `http` keys. Run targeted validation/editor/service tests plus existing touched HTTP/import-export/editor regressions. | `npx vitest run test/schemaRoundTrip.test.ts test/validationService.test.ts` passed (8 tests); `npm test` passed (15 files, 341 tests); `npm run compile` passed; `npm run build` passed. | 2026-06-14 22:30 NZT | OC-060 complete and committed; no OC-060-owned unassigned changes remain after implementation commit. |
| OC-070 | Request creation, import/export, snippet, and Copilot surface polish | Unclaimed | - | - | - | - | - | Start after OC-050 if auth/transport templates matter; otherwise can begin with baseline audit and request creation. |
| OC-080 | Runtime lifecycle for WebSocket and unary gRPC | Unclaimed | - | - | - | - | - | Start after OC-040 and protocol executors; coordinate with OC-070 if Copilot runtime output changes. |
| OC-090 | gRPC streaming | In Progress | Codex | feature/oc-090-grpc-streaming (am), stacked on applied OC-030 unary/protobuf work | Add fixture-backed tests for schema-native client-streaming, server-streaming, and bidi-streaming message sequences; gRPC method discovery for request/response streaming; metadata/auth/default preservation; validation diagnostics for invalid streaming payloads/methods/proto symbols; cancellation/timeout cleanup and partial-error retention; response provider/UI and Copilot tool streaming summaries; demo collection validation; regression coverage for unary gRPC and shared protocol dispatch. Run focused gRPC/round-trip/validation/tool/provider tests, demo fixture smoke tests, compile, full test, build, and demo collection validation. | Pending | 2026-06-14 23:55 NZT | Inspect current gRPC client/model/editor/tooling/test fixtures, then add streaming fixtures and failing coverage before implementation. |
| OC-100 | Request type UX | Done | Codex | feature/oc-100-request-type-ux (g0 after restack), stacked on supervisor/add-request-type-ux-task; implementation commit `5cb05a3` | Satisfied by `test/requestTypeUx.test.ts`: schema-valid HTTP/GraphQL/WebSocket/gRPC starter templates, actual `missio.newRequest` protocol picker/write/open flow, YAML and editor-model round-trip safety, no stale protocol roots, gRPC same-protocol editor guard, and read-only protocol chip shell. Shared regressions cover HTTP/GraphQL/WebSocket/gRPC editor, validation, command/tool, and protocol behavior. Switcher/conversion helpers are intentionally out of scope because the benchmarked tools emphasize protocol choice at creation and Postman locks saved request protocols. | `npx vitest run test/requestTypeUx.test.ts test/schemaRoundTrip.test.ts test/openCollectionFoundation.test.ts test/validationService.test.ts` passed 4 files/25 tests; targeted protocol suite passed 8 files/68 tests; `npm run compile` passed; `npm test` passed 21 files/405 tests; `node scripts/validate-collection.js examples/demo-api` passed 42/42 files; `npm run build` passed. | 2026-06-15 00:15 NZT | OC-100 complete; no saved-request switcher was added by product decision and benchmark alignment. Remaining unassigned changes are parallel OC-050/OC-090 work, not OC-100. |

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
| OC-070 | OC-000 type guards, protocol executors; OC-050 if auth/template surfaces change | User/agent surface completeness |
| OC-080 | OC-040 runtime engine, OC-020 WebSocket executor, OC-030 gRPC unary executor | Runtime parity for supported protocols |
| OC-090 | OC-030 gRPC unary/protobuf support | Full gRPC protocol compatibility |
| OC-100 | OC-000 type guards, OC-010/OC-020/OC-030 protocol editor foundations; OC-050 if auth/template fields change | Request creation and conversion UX completeness |

## Shared Decisions

Record cross-cutting decisions here so parallel agents do not rediscover them.

| Date | Decision | Rationale | Owner |
| --- | --- | --- | --- |
| 2026-06-14 | Keep `schema/opencollectionschema-source.json` as upstream-only input and apply Missio additions through `schema/missio-extensions.json`. | Existing build system already separates upstream schema from Missio-specific extensions. | Codex |
| 2026-06-14 | Use GitButler for all version-control write operations. | `but` CLI 0.20.0 is installed, and `but skill check` reports current global Agent Skills and local OpenCode GitButler skills. This lets agents isolate work in parallel branches/stacks. | Codex |
| 2026-06-14 | Agent skills now require a finalization audit before marking tasks done. | Parallel agents need each task to classify uncommitted change IDs, commit only owned slices with GitButler, and log remaining unrelated IDs so completed work is not left only in `zz`. | Codex |

## Task Logs

### Supervisor Reports

- 2026-06-15 00:02 NZT - Codex: Added OC-100 as a focused request type UX task.
  GitButler: planning update is on `supervisor/add-request-type-ux-task`, stacked on `supervisor/add-oc080-oc090-tasks`; existing OC-050 and OC-090 implementation changes remain uncommitted and were not edited.
  Coverage: documentation-only planning change; no runtime behavior changed.
  Changed: `docs/open-collection-gap-analysis/README.md`, `AGENT_GOAL_PROMPTS.md`, `AGENT_PROGRESS.md`, `tasks/07-import-export-copilot.md`, and `tasks/10-request-type-ux.md`.
  Verified: `rg "OC-100|request type UX|Request Type UX" docs/open-collection-gap-analysis` confirmed the task board, prompts, README, OC-070 dependency note, and task page references are present; GitButler commit pending.
  Next: launch OC-100 as a focused editor/schema UX task once current OC-050/OC-090 file churn is low enough, or keep it queued behind OC-070 if import/export scope needs to share request templates.

- 2026-06-14 23:49 NZT - Codex: Added follow-up task definitions for the residual OpenCollection gaps and refreshed OC-070.
  GitButler: planning update is on `supervisor/add-oc080-oc090-tasks`, stacked on `supervisor/oc-010-040-audit`; OC-050 is already claimed on `feature/oc-050-auth-transport` and was left untouched.
  Coverage: documentation-only planning change; no runtime behavior changed.
  Changed: `docs/open-collection-gap-analysis/README.md`, `AGENT_GOAL_PROMPTS.md`, `AGENT_PROGRESS.md`, `tasks/07-import-export-copilot.md`, `tasks/08-runtime-non-http-protocols.md`, and `tasks/09-grpc-streaming.md`.
  Verified: `rg "OC-080|OC-090|OC-070" docs/open-collection-gap-analysis` confirmed the task board, prompts, task pages, and README references are present; GitButler commit pending.
  Next: user can launch OC-050 now; OC-080 and OC-090 are ready for later parallel kickoff after the current auth/transport slice is underway.

- 2026-06-14 22:33 NZT - Codex: Declared Supervisor role and completed the first sanity audit for OC-000 and OC-060.
  GitButler: current applied stack includes `supervisor/oc-000-oc-060-audit` on top of `feature/oc-060-schema-roundtrip-validation` (sc), `feature/oc-000-foundation-dispatch` (fo), and `docs/open-collection-agent-plan` (do). Workspace had no unassigned changes before the supervisor ledger update.
  Coverage: inspected the OC-000 model/parser/execution/tree/tooling path and the OC-060 validation/round-trip/editor merge path; re-ran focused and full verification rather than relying only on agent notes.
  Changed: `docs/open-collection-gap-analysis/AGENT_PROGRESS.md` only.
  Verified: `npm run compile` passed; `npx vitest run test\openCollectionFoundation.test.ts test\schemaRoundTrip.test.ts test\validationService.test.ts` passed 17 tests; `npm test` passed 15 files and 341 tests; `npm run build` passed; `npx @vscode/vsce package --out %TEMP%\missio-0.7.7-supervisor.vsix` passed; `code.cmd --install-extension %TEMP%\missio-0.7.7-supervisor.vsix --force` installed successfully; `code.cmd --list-extensions --show-versions` shows `missio.missio@0.7.7`.
  Observed: `Code.exe --install-extension` failed because the executable does not accept the CLI flag on this install; `C:\Program Files\Microsoft VS Code\bin\code.cmd` is the correct wrapper. VSIX packaging currently includes `.agents/`, `.opencode/`, and docs folders; acceptable for this local install, but consider `.vscodeignore` cleanup before publishing.
  Next: proceed with OC-010/OC-020/OC-030/OC-070 kickoff as dependencies allow.
- 2026-06-14 22:39 NZT - Codex: Completed supervisor packaging hygiene follow-up and confirmed the local binary upload server exists.
  GitButler: supervisor branch `supervisor/oc-000-oc-060-audit` remains stacked above OC-060/OC-000/planning branches; workspace had only `.vscodeignore` before this ledger update.
  Coverage: packaging verification only; no runtime behavior changed.
  Changed: `.vscodeignore` excludes development-only coordination/config folders and `docs/open-collection-gap-analysis/**` from VSIX packages.
  Verified: `npx @vscode/vsce package --out %TEMP%\missio-vscodeignore-check.vsix` passed; file list no longer includes `.agents/`, `.opencode/`, `.github/`, `.socket/`, `.windsurf/`, or `docs/open-collection-gap-analysis/`.
  Observed: the local binary post demo server exists at `examples/demo-api/server.js`; it runs with `node examples/demo-api/server.js` on `http://localhost:3456` and exposes `GET /health`, `POST /upload`, `POST /upload/image`, `POST /upload/pdf`, and `POST /upload/text`.
  Next: keep `examples/demo-api` packaged because it is useful sample content; protocol agents can reuse its local-server pattern for fixture-backed tests.
- 2026-06-14 22:42 NZT - Codex: Added demo-server fixture guidance before launching OC-010, OC-020, OC-030, and OC-040 in parallel.
  GitButler: supervisor branch `supervisor/demo-server-fixtures` created for this coordination update.
  Coverage: documentation and skill validation only; no runtime behavior changed.
  Changed: added `.agents/skills/missio-demo-server-fixtures/`; updated OC-010 through OC-040 task definitions, `AGENT_GOAL_PROMPTS.md`, and `README.md` so protocol/runtime agents must extend the local demo API and add user-verifiable demo requests.
  Verified: `python C:\Users\chris\.codex\skills\.system\skill-creator\scripts\quick_validate.py .agents\skills\missio-demo-server-fixtures` passed; `rg` confirmed the new skill is referenced by OC-010, OC-020, OC-030, OC-040, the goal prompts, and the wiki skill table.
  Next: launch OC-010, OC-020, OC-030, and OC-040 with `$missio-demo-server-fixtures` included in each goal prompt.
- 2026-06-14 23:33 NZT - Codex: Completed supervisor audit for OC-010 GraphQL, OC-020 WebSocket, OC-030 gRPC unary/protobuf, and OC-040 runtime scripting/testing.
  GitButler: `but status -fv` showed no unassigned changes before the audit; applied stacks included `feature/oc-010-graphql-support` (ra), `feature/oc-020-websocket-support` (we), `feature/oc-030-grpc-unary-protobuf` (rp), and `feature/oc-040-runtime-scripting-testing` (ru). After audit, owned changes are `package.json` language-model tool description cleanup and this progress report only.
  Coverage: inspected protocol dispatch, GraphQL adapter, WebSocket client, gRPC client, runtime service, editor/tool routing, demo server fixtures, and focused tests. Fixed stale package manifest text so Copilot tool metadata now says list/send support covers HTTP, GraphQL, WebSocket, and unary gRPC instead of only HTTP/GraphQL.
  Verified: `npm run compile` passed; `npx vitest run test/graphqlSupport.test.ts test/webSocketSupport.test.ts test/grpcSupport.test.ts test/runtimeExecutionService.test.ts test/responseProvider.test.ts test/openCollectionFoundation.test.ts test/schemaRoundTrip.test.ts test/validationService.test.ts test/sendRequestTool.test.ts` passed 9 files/61 tests; `npm test` passed 20 files/380 tests; `node scripts/validate-collection.js examples/demo-api` passed 32/32 files; `npm run build` passed; `npx @vscode/vsce package --out %TEMP%\missio-0.7.7-oc010-040-supervisor.vsix` passed; `code.cmd --install-extension %TEMP%\missio-0.7.7-oc010-040-supervisor.vsix --force` installed successfully; `code.cmd --list-extensions --show-versions` shows `missio.missio@0.7.7`.
  Demo smoke: hidden local `node examples/demo-api/server.js` and `node examples/demo-api/grpc-server.js` processes returned `health=ok`, GraphQL `data.health.status=ok`, runtime token `runtime-token-123`, WebSocket echo `supervisor-echo`, and gRPC unary `Hello Supervisor`.
  Observed: OC-040 runtime lifecycle is verified through HTTP and GraphQL-over-HTTP execution. WebSocket and gRPC requests currently use runtime variables/auth but do not execute runtime scripts/assertions/actions in the same lifecycle; treat this as a follow-up candidate if "runtime across supported protocol executors" is interpreted strictly. The OC-040 GitButler branch also contains several no-change retry commits that can be cleaned up before a polished PR.
  Next: commit this supervisor audit slice to a supervisor branch; then OC-050 and OC-070 can proceed on top of the verified OC-010 through OC-040 stack.
- 2026-06-14 23:42 NZT - Codex: Completed GitButler stack hygiene cleanup after the OC-010 through OC-040 audit.
  GitButler: moved `feature/oc-020-websocket-support` onto `feature/oc-010-graphql-support`, leaving the supervisor audit branch on top of the verified protocol stack. Removed no-change retry commits from `supervisor/oc-010-040-audit` and `feature/oc-040-runtime-scripting-testing` with `but uncommit <commit> -d`; final status before this ledger update had `zz` clean and OC-040 reduced to its single behavior-bearing commit.
  Coverage: history/stack cleanup only; no runtime behavior changed. Re-ran compile, focused protocol/runtime tests, full tests, demo collection validation, and production build after the restack and history cleanup.
  Verified: `npm run compile` passed; `npx vitest run test/graphqlSupport.test.ts test/webSocketSupport.test.ts test/grpcSupport.test.ts test/runtimeExecutionService.test.ts test/responseProvider.test.ts test/openCollectionFoundation.test.ts test/schemaRoundTrip.test.ts test/validationService.test.ts test/sendRequestTool.test.ts` passed 9 files/61 tests; `npm test` passed 20 files/380 tests; `node scripts/validate-collection.js examples/demo-api` passed 32/32 files; `npm run build` passed.
  Observed: the branch stack is cleaner for review, but ownership is still not perfectly atomic: some WebSocket implementation wiring lives in shared lower protocol/runtime commits rather than only in the OC-020 branch. Keeping that shared dependency shape is preferable to risky file/hunk history surgery at this point because the applied stack is verified and the OC-020 branch is now correctly dependent on the implementation stack.
  Next: proceed with OC-050/OC-070 on top of the cleaned stack; avoid opening OC-020 as an independent branch without its lower protocol/runtime dependencies.

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

- 2026-06-14 22:44 NZT - Codex: Claimed OC-010 and recorded the coverage plan before implementation.
  GitButler: feature/oc-010-graphql-support (gr); current status has no unassigned changes and completed OC-000/OC-060/supervisor branches applied as dependencies.
  Coverage: planned automated tests for GraphQL type/body helpers, validation schema selection, schema-native editor save and body variant preservation, executor integration with local fixture query/mutation/auth/params/variables, tree and CodeLens labels, command and Copilot/tool routing, demo collection validation, and shared HTTP regression coverage.
  Changed: docs/open-collection-gap-analysis/AGENT_PROGRESS.md.
  Verified: `but status -fv` read successfully; implementation tests not run yet.
  Next: inspect existing request editor, executor, validation, tree, CodeLens, Copilot tools, schema extensions, and demo API structure before implementation.
- 2026-06-14 23:17 NZT - Codex: Completed OC-010 GraphQL support with schema-native editing, execution, routing, fixtures, and automated coverage.
  GitButler: `feature/oc-010-graphql-support` (ra) committed as `a67a3ad` (`Add OC-010 GraphQL request support`) on top of `supervisor/demo-server-fixtures`; follow-up ledger commits record completion evidence, and shared runtime extension wiring commit `7a9dea5` currently sits on the same stack. `but status -fv` after implementation commit showed no OC-010-owned unassigned implementation changes.
  Coverage: implemented `test/graphqlSupport.test.ts` for GraphQL adapter/body variants, invalid variables, RequestExecutionService query/mutation execution against a local fixture, unresolved variables, CodeLens labels, Copilot list/send routing, and demo collection validation; extended schema round-trip/foundation/send-tool tests for GraphQL editor preservation and diagnostics.
  Changed: GraphQL demo requests under `examples/demo-api/GraphQL/`, `/graphql` demo server route, `src/services/graphqlSupport.ts`, GraphQL execution adaptation in `RequestExecutionService`, schema-native GraphQL request panel/editor merge support, tree/CodeLens/command/Copilot routing, and focused tests.
  Verified: targeted `npx vitest run test/graphqlSupport.test.ts test/schemaRoundTrip.test.ts test/validationService.test.ts test/openCollectionFoundation.test.ts test/unresolvedVars.test.ts test/sendRequestTool.test.ts` passed 51 tests; post-commit `npm test` passed 20 files/380 tests; `npm run compile` passed; `npm run build` passed; live smoke via hidden `node examples/demo-api/server.js` plus `POST http://127.0.0.1:3456/graphql` returned `data.health.status: ok`.
  Dependency/parallel notes: OC-030 committed shared package/types/unresolved-vars support separately as `0daa7be`; OC-040 runtime/response implementation is currently committed at `872660b` with follow-up no-change wiring commits above it; OC-020 WebSocket demo/test work is committed at `d599906`. OC-010 commit includes `src/services/runtimeExecutionService.ts` because concurrent runtime hooks are now part of the shared execution facade used by GraphQL. Final status after the ledger refresh had no unassigned changes.
  Next: OC-010 is done; preserve the remaining WebSocket/runtime changes for their owning branches.

### OC-020 WebSocket Support

- 2026-06-14 22:44 NZT - Codex: Claimed OC-020 and recorded the coverage plan before implementation.
  GitButler: feature/oc-020-websocket-support (we); current status shows an unrelated OC-010 ledger claim in unassigned changes plus completed OC-000/OC-060/supervisor branches applied as dependencies.
  Coverage: planned automated tests for WebSocket type guards, validation and round-trip preservation, schema-native editor save/render behavior, executor integration with a local `ws` fixture for text/JSON/auth/error/cancel/cleanup lifecycle, command/tree/Copilot routing, demo collection validation, and shared HTTP regressions.
  Changed: docs/open-collection-gap-analysis/AGENT_PROGRESS.md.
  Verified: `but status -fv` and `but diff` read successfully; implementation tests not run yet.
  Next: inspect existing request editor, executor, validation, tree, CodeLens, Copilot tools, schema extensions, and demo API structure before implementation.
- 2026-06-14 23:18 NZT - Codex: Completed OC-020 WebSocket support with schema-native editing, executor lifecycle coverage, local demo requests, and fixture-backed automated tests.
  GitButler: committed OC-020-owned demo requests and tests as `d599906` (`Add OC-020 WebSocket demo fixtures and tests`) on `feature/oc-020-websocket-support` (we). Shared implementation needed for the complete applied workspace landed in parallel applied commits: `a67a3ad` for protocol-aware editor/tooling/demo server routing, `7a9dea5` for extension wiring, `872660b` for `WebSocketClient`, and `0daa7be` for the shared `ws` package dependency.
  Coverage: `test/webSocketSupport.test.ts` covers text, JSON, binary, selected message variants, inherited collection/folder/request headers, bearer auth handshake, invalid URL diagnostics, server close, explicit disconnect cancellation, active socket cleanup, RequestExecutionService WebSocket dispatch/cancel, schema-native WebSocket editor merge/save behavior, unresolved variable scanning including inherited headers/auth, CodeLens/list/send Copilot routing, demo collection validation, and committed demo request smoke coverage.
  Changed: OC-020 branch owns `examples/demo-api/WebSocket/*.yml` and `test/webSocketSupport.test.ts`; applied shared branches own `src/services/webSocketClient.ts`, `RequestExecutionService` dispatch, request panel/editor/tooling, `examples/demo-api/server.js`, `examples/demo-api/opencollection.yml`, and `package.json`/`package-lock.json`.
  Verified: `npx vitest run test/webSocketSupport.test.ts` passed 13 tests; `npx vitest run test/webSocketSupport.test.ts test/openCollectionFoundation.test.ts test/schemaRoundTrip.test.ts test/sendRequestTool.test.ts test/graphqlSupport.test.ts test/grpcSupport.test.ts test/validationService.test.ts` passed 54 tests; `npm test` passed 20 files/380 tests; `npm run compile` passed; `node scripts/validate-collection.js examples/demo-api` passed 32/32 files; live hidden `node examples/demo-api/server.js` smoke for `/ws/echo`, `/ws/auth`, and `/ws/close` returned echo `hello demo`, auth `true`, and close code `4000`; `npm run build` passed.
  Next: OC-020 is done; no OC-020-owned changes remain uncommitted.

### OC-030 gRPC Support

- 2026-06-14 22:44 NZT - Codex: Claimed OC-030 and recorded the coverage plan before implementation.
  GitButler: feature/oc-030-grpc-unary-protobuf (rp); current status also contains a parallel unassigned OC-010 ledger claim in `docs/open-collection-gap-analysis/AGENT_PROGRESS.md`, which must be preserved and not folded into the OC-030 implementation commit unless GitButler requires a ledger dependency note.
  Coverage: planned automated tests for protobuf config editing/preservation, gRPC request validation, metadata defaults and precedence, proto import path loading, unary execution against local fixtures, variable interpolation in URL/metadata/message, missing proto and invalid method diagnostics, connection errors, unsupported streaming diagnostics, demo gRPC fixture smoke tests, demo collection validation, and shared HTTP/foundation regressions.
  Changed: docs/open-collection-gap-analysis/AGENT_PROGRESS.md.
  Verified: `but status -fv`, `but diff`, OC-030 task page, and demo server/collection review completed; implementation tests not run yet.
  Next: inspect current model, validation, editor, execution service, package dependencies, and test harness before adding gRPC/protobuf code.
- 2026-06-14 23:16 NZT - Codex: Completed OC-030 gRPC unary and protobuf support.
  GitButler: committed implementation as `02155e6` (`Add OC-030 gRPC unary protobuf support`) on `feature/oc-030-grpc-unary-protobuf` (rp). Current workspace still contains sibling OC-020/OC-040 changes and the shared ledger hunk, so this final ledger update is documentation-only and must preserve those parallel notes.
  Coverage: implemented protobuf collection config editing and round-trip preservation, schema-native gRPC request validation, metadata defaults/precedence, unary execution through `GrpcClient`, request/collection/folder auth metadata merging, variable interpolation, cancellation cleanup, missing proto and invalid method diagnostics, explicit streaming unsupported diagnostics, local demo gRPC server/proto fixtures, demo request files, demo collection validation, and fixture smoke coverage.
  Changed: `package.json`, `package-lock.json`, `src/models/types.ts`, `src/models/schemaRoundTrip.ts`, `src/panels/collectionPanel.ts`, `src/webview/collectionPanel.ts`, `src/services/grpcClient.ts`, `src/services/unresolvedVars.ts`, `scripts/validate-collection.js`, `examples/demo-api/grpc-server.js`, `examples/demo-api/proto/**`, `examples/demo-api/gRPC/**`, `examples/demo-api/opencollection.yml`, and `test/grpcSupport.test.ts`.
  Verified: `npx vitest run test/grpcSupport.test.ts test/schemaRoundTrip.test.ts test/validationService.test.ts` passed 16 tests; `npx vitest run test/openCollectionFoundation.test.ts test/runtimeExecutionService.test.ts test/grpcSupport.test.ts test/sendRequestTool.test.ts` passed 30 tests; `node scripts/validate-collection.js examples/demo-api` passed 32 files; `npm run compile` passed; `npm test` passed 20 files and 380 tests; `npm run build` passed; an actual `node examples/demo-api/grpc-server.js` smoke call to `missio.demo.DemoService/EchoUnary` returned `ok: true`.
  Next: OC-030 complete; streaming requests intentionally return `MISSIO_GRPC_STREAMING_UNSUPPORTED` until a future streaming track adds bidirectional/session support.

### OC-040 Scripts, Tests, Assertions, Actions

- 2026-06-14 22:45 NZT - Codex: Claimed OC-040 and recorded the coverage plan before implementation.
  GitButler: feature/oc-040-runtime-scripting-testing (ru); pre-existing OC-010 ledger hunks were staged to feature/oc-010-graphql-support (ra) before this claim so the OC-040 branch can keep its own progress notes separate.
  Coverage: planned runtime service/unit tests for lifecycle order, context shape, sandbox boundaries, tests/logs, assertions, JSON selector `set-variable` actions, and diagnostics; HTTP executor/command/tool tests for request mutation and surfaced runtime output; response UI rendering tests for test/assertion/action results; local fixture-backed demo route/request tests; demo collection validation; full compile/test/build regression coverage.
  Changed: docs/open-collection-gap-analysis/AGENT_PROGRESS.md.
  Verified: `but status -fv` and `but diff` read successfully; implementation tests not run yet.
  Next: inspect runtime-adjacent executor, model, tool, panel, and schema code before adding OC-040 implementation.
- 2026-06-14 23:21 NZT - Codex: Completed OC-040 runtime scripts, tests, assertions, actions, UI/tool output, and demo fixtures with automated verification passing.
  GitButler: primary OC-040 implementation is committed as `Add OC-040 runtime scripting support` on `feature/oc-040-runtime-scripting-testing` (ru). Shared runtime wiring was coalesced into applied dependency commits `Add OC-010 GraphQL request support` (runtime execution facade, request panel/runtime tab, Copilot tool output, demo server runtime route hunks), `Wire shared runtime execution services` (extension service wiring), and `Add OC-030 gRPC unary protobuf support` (runtime result types and unresolved runtime variables). Short hashes may rewrite while GitButler restacks the parallel OpenCollection branches; use `but status -fv` for the current IDs. No-change retry commits from dependency-lock attempts were removed during the 23:42 supervisor stack hygiene pass.
  Coverage: implemented sandboxed lifecycle execution with collection/folder/request before scripts, before/after actions, after-response scripts, assertions, tests, console/error diagnostics, JSON selector `set-variable` actions, runtime variable mutation, no-op HTTP bypass, response document output, Runtime webview tab output, Copilot send-request runtime results, local demo runtime routes, and user-verifiable runtime demo requests.
  Changed: `src/services/runtimeExecutionService.ts`, `src/services/requestExecutionService.ts`, `src/extension.ts`, `src/models/types.ts`, `src/services/unresolvedVars.ts`, `src/providers/responseProvider.ts`, `src/copilot/tools/sendRequestTool.ts`, `src/panels/requestPanel.ts`, `src/webview/requestPanel.ts`, `src/webview/requestPanel.css`, `src/webview/response.ts`, `examples/demo-api/server.js`, `examples/demo-api/Runtime/**`, `test/runtimeExecutionService.test.ts`, `test/sendRequestTool.test.ts`, and `test/responseProvider.test.ts`.
  Verified: `npx vitest run test/openCollectionFoundation.test.ts test/runtimeExecutionService.test.ts test/sendRequestTool.test.ts test/responseProvider.test.ts` passed 4 files and 24 tests; `npm run compile` passed; `npm test` passed 20 files and 380 tests; `npm run build` passed; `node scripts/validate-collection.js examples/demo-api` passed 32/32 files.
  Demo smoke: `node examples/demo-api/server.js` on `http://127.0.0.1:3456` verified `POST /runtime/echo`, `POST /runtime/token`, and `GET /runtime/assert-fail`, returning `{"echo":"smoke","scriptedHeader":"smoke-script","requestToken":"smoke-token","token":"runtime-token-123","owner":"oc-040","tokenScriptedHeader":"smoke-script","failureActual":"fail"}`.
  Next: OC-040 complete; no-change retry commits have been removed.

### OC-050 Auth, Proxy, mTLS, Transport Completion

- 2026-06-14 23:48 NZT - Codex: Claimed OC-050 and recorded the coverage plan before implementation.
  GitButler: feature/oc-050-auth-transport (ut); `but status -fv` showed no unassigned changes at claim time, with completed OC-000 through OC-060 protocol/runtime stacks applied.
  Coverage: planned fixture-backed executor tests for API-key query placement, OAuth2 token placement/additional params/PKCE diagnostics, redirects, proxy auth/bypass/failure, mTLS success/failure, URL encoding, unsupported schema auth diagnostics, demo collection validation, compile, full test, and build.
  Changed: docs/open-collection-gap-analysis/AGENT_PROGRESS.md only.
  Verified: `but status -fv`, OC-050 task page, demo server, and demo collection review completed; implementation tests not run yet.
  Next: inspect auth/transport model and executor code, add failing coverage, then implement schema-native auth and transport behavior with local fixtures.

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

### OC-070 Request Creation, Import/Export, And Copilot Surface Polish

No updates yet.

### OC-080 Runtime Lifecycle For Non-HTTP Protocols

No updates yet.

### OC-090 gRPC Streaming

- 2026-06-14 23:55 NZT - Codex: Claimed OC-090 and recorded the coverage plan before implementation.
  GitButler: feature/oc-090-grpc-streaming (am); `but status -fv` shows parallel unassigned OC-050-auth-looking edits in `src/models/types.ts`, `src/services/oauth2Service.ts`, and `src/services/oauth2TokenHelper.ts`, which must be preserved unless a specific dependency emerges.
  Coverage: planned automated tests for schema-native client-streaming, server-streaming, and bidirectional-streaming message sequences; method discovery and validation; metadata/auth/default inheritance; streaming execution against local gRPC fixtures; cancellation, timeout, cleanup, and partial-error diagnostics; response UI/provider and Copilot tool streaming summaries; demo request validation/smoke coverage; unary gRPC and shared protocol regressions.
  Changed: `docs/open-collection-gap-analysis/AGENT_PROGRESS.md`.
  Verified: `but status -fv`, OC-090 task page, OC-030 task page, demo server, and demo collection review completed; implementation tests not run yet.
  Next: inspect gRPC client, request execution, models, panel/tool output, validation, demo proto/server, and current tests before adding streaming fixtures and implementation.

### OC-100 Request Type UX

- 2026-06-15 00:06 NZT - Codex: Claimed OC-100 and recorded the product benchmark and coverage plan before implementation.
  GitButler: `feature/oc-100-request-type-ux` (j0), stacked on `supervisor/add-request-type-ux-task` (g0); `but status -fv` shows parallel unassigned OC-050/OC-090 changes in auth/transport, gRPC streaming, schema, and protocol client files that must be preserved unless a concrete dependency emerges.
  Benchmark: Bruno creates requests from collection menus and inline tab controls with explicit request type choices; its inline flow opens unsaved requests and supports HTTP, GraphQL, gRPC, and WebSocket type selection (https://docs.usebruno.com/get-started/bruno-basics/create-a-request). Postman starts new requests by choosing a protocol, has dedicated GraphQL/WebSocket/gRPC clients, and documents that a saved GraphQL request's protocol cannot be changed, so Missio should emphasize creation-time protocol choice and visible saved-request identity rather than a saved-request switcher (https://learning.postman.com/docs/use/send-requests/create-requests/request-basics, https://learning.postman.com/docs/use/send-requests/protocols/graphql/graphql-client-interface).
  Coverage: planned creation/template, validation, round-trip, editor/webview type identity, and shared protocol regression tests for HTTP, GraphQL, WebSocket, and gRPC.
  Changed: `docs/open-collection-gap-analysis/AGENT_PROGRESS.md`.
  Verified: `but status -fv`, OC-100 task page review, and official Bruno/Postman documentation benchmark completed; implementation tests not run yet.
  Next: audit request creation, menu contributions, request panel visual editor, schema helpers, and protocol regression tests before adding the OC-100 implementation.
- 2026-06-15 00:07 NZT - Codex: Updated OC-100 scope after user direction: do not implement a request type switcher when benchmarked tools do not provide one.
  GitButler: `feature/oc-100-request-type-ux` (j0); same parallel unassigned OC-050/OC-090 changes are preserved.
  Coverage: revised to creation templates, protocol-aware validation/round-trip, read-only editor type identity, save payload, and shared protocol regression tests; removed conversion helper and switch-confirmation coverage from OC-100.
  Changed: `docs/open-collection-gap-analysis/AGENT_PROGRESS.md` and OC-100 task scope update pending/owned by this branch.
  Verified: benchmark interpretation rechecked against Bruno creation docs and Postman protocol lock docs; implementation tests not run yet.
  Next: update the OC-100 task page to match the narrowed scope, then audit creation/editor surfaces.
- 2026-06-15 00:15 NZT - Codex: Completed OC-100 request type creation UX and read-only type identity without a saved-request switcher.
  GitButler: `feature/oc-100-request-type-ux` was stacked on `supervisor/add-request-type-ux-task` and committed as `5cb05a3` (`Add OC-100 request type creation UX`). This final ledger update is the only OC-100-owned uncommitted change before the ledger commit.
  Coverage: implemented `src/services/requestTemplates.ts` for schema-valid HTTP, GraphQL, WebSocket, and gRPC starters; updated `missio.newRequest` to pick a request type before writing YAML; made the request editor show a persistent read-only protocol chip and detect gRPC instead of falling through to HTTP; added `test/requestTypeUx.test.ts` for starter validation, command creation, round-trip safety, stale-root prevention, gRPC guard behavior, and no switcher shell regression.
  Changed: `docs/open-collection-gap-analysis/AGENT_GOAL_PROMPTS.md`, `docs/open-collection-gap-analysis/tasks/10-request-type-ux.md`, `src/commands/requestCommands.ts`, `src/panels/requestPanel.ts`, `src/services/requestTemplates.ts`, `src/webview/requestPanel.css`, `src/webview/requestPanel.ts`, `test/mocks/vscode.ts`, and `test/requestTypeUx.test.ts`.
  Verified: `npx vitest run test/requestTypeUx.test.ts test/schemaRoundTrip.test.ts test/openCollectionFoundation.test.ts test/validationService.test.ts` passed 4 files/25 tests; `npx vitest run test/requestTypeUx.test.ts test/graphqlSupport.test.ts test/webSocketSupport.test.ts test/grpcSupport.test.ts test/sendRequestTool.test.ts test/schemaRoundTrip.test.ts test/openCollectionFoundation.test.ts test/validationService.test.ts` passed 8 files/68 tests; `npm run compile` passed; `npm test` passed 21 files/405 tests; `node scripts/validate-collection.js examples/demo-api` passed 42/42 files; `npm run build` passed.
  Parallel/unrelated after implementation commit: `sv`, `nk`, `qz`, `wuq`, `ln`, `tp`, `wo`, `pts`, `uo`, `wup`, `pq`, `yv`, `qs`, `nv`, `sz`, `rut`, `xq`, `yn`, `nq`, `vw`, `yq`, `vk`, `ku`, `unq`, `vs`, `ly`, `sl`, `tus`, and `np` are preserved for OC-050/OC-090 or other parallel work and were not committed to OC-100.
  Next: commit this ledger-only update to `feature/oc-100-request-type-ux`; OC-070 can reuse `requestTemplates.ts` instead of recreating protocol starter logic.
