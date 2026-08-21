# OC-040 Runtime Scripting, Testing, Assertions, And Actions

## Goal

Implement OpenCollection runtime lifecycle support: scripts, tests, assertions, and set-variable actions across supported protocol executors.

Use `$missio-demo-server-fixtures` for local runtime fixture routes and user-verifiable demo requests.

## Schema Surface

| Feature | Schema Shape |
| --- | --- |
| Scripts | `runtime.scripts[]` and request defaults `request.scripts[]`. |
| Script phases | `before-request`, `after-response`, `tests`, `hooks`. |
| Assertions | `runtime.assertions[]` with `expression`, `operator`, `value`, `disabled`, `description`. |
| Actions | `set-variable` with `phase`, `selector.method: jsonq`, selector expression, target scope. |
| Script files | Top-level `ScriptFile` item with `type: script` and `script`. |

## Current Gap

Only TypeScript interfaces exist. There is no sandbox, runtime context, assertion evaluator, action evaluator, test result UI, or Postman script conversion.

## Implementation Plan

1. Define a protocol-neutral runtime context:

| Context Area | Contents |
| --- | --- |
| Request | Protocol, URL, headers, body/message, auth, variables. |
| Response | Status, headers, body/message stream summary, timing, errors. |
| Variables | Runtime, request, folder, collection, environment maps. |
| Logs | Console output and test results. |

2. Pick a script execution strategy:

| Option | Notes |
| --- | --- |
| Node `vm` sandbox | Lightweight, local, must restrict globals carefully. |
| Isolated VM package | Better isolation, extra dependency and packaging work. |

3. Implement lifecycle order:

| Phase | Runs |
| --- | --- |
| Before request | Defaults scripts then request scripts with `type: before-request`; actions with `phase: before-request`. |
| Execute request | Protocol executor receives mutated request context. |
| After response | Actions with `phase: after-response`; scripts with `type: after-response`; assertions and tests. |

4. Implement assertions with a narrow expression language first.
5. Implement `set-variable` actions with JSON response selection.
6. Add a result panel/table for tests, assertions, logs, and action mutations.
7. Return test/assertion status from Copilot tools.
8. Extend the local demo API and example collection:

| Demo Area | Required Work |
| --- | --- |
| Server routes | Add deterministic runtime fixture routes to `examples/demo-api/server.js`, such as echoing request headers/body, returning JSON tokens, and returning intentional pass/fail payloads. |
| Demo requests | Add `examples/demo-api/Runtime/` with `folder.yml` and requests that demonstrate before-request scripts, after-response scripts, tests, assertions, and `set-variable` actions. |
| Cross-protocol | Include GraphQL runtime demo requests if OC-010 is available in the applied stack; otherwise record the dependency and keep HTTP demos complete. |
| User notes | Each demo request description should say to run `node examples/demo-api/server.js` first and name the expected test/assertion result. |

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| Scripts | Before and after scripts run in deterministic lifecycle order. |
| Tests | Test scripts can pass/fail and surface failures in UI/tool output. |
| Assertions | Declarative assertions evaluate against response data. |
| Actions | `set-variable` can capture response data into runtime scope at minimum. |
| Safety | Script sandbox has no unreviewed file/network/process access. |
| Traceability | Logs and failures are visible without opening DevTools. |
| Demo verification | A user can run local demo requests and see passing/failing scripts, assertions, logs, and variable mutations in Missio. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| Before-request script adds header. | Test server receives header. |
| After-response script reads JSON. | Test result passes. |
| Assertion checks status/body path. | Pass/fail states are recorded. |
| `set-variable` extracts token. | Later request can use runtime variable. |
| Demo runtime request. | Local demo server receives script-added data and response assertions/actions produce visible results. |

## Security Notes

Treat scripts as untrusted collection content. Any powerful API, shell access, or filesystem access must be opt-in and clearly approved by the user.

