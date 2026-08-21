# Missio OpenCollection Gap Implementation Wiki

This wiki breaks the OpenCollection feature gap assessment into implementation tracks that parallel AI agents can claim, execute, and report against.

## Start Here

1. Read [AGENT_PROGRESS.md](AGENT_PROGRESS.md).
2. Run `but status -fv` and read the current GitButler workspace state.
3. Claim one unowned task by editing the owner and status fields in the central table.
4. Create or identify the GitButler branch/stack for the task.
5. Read the matching task page under [tasks/](tasks/).
6. Record a test coverage plan in the central ledger before editing implementation code.
7. Keep the progress ledger current before and after code changes.
8. Link PRs, branches, commits, test runs, and blockers in the ledger.

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
| OC-070 | Agent/API Surface | [07-import-export-copilot.md](tasks/07-import-export-copilot.md) | Protocol-aware imports, exports, tree nodes, CodeLens, and Copilot tools. |

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

## Repo Evidence

The current codebase is strongly HTTP-centered:

| Evidence | Location |
| --- | --- |
| `Item` is only `HttpRequest | Folder`. | [src/models/types.ts](../../src/models/types.ts) |
| The executor accepts `HttpRequest` and uses Node `http`/`https`. | [src/services/httpClient.ts](../../src/services/httpClient.ts) |
| Collection validation only compiles `HttpRequest` for request files. | [src/services/validationService.ts](../../src/services/validationService.ts) |
| CodeLens only looks for `http:` and `method:`. | [src/providers/codeLensProvider.ts](../../src/providers/codeLensProvider.ts) |
| Send command rejects files without `request.http.method/url`. | [src/commands/requestCommands.ts](../../src/commands/requestCommands.ts) |
| Runtime dependencies do not include protocol/runtime libraries. | [package.json](../../package.json) |

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
