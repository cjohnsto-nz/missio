---
name: missio-demo-server-fixtures
description: Extend Missio's local demo API and example OpenCollection requests for user-verifiable feature work. Use when adding protocol or runtime support that needs local fixture server routes, demo requests under examples/demo-api, smoke-test instructions, or user-facing verification data for GraphQL, WebSocket, gRPC, scripts, assertions, actions, auth, proxy, mTLS, redirects, or transport behavior.
---

# Missio Demo Server Fixtures

## Overview

Use the local demo API as the human verification surface for protocol and runtime work. Automated tests still need in-process fixture servers, but completed features should also be easy for a user to try from the packaged extension.

## First Steps

1. Read `examples/demo-api/server.js` and `examples/demo-api/opencollection.yml`.
2. Preserve existing binary upload routes and demo requests.
3. Add demo routes, companion fixture servers, and OpenCollection request files for the feature being implemented.
4. Update `docs/open-collection-gap-analysis/AGENT_PROGRESS.md` with the demo route/request evidence.

## Demo API Rules

- Keep demo servers local-only by default: bind to `127.0.0.1`, use deterministic ports, and avoid external services.
- Prefer extending `examples/demo-api/server.js` for HTTP-compatible routes such as GraphQL-over-HTTP and runtime assertion/action fixtures.
- Use companion files when a protocol cannot share the HTTP server cleanly, for example `examples/demo-api/grpc-server.js` and `examples/demo-api/proto/*.proto`.
- Keep start commands simple. A user should be able to run `node examples/demo-api/server.js` plus any clearly documented companion command.
- Add or update `LOCAL` environment variables in `examples/demo-api/opencollection.yml` instead of hardcoding endpoints in request files. Keep `baseUrl` for HTTP routes; add names such as `wsBaseUrl` or `grpcBaseUrl` when needed.
- Add demo request folders under `examples/demo-api/` with schema-valid `folder.yml` and request files. Include short descriptions telling the user which server command to run.
- Keep sample payloads small, deterministic, and safe to commit.
- Do not make demo requests depend on internet access.

## Expected Feature Fixtures

| Track | Demo Server Work | Demo Requests |
| --- | --- | --- |
| OC-010 GraphQL | Add `POST /graphql` and a GraphQL health or fixture route that returns deterministic query/mutation responses and echoes variables. | Add GraphQL request files for query, mutation, variables, and body variants. |
| OC-020 WebSocket | Add or document a local WebSocket fixture, preferably sharing the demo server process when using `ws`; include echo and auth/header verification paths. | Add WebSocket request files for text, JSON with variables, auth/header handshake, and disconnect/error behavior. |
| OC-030 gRPC | Add a local gRPC fixture server and proto files under `examples/demo-api/`; expose at a `grpcBaseUrl` such as `localhost:50051`. | Add gRPC unary request files with metadata, variables, and invalid/unsupported streaming examples where useful. |
| OC-040 Runtime | Add HTTP routes that make lifecycle effects visible, such as echoing headers/body, returning JSON tokens, and deterministic success/failure payloads. | Add HTTP/GraphQL demo requests with before/after scripts, tests, assertions, and set-variable actions. |

## Verification

Before marking a task done:

- Run the automated tests required by the task skill.
- Run `npm run compile`, `npm test`, and `npm run build` unless the task owner records a concrete blocker.
- Run or smoke-test the demo server route added by the task, for example with a short Node script or Missio request fixture.
- Validate the demo collection files with Missio validation or the relevant validation service tests.
- Record the demo start command, routes, request files, and smoke-test result in `AGENT_PROGRESS.md`.
