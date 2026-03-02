# Missio Copilot Tools — Design Document

## Overview

Missio exposes its core capabilities — collection discovery, request inspection and execution, environment and variable management, and schema validation — to AI agents via the **VS Code Language Model Tools API** (`vscode.lm.registerTool()`).

**Key design principle:** Tools run in the extension host process, reusing existing services directly. No child process, no code duplication, no external dependencies beyond what the extension already uses.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  VS Code Extension Host                                      │
│                                                              │
│  ┌──────────────┐    ┌──────────────────────────────────┐   │
│  │ Missio       │    │ Copilot / AI Agent                │   │
│  │ Extension    │    │                                    │   │
│  │              │    │  Uses vscode.lm.registerTool()    │   │
│  │ ┌──────────┐ │    │  to discover and invoke tools     │   │
│  │ │Services  │◄├────┤                                    │   │
│  │ └──────────┘ │    └──────────────────────────────────┘   │
│  │              │                                            │
│  │ - Collection │    ┌──────────────────────────────────┐   │
│  │ - Environment│    │ Missio Tools (9 tools)            │   │
│  │ - HttpClient │◄───┤ (implements LanguageModelTool<T>) │   │
│  │ - Validation │    │                                    │   │
│  └──────────────┘    │ See tool table below               │   │
│                      └──────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Key Benefits

1. **No code duplication** — tools call existing services directly
2. **No child process** — runs in extension host, shares state
3. **No external SDK** — uses VS Code's built-in `vscode.lm` API
4. **Automatic discovery** — VS Code handles tool registration and invocation via `package.json` contribution point

---

## Tools

All tools use the `missio_` prefix and follow snake_case naming.

### Discovery Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `missio_list_collections` | List all collections in workspace | (none) |
| `missio_get_collection` | Read full collection definition | `collectionId` |
| `missio_list_requests` | List requests in a collection | `collectionId` |
| `missio_get_request` | Read full request definition | `requestFilePath` |
| `missio_list_environments` | List environments with active indicator | `collectionId` |

### Environment & Variable Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `missio_set_environment` | Set active environment | `collectionId`, `environmentName` |
| `missio_resolve_variables` | Get resolved variable map with sources | `collectionId` |

### Execution Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `missio_send_request` | Execute HTTP request with full resolution chain | `requestFilePath` |

### Validation Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `missio_validate_collection` | Validate against OpenCollection schema | `collectionId` |

---

## File Structure

```
src/copilot/
└── tools/
    ├── index.ts                  # Barrel exports
    ├── toolBase.ts               # Abstract base class
    ├── listCollectionsTool.ts    # missio_list_collections
    ├── getCollectionTool.ts      # missio_get_collection
    ├── listRequestsTool.ts       # missio_list_requests
    ├── getRequestTool.ts         # missio_get_request
    ├── listEnvironmentsTool.ts   # missio_list_environments
    ├── setEnvironmentTool.ts     # missio_set_environment
    ├── resolveVariablesTool.ts   # missio_resolve_variables
    ├── sendRequestTool.ts        # missio_send_request
    └── validateCollectionTool.ts # missio_validate_collection
```

---

## Summary

| Aspect | Approach |
|--------|----------|
| **API** | `vscode.lm.registerTool()` |
| **Pattern** | ToolBase abstract class (vscode-mssql style) |
| **Services** | Reuse existing CollectionService, EnvironmentService, HttpClient, ValidationService |
| **Location** | `src/copilot/tools/` |
| **Naming** | `missio_` prefix, snake_case |
| **Metadata** | `contributes.languageModelTools` in `package.json` with JSON Schema `inputSchema` |

The design enables an agent to:
1. **Discover** collections, requests, and environments
2. **Inspect** request definitions and resolved variable state
3. **Manage** active environments
4. **Execute** requests through the full auth + variable resolution chain
5. **Validate** collections against the OpenCollection schema

See [docs/contributing-tools.md](contributing-tools.md) for how to add new tools.
