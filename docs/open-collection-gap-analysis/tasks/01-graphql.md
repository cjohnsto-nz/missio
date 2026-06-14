# OC-010 GraphQL Support

## Goal

Implement OpenCollection `GraphQLRequest` support across model, editor, execution, validation, tree, CodeLens, examples, and tests.

## Schema Surface

| Feature | Schema Shape |
| --- | --- |
| Request root | `info`, `graphql`, `runtime`, `settings`, `docs`. |
| Details | `method`, `url`, `headers`, `params`, `body`. |
| Body | `GraphQLBody` with `query` and `variables`, or `GraphQLBodyVariant[]`. |
| Runtime | `variables`, `scripts`, `assertions`, `actions`, `auth`. |
| Settings | Same shape as HTTP settings through `GraphQLRequestSettings`. |

## Current Gap

Missio has no GraphQL types, editor, executor, validation selection, tree rendering, or Copilot send support. The current request editor will create an `http` object if it opens a GraphQL file, which is unsafe until OC-000 and OC-060 improve routing and round-trip preservation.

## Implementation Plan

1. Depend on OC-000 type guards and execution facade.
2. Add GraphQL body selection helpers for single body and body variants.
3. Build a GraphQL editor mode with:

| Panel | Controls |
| --- | --- |
| Request bar | Method, URL, send, variables toggle. |
| Query | GraphQL query/mutation editor. |
| Variables | JSON string editor with formatting and validation. |
| Headers/Params/Auth/Settings | Reuse HTTP-compatible controls where possible. |

4. Execute GraphQL over HTTP:

| Step | Behavior |
| --- | --- |
| Resolve variables | Apply collection, folder, environment, request runtime variables. |
| Build URL | Apply query/path params and auth. |
| Build body | Send JSON object `{ "query": "...", "variables": ... }`. |
| Headers | Default `Content-Type: application/json` unless user overrides. |
| Response | Reuse response viewer and examples where applicable. |

5. Add validation for GraphQL request files.
6. Update tree and CodeLens to show GraphQL operation type or method.
7. Add Copilot `send_request` protocol handling.

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Editing | GraphQL files open without adding `http`; query and variables save schema-native YAML. |
| Execution | Queries and mutations execute successfully against a local test server. |
| Variants | Selected body variant is used; unselected variants survive saves. |
| Variables | Missio variable interpolation works in URL, headers, params, query, variables, and auth. |
| Validation | Valid GraphQL request passes; malformed GraphQL request fails against correct schema. |
| Tooling | Tree, CodeLens, commands, and Copilot tools identify GraphQL as GraphQL. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| Send simple query to local GraphQL-like endpoint. | Request body has query and variables JSON. |
| Save GraphQL request with two body variants. | Both variants remain; selected one is preserved. |
| Open GraphQL request in editor and save without changes. | No `http` object appears. |
| Auth inheritance with GraphQL. | Effective auth header/query is applied. |

## Out Of Scope

GraphQL schema introspection, autocomplete, persisted queries, and GraphQL subscriptions should be separate follow-up tasks after basic request support lands.

