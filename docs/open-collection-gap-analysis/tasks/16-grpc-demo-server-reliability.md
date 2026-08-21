# OC-160 gRPC Demo Server Reliability

## Goal

Make every gRPC demo request under `examples/demo-api/gRPC/` work reliably for a user after following the documented local demo start flow. The current user-facing symptom is that gRPC demo requests fail because nothing appears to be serving `localhost:50051`.

This is a demo-fixture and verification task, not a new gRPC protocol feature task. It should preserve the OC-030 unary and OC-090 streaming implementation behavior while making the local example collection trustworthy.

## Current Gap

| Surface | Gap |
| --- | --- |
| Demo server lifecycle | `examples/demo-api/server.js` does not make it obvious whether the gRPC fixture is also running, and a user can start the HTTP/WebSocket demo server while `localhost:50051` remains closed. |
| Demo request endpoints | gRPC request files rely on `{{grpcBaseUrl}}`/`localhost:50051`; those values must match the actual local fixture server. |
| User guidance | gRPC request descriptions and docs need a clear command sequence for starting every required demo process. |
| Smoke coverage | Existing automated coverage proves gRPC client behavior, but user-facing demo request startup can regress if the fixture server is not started, not bound to the expected port, or drifts from the proto/request files. |
| Packaging confidence | Packaged extension verification should include a live gRPC demo smoke so missing fixture startup does not escape review. |

## Implementation Plan

1. Reproduce and document the failure:

| Check | Expected Evidence |
| --- | --- |
| Run the documented demo start command. | Record whether it starts only HTTP/WebSocket or also gRPC. |
| Send each gRPC demo request. | Record current failures, including connection errors for `localhost:50051` and any proto/method mismatch. |
| Inspect environment variables. | Confirm `examples/demo-api/opencollection.yml` defines `LOCAL.grpcBaseUrl` and related proto paths consistently. |

2. Normalize the local gRPC fixture server:

| Area | Required Work |
| --- | --- |
| Server command | Provide a simple deterministic command, such as `node examples/demo-api/grpc-server.js`, that binds `127.0.0.1:50051` or the documented configured port. |
| Optional aggregate command | If useful, add a repo script or small helper that starts all demo processes needed for HTTP, WebSocket, GraphQL, runtime, and gRPC verification without hiding failures. |
| Startup diagnostics | Print the bound host/port and available gRPC methods so users can tell the fixture is ready. |
| Shutdown cleanup | Ensure tests and smoke scripts can start and stop the fixture without leaving a locked port. |
| Local-only safety | Keep the fixture bound to loopback and independent of internet access. |

3. Align demo requests and collection config:

| Area | Required Work |
| --- | --- |
| `opencollection.yml` | Ensure `LOCAL.grpcBaseUrl`, proto file paths, and import paths resolve from a normal checkout. |
| Request files | Ensure every unary, server-streaming, client-streaming, bidirectional-streaming, metadata, runtime, and error demo points at the local fixture and a real proto method. |
| Request descriptions | Each gRPC request should tell the user which gRPC fixture command must be running. |
| Folder guidance | `examples/demo-api/gRPC/folder.yml` should summarize the gRPC demo start requirement. |
| Validation | Demo request YAML must remain schema-valid and preserve OpenCollection gRPC fields on round trip. |

4. Add automated and live verification:

| Test Surface | Required Work |
| --- | --- |
| Fixture integration | Add or extend tests that start the demo gRPC server process, wait for readiness, and execute representative demo requests through the Missio gRPC execution path. |
| Demo inventory | Cover every committed gRPC demo request or group them by method type with explicit documented exceptions. |
| Failure diagnostics | Add coverage for the user-facing error when the fixture server is not running, so the message points to the start command instead of a bare connection failure when practical. |
| Collection validation | Run `node scripts/validate-collection.js examples/demo-api`. |
| Regression safety | Run existing gRPC, runtime, send-tool, response-provider, schema round-trip, and validation tests touched by the fixture changes. |

5. Update packaging/user verification flow:

| Area | Required Work |
| --- | --- |
| README or demo docs | Add concise local demo startup instructions if the current docs do not tell users how to start gRPC. |
| Build/install | Package and install the extension after the fix so the user can retry the demo requests from VS Code. |
| Ledger | Record the exact gRPC demo start command, smoke command, request coverage, build/package/install evidence, and any remaining caveats in `AGENT_PROGRESS.md`. |

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Reproduction | The original failure mode is reproduced or otherwise explained with concrete evidence. |
| Listening fixture | A documented command starts a local gRPC fixture on the same host/port used by the demo collection, expected to be `127.0.0.1:50051` or `localhost:50051`. |
| Demo request parity | Every `examples/demo-api/gRPC/*.yml` request either sends successfully against the local fixture or is intentionally a documented failure diagnostic request. |
| Streaming coverage | Unary, server-streaming, client-streaming, bidirectional-streaming, and deterministic error-stream demos are covered if present in the demo folder. |
| Runtime coverage | gRPC runtime demo requests, including scripts/assertions/actions where present, execute against the fixture and expose results. |
| Clear user guidance | Folder/request descriptions and docs tell users exactly which command or script to run before sending gRPC requests. |
| Automated proof | Tests start/stop the fixture and exercise representative or complete gRPC demo requests without depending on an already-running server. |
| Packaging proof | `npm run build`, local package/install, demo collection validation, and live gRPC smoke evidence are recorded. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| Demo server readiness | Starting the fixture process produces a readiness signal and accepts a simple unary call on the documented port. |
| Demo unary request smoke | `echo-unary.yml` executes through `RequestExecutionService` and returns deterministic response data. |
| Metadata/defaults smoke | `echo-metadata-defaults.yml` proves metadata/defaults still reach the fixture. |
| Streaming request smoke | Server, client, and bidirectional streaming demo requests return the expected event summaries. |
| Runtime lifecycle smoke | `runtime-unary-lifecycle.yml` resolves variables, runs runtime assertions/actions, and surfaces results. |
| Fixture missing diagnostic | Sending a demo request without the fixture running returns a useful diagnostic that names the gRPC demo start command where feasible. |
| Demo collection validation | `node scripts/validate-collection.js examples/demo-api` passes with all gRPC demo files included. |

Recommended verification commands:

```powershell
npm run compile
npx vitest run test/grpcSupport.test.ts test/runtimeExecutionService.test.ts test/responseProvider.test.ts test/sendRequestTool.test.ts test/schemaRoundTrip.test.ts test/validationService.test.ts
node scripts/validate-collection.js examples/demo-api
npm test
npm run build
npm run install:local
```

The implementation agent should add any new focused fixture-smoke test command to this list once it exists.

## Dependencies

| Dependency | Reason |
| --- | --- |
| OC-030 | Provides proto loading, unary execution, metadata defaults, and the original local gRPC fixture. |
| OC-080 | Provides gRPC runtime lifecycle behavior used by runtime demo requests. |
| OC-090 | Provides gRPC streaming execution and streaming demo fixture expectations. |
| OC-110/OC-150 | Runtime authoring and assertion behavior may be visible in gRPC runtime demo requests. |

## Out Of Scope

| Area | Reason |
| --- | --- |
| New gRPC protocol features | OC-030 and OC-090 own protocol execution capabilities. This task fixes demo reliability and verification. |
| External gRPC services | Demo requests must remain local-only and deterministic. |
| Changing OpenCollection schema | Use existing schema fields unless a concrete validation bug is found and separately justified. |
