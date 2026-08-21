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
| OC-000 | Foundation and protocol dispatch | Unclaimed | - | - | - | - | - | Claim first; many other tracks depend on it. |
| OC-010 | GraphQL support | Unclaimed | - | - | - | - | - | Start after or alongside OC-000 interface design. |
| OC-020 | WebSocket support | Unclaimed | - | - | - | - | - | Start after OC-000 dispatch shape is stable. |
| OC-030 | gRPC support | Unclaimed | - | - | - | - | - | Start after OC-000 and dependency choice. |
| OC-040 | Scripts, tests, assertions, actions | Unclaimed | - | - | - | - | - | Can start with runtime design spike before OC-000 lands. |
| OC-050 | Auth, proxy, mTLS, transport completion | Unclaimed | - | - | - | - | - | Can start with HTTP-only fixes; proxy/mTLS need executor refactor. |
| OC-060 | Schema round-trip and validation | Unclaimed | - | - | - | - | - | Can start now with tests and validation schema selection. |
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

## Task Logs

### OC-000 Foundation and Protocol Dispatch

No updates yet.

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

No updates yet.

### OC-070 Imports, Exports, Tree, CodeLens, Copilot Tools

No updates yet.
