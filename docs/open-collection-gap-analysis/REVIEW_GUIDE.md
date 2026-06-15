# OpenCollection PR Review Guide

This guide is for reviewers staring at the OpenCollection stack. The stack is intentionally split into small, reviewable branches, but there are 36 live PRs. Review and merge by the `[NN/36]` prefix in each PR title, not by PR number alone.

The old all-in-one release PR `#55` is closed. Ignore it for this review.

## Reviewer Map

Start with these documents before reviewing any PR:

| Document | Use |
| --- | --- |
| [README.md](README.md) | Task hierarchy, project skills, evidence surfaces, and definition of done. |
| [AGENT_PROGRESS.md](AGENT_PROGRESS.md) | Central ledger with task status, branch names, commits, coverage plan, and verification evidence. |
| [AGENT_GOAL_PROMPTS.md](AGENT_GOAL_PROMPTS.md) | Original goal prompts that launched each implementation agent. |
| [tasks/](tasks/) | Task-level requirements, scope boundaries, coverage expectations, and known dependencies. |
| [.agents/skills](../../.agents/skills) | Agent instructions used by implementers. Useful context for AI reviewers. |
| [examples/demo-api](../../examples/demo-api) | Local demo collection and fixture servers used by protocol/runtime tests. |

To associate a PR with its task, use the PR title and branch name:

| Pattern | Meaning |
| --- | --- |
| `feature/oc-XXX-*` | Implementation branch for task `OC-XXX`; read the matching task file and ledger row. |
| `supervisor/add-*-task` | Planning/wiki branch that introduced or refined task instructions. |
| `supervisor/*-audit` or `supervisor/final-*` | Supervisor review, build, install, or acceptance evidence. |
| `release/0.8.0` | Version bump and package/release preparation. |
| `supervisor/build-install-script` | Local build/install automation support. |
| `supervisor/pdf-asset-normalization` | Binary/PDF asset churn containment. |
| `feature/runtime-script-variable-evaluation` | Runtime variable regression fix associated with OC-080/OC-150. |

Useful local lookup commands:

```powershell
gh pr view <number> --json number,title,headRefName,baseRefName,url,statusCheckRollup
gh pr diff <number> --name-only
gh pr diff <number>
rg -n "OC-160|feature/oc-160-grpc-demo-server-reliability" docs/open-collection-gap-analysis
```

## Review Rules

1. Review each PR against its own base branch, not against `main`, until the merge process retargets it.
2. Do not ask an AI reviewer to review `main..head` for a child PR. That will include parent-stack changes and produce noisy findings.
3. Check the matching task page and `AGENT_PROGRESS.md` row before deciding that missing behavior is a bug. Some behavior was intentionally scoped into another PR.
4. Treat missing automated coverage as a real finding. The task docs and ledger specify the expected test shape.
5. Watch for cross-protocol regressions. Most risk is in shared request editor, runtime execution, validation, schema round-trip, and Copilot/tool routing code.
6. Confirm user-verifiable demo requests exist when a protocol/runtime feature adds execution behavior.
7. Keep review comments scoped to the PR being reviewed. If a finding belongs to a parent or child PR, comment on that PR instead.

## Suggested AI Reviewer Prompt

Use this prompt with reviewer agents. Replace the placeholders.

```text
You are reviewing Missio PR #<number>: <title>.

Read these first:
- docs/open-collection-gap-analysis/REVIEW_GUIDE.md
- docs/open-collection-gap-analysis/README.md
- docs/open-collection-gap-analysis/AGENT_PROGRESS.md row and task log for <OC-ID or support branch>
- docs/open-collection-gap-analysis/tasks/<task-file> when this PR maps to an OC task

Review only the PR diff against its GitHub base branch. Do not review the whole cumulative stack against main.

Focus on bugs, behavioral regressions, schema/round-trip loss, protocol/runtime edge cases, missing fixture support, missing tests, packaging issues, and GitButler stack hazards. Lead with findings ordered by severity and include file/line references. If there are no blocking issues, say that clearly and list residual risk or test gaps.
```

## Review Order

Review in title-prefix order. PR numbers are not strictly sequential because later support branches were inserted into the stack.

