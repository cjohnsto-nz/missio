---
name: missio-runtime-implementer
description: Implement Missio OpenCollection runtime behavior including scripts, tests, assertions, actions, auth methods, OAuth2 completeness, proxy support, client certificates, redirects, and transport settings. Use when working on runtime lifecycle or transport/auth execution gaps.
---

# Missio Runtime Implementer

## First Steps

1. Run `but status -fv`; use GitButler for any version-control writes.
2. Read `docs/open-collection-gap-analysis/AGENT_PROGRESS.md`.
3. Claim OC-040 for scripts/tests/assertions/actions or OC-050 for auth/transport and record the GitButler branch/stack.
4. Read the matching task page before editing:
   - `tasks/04-runtime-scripting-testing.md`
   - `tasks/05-auth-proxy-mtls.md`
5. Record a coverage plan in `AGENT_PROGRESS.md` before editing implementation code.

## Runtime Rules

- Treat collection scripts as untrusted content.
- Do not expose filesystem, process, shell, or arbitrary network access to scripts without an explicit design decision.
- Keep lifecycle execution protocol-neutral: HTTP, GraphQL, WebSocket, and gRPC should eventually share the same runtime context shape.
- Make unsupported schema auth fail loudly. Silent auth no-ops are bugs.

## Transport Rules

- Preserve existing HTTP behavior unless the task explicitly fixes a bug.
- Apply variables, secrets, defaults, and auth before execution and dry-run/export.
- Add local fixture servers for auth, redirects, proxy, and mTLS tests.
- Keep Missio extensions such as CLI auth documented as extensions, not upstream OpenCollection fields.
- Commit only runtime/transport changes with `but commit ... --changes <ids>`; do not use raw Git write commands.
- Before marking a task `Review Ready` or `Done`, run `but status -fv`, classify owned vs parallel change IDs, commit only the runtime/transport slice to the recorded branch, and log any remaining unrelated IDs.

## Required Verification

Run complete automated coverage for the runtime or transport slice:

- Unit tests for lifecycle order, context shape, assertions, actions, variable mutation, and diagnostics.
- Security and negative tests for script sandbox boundaries, unsupported auth, invalid secrets, redirect policy, proxy failure, and mTLS failures where relevant.
- Fixture-backed executor tests for auth, redirects, proxy, mTLS, and runtime phases; use local servers only.
- Regression tests for existing HTTP execution, variables, auth, response rendering, and export/dry-run behavior touched by shared code.

Update `AGENT_PROGRESS.md` with exact commands and results. Record skipped security-sensitive tests only with a reason, manual verification, and follow-up work.
Do not mark runtime/transport work `Done` while the claimed changes are still only unassigned unless the ledger records a concrete GitButler blocker and next action.