| Order | PR | Branch | Base Branch | Scope | Start With |
| --- | --- | --- | --- | --- | --- |
| 01 | [#35](https://github.com/cjohnsto-nz/missio/pull/35) | `docs/open-collection-agent-plan` | `main` | Agent plan, wiki, skills, initial task docs | [README.md](README.md), [AGENT_PROGRESS.md](AGENT_PROGRESS.md) |
| 02 | [#36](https://github.com/cjohnsto-nz/missio/pull/36) | `feature/oc-000-foundation-dispatch` | `docs/open-collection-agent-plan` | OC-000 foundation and protocol dispatch | [00-foundation-and-dispatch.md](tasks/00-foundation-and-dispatch.md) |
| 03 | [#37](https://github.com/cjohnsto-nz/missio/pull/37) | `feature/oc-030-grpc-unary-protobuf` | `feature/oc-000-foundation-dispatch` | OC-030 gRPC unary/protobuf | [03-grpc.md](tasks/03-grpc.md) |
| 04 | [#38](https://github.com/cjohnsto-nz/missio/pull/38) | `feature/oc-090-grpc-streaming` | `feature/oc-030-grpc-unary-protobuf` | OC-090 gRPC streaming | [09-grpc-streaming.md](tasks/09-grpc-streaming.md) |
| 05 | [#39](https://github.com/cjohnsto-nz/missio/pull/39) | `feature/oc-040-runtime-scripting-testing` | `feature/oc-090-grpc-streaming` | OC-040 runtime scripts/tests/assertions/actions | [04-runtime-scripting-testing.md](tasks/04-runtime-scripting-testing.md) |
| 06 | [#40](https://github.com/cjohnsto-nz/missio/pull/40) | `feature/oc-060-schema-roundtrip-validation` | `feature/oc-040-runtime-scripting-testing` | OC-060 schema round-trip and validation | [06-schema-roundtrip-validation.md](tasks/06-schema-roundtrip-validation.md) |
| 07 | [#41](https://github.com/cjohnsto-nz/missio/pull/41) | `supervisor/oc-000-oc-060-audit` | `feature/oc-060-schema-roundtrip-validation` | Supervisor audit for OC-000 and OC-060 | [AGENT_PROGRESS.md](AGENT_PROGRESS.md) |
| 08 | [#42](https://github.com/cjohnsto-nz/missio/pull/42) | `supervisor/demo-server-fixtures` | `supervisor/oc-000-oc-060-audit` | Demo server fixture skill and task refinements | [missio-demo-server-fixtures](../../.agents/skills/missio-demo-server-fixtures/SKILL.md) |
| 09 | [#43](https://github.com/cjohnsto-nz/missio/pull/43) | `feature/oc-010-graphql-support` | `supervisor/demo-server-fixtures` | OC-010 GraphQL support | [01-graphql.md](tasks/01-graphql.md) |
| 10 | [#44](https://github.com/cjohnsto-nz/missio/pull/44) | `feature/oc-020-websocket-support` | `feature/oc-010-graphql-support` | OC-020 WebSocket support | [02-websocket.md](tasks/02-websocket.md) |
| 11 | [#45](https://github.com/cjohnsto-nz/missio/pull/45) | `supervisor/oc-010-040-audit` | `feature/oc-020-websocket-support` | Supervisor audit for OC-010 through OC-040 | [AGENT_PROGRESS.md](AGENT_PROGRESS.md) |
| 12 | [#46](https://github.com/cjohnsto-nz/missio/pull/46) | `supervisor/add-oc080-oc090-tasks` | `supervisor/oc-010-040-audit` | Adds residual runtime/gRPC streaming task tracks | [08-runtime-non-http-protocols.md](tasks/08-runtime-non-http-protocols.md), [09-grpc-streaming.md](tasks/09-grpc-streaming.md) |
| 13 | [#47](https://github.com/cjohnsto-nz/missio/pull/47) | `supervisor/add-request-type-ux-task` | `supervisor/add-oc080-oc090-tasks` | Adds OC-100 request type UX task | [10-request-type-ux.md](tasks/10-request-type-ux.md) |
| 14 | [#48](https://github.com/cjohnsto-nz/missio/pull/48) | `feature/oc-100-request-type-ux` | `supervisor/add-request-type-ux-task` | OC-100 request type UX | [10-request-type-ux.md](tasks/10-request-type-ux.md) |
| 15 | [#49](https://github.com/cjohnsto-nz/missio/pull/49) | `feature/oc-050-auth-transport` | `feature/oc-100-request-type-ux` | OC-050 auth, proxy, mTLS, redirects, transport | [05-auth-proxy-mtls.md](tasks/05-auth-proxy-mtls.md) |
| 16 | [#50](https://github.com/cjohnsto-nz/missio/pull/50) | `supervisor/oc-050-090-100-audit` | `feature/oc-050-auth-transport` | Supervisor audit for OC-050, OC-090, OC-100 | [AGENT_PROGRESS.md](AGENT_PROGRESS.md) |
| 17 | [#63](https://github.com/cjohnsto-nz/missio/pull/63) | `supervisor/build-install-script` | `supervisor/oc-050-090-100-audit` | Local build and install script | [scripts/build-and-install.ps1](../../scripts/build-and-install.ps1) |
| 18 | [#51](https://github.com/cjohnsto-nz/missio/pull/51) | `supervisor/add-runtime-authoring-ux-task` | `supervisor/build-install-script` | OC-080 lifecycle and OC-110 task setup | [08-runtime-non-http-protocols.md](tasks/08-runtime-non-http-protocols.md), [11-runtime-authoring-ux.md](tasks/11-runtime-authoring-ux.md) |
| 19 | [#52](https://github.com/cjohnsto-nz/missio/pull/52) | `feature/oc-110-runtime-authoring-ux` | `supervisor/add-runtime-authoring-ux-task` | OC-110 runtime authoring UX | [11-runtime-authoring-ux.md](tasks/11-runtime-authoring-ux.md) |
| 20 | [#53](https://github.com/cjohnsto-nz/missio/pull/53) | `supervisor/final-opencollection-review` | `feature/oc-110-runtime-authoring-ux` | Final OpenCollection supervisor acceptance | [AGENT_PROGRESS.md](AGENT_PROGRESS.md) |
| 21 | [#56](https://github.com/cjohnsto-nz/missio/pull/56) | `feature/oc-070-surface-polish` | `supervisor/final-opencollection-review` | OC-070 surface polish | [07-import-export-copilot.md](tasks/07-import-export-copilot.md) |
| 22 | [#54](https://github.com/cjohnsto-nz/missio/pull/54) | `release/0.8.0` | `feature/oc-070-surface-polish` | Version bump and PDF.js packaging | [README.md](README.md), [package.json](../../package.json) |
| 23 | [#64](https://github.com/cjohnsto-nz/missio/pull/64) | `supervisor/pdf-asset-normalization` | `release/0.8.0` | Stabilize PDF asset line endings | [.gitattributes](../../.gitattributes) |
| 24 | [#57](https://github.com/cjohnsto-nz/missio/pull/57) | `supervisor/add-preview-zoom-rotate-task` | `supervisor/pdf-asset-normalization` | Adds OC-120 preview media controls task | [12-preview-media-controls.md](tasks/12-preview-media-controls.md) |
| 25 | [#62](https://github.com/cjohnsto-nz/missio/pull/62) | `supervisor/add-protocol-layout-stability-task` | `supervisor/add-preview-zoom-rotate-task` | Adds OC-130 protocol layout stability task | [13-protocol-layout-stability.md](tasks/13-protocol-layout-stability.md) |
| 26 | [#58](https://github.com/cjohnsto-nz/missio/pull/58) | `feature/oc-120-preview-media-controls` | `supervisor/add-protocol-layout-stability-task` | OC-120 preview media controls | [12-preview-media-controls.md](tasks/12-preview-media-controls.md) |
| 27 | [#59](https://github.com/cjohnsto-nz/missio/pull/59) | `feature/oc-130-protocol-layout-stability` | `feature/oc-120-preview-media-controls` | OC-130 protocol first paint stability | [13-protocol-layout-stability.md](tasks/13-protocol-layout-stability.md) |
| 28 | [#60](https://github.com/cjohnsto-nz/missio/pull/60) | `supervisor/add-websocket-lifecycle-task` | `feature/oc-130-protocol-layout-stability` | Adds OC-140 WebSocket lifecycle task | [14-websocket-lifecycle-ux.md](tasks/14-websocket-lifecycle-ux.md) |
| 29 | [#61](https://github.com/cjohnsto-nz/missio/pull/61) | `feature/oc-140-websocket-lifecycle-ux` | `supervisor/add-websocket-lifecycle-task` | OC-140 first-class WebSocket lifecycle UX | [14-websocket-lifecycle-ux.md](tasks/14-websocket-lifecycle-ux.md) |
| 30 | [#65](https://github.com/cjohnsto-nz/missio/pull/65) | `feature/runtime-script-variable-evaluation` | `feature/oc-140-websocket-lifecycle-ux` | Runtime script variable evaluation follow-up | [08-runtime-non-http-protocols.md](tasks/08-runtime-non-http-protocols.md) |
| 31 | [#66](https://github.com/cjohnsto-nz/missio/pull/66) | `supervisor/add-runtime-assertion-variable-task` | `feature/runtime-script-variable-evaluation` | Adds OC-150 assertion variable task | [15-runtime-assertion-variables.md](tasks/15-runtime-assertion-variables.md) |
| 32 | [#67](https://github.com/cjohnsto-nz/missio/pull/67) | `feature/oc-150-runtime-assertion-variables` | `supervisor/add-runtime-assertion-variable-task` | OC-150 assertion variables and WebSocket results UX | [15-runtime-assertion-variables.md](tasks/15-runtime-assertion-variables.md) |
| 33 | [#68](https://github.com/cjohnsto-nz/missio/pull/68) | `supervisor/add-grpc-demo-server-reliability-task` | `feature/oc-150-runtime-assertion-variables` | Adds OC-160 gRPC demo reliability task | [16-grpc-demo-server-reliability.md](tasks/16-grpc-demo-server-reliability.md) |
| 34 | [#69](https://github.com/cjohnsto-nz/missio/pull/69) | `supervisor/add-request-action-first-click-task` | `supervisor/add-grpc-demo-server-reliability-task` | Adds OC-170 first-click action task | [17-request-action-first-click.md](tasks/17-request-action-first-click.md) |
| 35 | [#70](https://github.com/cjohnsto-nz/missio/pull/70) | `feature/oc-160-grpc-demo-server-reliability` | `supervisor/add-request-action-first-click-task` | OC-160 gRPC demo server reliability | [16-grpc-demo-server-reliability.md](tasks/16-grpc-demo-server-reliability.md) |
| 36 | [#71](https://github.com/cjohnsto-nz/missio/pull/71) | `feature/oc-170-request-action-first-click` | `feature/oc-160-grpc-demo-server-reliability` | OC-170 request action first-click reliability | [17-request-action-first-click.md](tasks/17-request-action-first-click.md) |

## Review Batches

If reviewers want to divide labor, use these batches. They preserve dependencies while keeping related concepts together.

| Batch | Orders | Main Risk |
| --- | --- | --- |
| A | 01-08 | Planning, foundation dispatch, early gRPC/runtime/schema, fixture instructions. |
| B | 09-16 | GraphQL, WebSocket, request type UX, auth/transport, and first supervisor audit pass. |
| C | 17-23 | Build/install automation, runtime lifecycle/authoring, surface polish, release packaging, PDF asset stability. |
| D | 24-29 | Preview controls, layout stability, and first-class WebSocket lifecycle UX. |
| E | 30-36 | Runtime variable/assertion follow-ups, gRPC demo reliability, and first-click action reliability. |

## Merge Order

Merge in ascending title-prefix order:

```text
01 #35
02 #36
03 #37
04 #38
05 #39
06 #40
07 #41
08 #42
09 #43
10 #44
11 #45
12 #46
13 #47
14 #48
15 #49
16 #50
17 #63
18 #51
19 #52
20 #53
21 #56
22 #54
23 #64
24 #57
25 #62
26 #58
27 #59
28 #60
29 #61
30 #65
31 #66
32 #67
33 #68
34 #69
35 #70
36 #71
```

### Landing Procedure

These are stacked PRs. Only the first PR currently targets `main`; most child PRs target the previous stack branch. Do not press the GitHub merge button on a child PR while its base is still another feature branch.

Recommended sequence:

1. Review and approve PRs in `[NN/36]` order.
2. Merge `#35` into `main` first.
3. For the next PR, retarget its base to `main` after the previous PR has landed.
4. Wait for required checks to rerun if GitHub requests it.
5. Confirm the diff is only that PR's intended delta.
6. Merge using a merge commit.
7. Repeat until `#71` is merged.
8. Delete stack branches only after their child PR has been retargeted or after the whole stack is landed.

CLI sketch:

```powershell
# Example after #35 is merged.
gh pr edit 36 --base main
gh pr checks 36 --watch
gh pr diff 36 --name-only
gh pr merge 36 --merge
```

Use merge commits for this stack. Do not squash-merge unless you are prepared to restack every remaining child branch afterward. Squash merging changes commit identity and can make later PRs show already-reviewed parent changes again.

If a PR is accidentally squash-merged or merged into its parent branch instead of `main`, stop and restack/retarget before continuing. Do not keep landing the rest of the stack in a confused state.

## Expected Verification

The top of the stack was already verified as an integrated whole, but reviewers should still look for missing per-PR evidence.

Baseline commands used for final supervisor verification:

```powershell
npm run compile
node scripts\validate-collection.js examples\demo-api
npm test
npm run build
npm run install:local
```

Task-specific evidence is in `AGENT_PROGRESS.md`. If an AI reviewer asks for more tests, compare that request against the task's coverage plan first. Extra tests are valuable when they expose a real untested risk; they are noise when they duplicate already-recorded coverage from a parent or child PR.

## High-Risk Areas

Ask reviewers to be especially strict around these shared surfaces:

| Area | Files |
| --- | --- |
| Request editor hydration and first paint | [src/panels/requestPanel.ts](../../src/panels/requestPanel.ts), [src/webview/requestPanel.ts](../../src/webview/requestPanel.ts), [src/webview/requestPanel.css](../../src/webview/requestPanel.css) |
| Runtime lifecycle and assertions | [src/services/runtimeExecutionService.ts](../../src/services/runtimeExecutionService.ts), [src/services/unresolvedVars.ts](../../src/services/unresolvedVars.ts) |
| Protocol execution | [src/services/requestExecutionService.ts](../../src/services/requestExecutionService.ts), [src/services/graphqlSupport.ts](../../src/services/graphqlSupport.ts), [src/services/webSocketClient.ts](../../src/services/webSocketClient.ts), [src/services/grpcClient.ts](../../src/services/grpcClient.ts) |
| Schema and round-trip safety | [schema/missio-extensions.json](../../schema/missio-extensions.json), [schema/opencollectionschema.json](../../schema/opencollectionschema.json), [src/models/schemaRoundTrip.ts](../../src/models/schemaRoundTrip.ts), [src/models/types.ts](../../src/models/types.ts) |
| Copilot and CodeLens routing | [src/copilot/tools](../../src/copilot/tools), [src/providers/codeLensProvider.ts](../../src/providers/codeLensProvider.ts) |
| Demo verification | [examples/demo-api](../../examples/demo-api), [scripts/validate-collection.js](../../scripts/validate-collection.js) |
| Packaging | [.vscodeignore](../../.vscodeignore), [.gitattributes](../../.gitattributes), [esbuild.js](../../esbuild.js), [scripts/build-and-install.ps1](../../scripts/build-and-install.ps1) |

## Reviewer Checklist

For each PR:

1. Confirm the PR title order and branch match the table above.
2. Read the task file or support-doc context.
3. Read the corresponding `AGENT_PROGRESS.md` row and latest task log entries.
4. Review the PR diff against its GitHub base.
5. Check CI status and task-specific verification evidence.
6. Confirm demo fixtures and examples are present when the task needs user verification.
7. Leave findings with concrete file/line references.
8. Approve only when the scoped diff satisfies the task and does not create obvious downstream stack breakage.

For the whole stack:

1. Confirm all 36 open PRs have passing checks before landing.
2. Confirm `#55` remains closed and is not treated as part of the stack.
3. Land in `[NN/36]` order, retargeting each child PR to `main` only after its parent has landed.
4. Use merge commits.
5. Run the final verification commands from the top of the landed stack before publishing a stable release.
