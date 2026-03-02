# Contributing: Adding a New Copilot Tool

This guide walks through adding a new Language Model Tool to Missio. Tools are exposed to AI agents (GitHub Copilot, etc.) via the VS Code `vscode.lm.registerTool()` API.

## Overview

Each tool requires changes in three places:

1. **Tool class** — `src/copilot/tools/<toolName>Tool.ts`
2. **Package manifest** — `package.json` → `contributes.languageModelTools`
3. **Registration** — `src/extension.ts` → `registerLanguageModelTools()`

---

## Step 1: Create the Tool Class

Create a new file in `src/copilot/tools/`. Every tool extends `ToolBase<T>`, where `T` is the input parameter type (or `undefined` for no-param tools).

### Minimal example (no parameters)

```typescript
// src/copilot/tools/myTool.ts
import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';

export class MyTool extends ToolBase<undefined> {
  public readonly toolName = 'missio_my_tool';

  constructor(private _collectionService: CollectionService) {
    super();
  }

  async call(
    _options: vscode.LanguageModelToolInvocationOptions<undefined>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    // Use existing services — never duplicate logic
    const data = this._collectionService.getCollections();
    return JSON.stringify({ success: true, data });
  }
}
```

### Example with parameters

```typescript
// src/copilot/tools/myParamTool.ts
import * as vscode from 'vscode';
import { ToolBase } from './toolBase';
import { CollectionService } from '../../services/collectionService';

export interface MyParamToolParams {
  collectionId: string;
  optionalFlag?: boolean;
}

export class MyParamTool extends ToolBase<MyParamToolParams> {
  public readonly toolName = 'missio_my_param_tool';

  constructor(private _collectionService: CollectionService) {
    super();
  }

  async call(
    options: vscode.LanguageModelToolInvocationOptions<MyParamToolParams>,
    _token: vscode.CancellationToken,
  ): Promise<string> {
    const { collectionId, optionalFlag } = options.input;
    const collection = this._collectionService.getCollection(collectionId);
    if (!collection) {
      return JSON.stringify({ success: false, message: `Collection not found: ${collectionId}` });
    }
    return JSON.stringify({ success: true, name: collection.data.info?.name });
  }
}
```

### Adding a confirmation dialog

For tools that have side effects (sending requests, modifying state), override `prepareInvocation` to show a confirmation dialog before execution:

```typescript
async prepareInvocation(
  options: vscode.LanguageModelToolInvocationPrepareOptions<MyParams>,
  _token: vscode.CancellationToken,
): Promise<vscode.PreparedToolInvocation> {
  return {
    invocationMessage: 'Doing the thing...',
    confirmationMessages: {
      title: 'Missio: Confirm Action',
      message: new vscode.MarkdownString('Are you sure you want to do the thing?'),
    },
  };
}
```

---

## Step 2: Export from the Barrel

Add your export to `src/copilot/tools/index.ts`:

```typescript
export { MyTool } from './myTool';
```

---

## Step 3: Declare in package.json

Add an entry to the `contributes.languageModelTools` array in `package.json`. This is how VS Code discovers the tool — without this, the tool won't appear to agents.

### No-parameter tool

```json
{
  "name": "missio_my_tool",
  "displayName": "My Tool",
  "modelDescription": "Description for the AI model explaining what this tool does and when to use it. Be specific — this is the primary way the model decides whether to call your tool.",
  "userDescription": "Short description shown to the user in tool picker.",
  "toolReferenceName": "missio_my_tool",
  "canBeReferencedInPrompt": true,
  "icon": "$(symbol-misc)",
  "tags": ["api", "missio"]
}
```

### Tool with parameters

```json
{
  "name": "missio_my_param_tool",
  "displayName": "My Param Tool",
  "modelDescription": "Description for the AI model. Mention which other tools provide the required parameter values (e.g. 'Use the collectionId returned by missio_list_collections').",
  "userDescription": "Short user-facing description.",
  "toolReferenceName": "missio_my_param_tool",
  "canBeReferencedInPrompt": true,
  "icon": "$(symbol-misc)",
  "tags": ["api", "missio"],
  "inputSchema": {
    "type": "object",
    "properties": {
      "collectionId": {
        "type": "string",
        "description": "The collection ID returned by missio_list_collections."
      },
      "optionalFlag": {
        "type": "boolean",
        "description": "Optional flag to enable something."
      }
    },
    "required": ["collectionId"]
  }
}
```

### Key fields

| Field | Purpose |
|-------|---------|
| `name` | Unique tool identifier. Must match the name in `vscode.lm.registerTool()`. Use `missio_` prefix + snake_case. |
| `modelDescription` | The AI model reads this to decide when to call the tool. Be detailed. |
| `userDescription` | Short label shown in the VS Code UI. |
| `inputSchema` | JSON Schema defining accepted parameters. Omit entirely for no-param tools. |
| `canBeReferencedInPrompt` | Set `true` so users can `@`-reference the tool in chat. |
| `icon` | A [codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) name. |
| `tags` | Help with tool discovery. Always include `"missio"`. |

---

## Step 4: Register in extension.ts

In the `registerLanguageModelTools()` function in `src/extension.ts`, add:

```typescript
vscode.lm.registerTool('missio_my_tool', new MyTool(collectionService)),
```

The tool name string **must exactly match** the `name` in `package.json`.

Don't forget to add the import at the top of `extension.ts` (the barrel import).

---

## Conventions

- **Naming:** `missio_` prefix, snake_case (e.g. `missio_list_requests`)
- **File naming:** camelCase matching the class (e.g. `listRequestsTool.ts`)
- **Return format:** Always return `JSON.stringify(...)`. Include a `success` boolean for tools that can fail.
- **Error pattern:** Return `{ success: false, message: "..." }` for expected errors. Throw for unexpected errors (ToolBase catches and wraps them).
- **No code duplication:** Call existing services (`CollectionService`, `EnvironmentService`, `HttpClient`, etc.). If the logic you need doesn't exist, add it to the appropriate service first.
- **Confirmation:** Add `prepareInvocation` for any tool that mutates state or makes network calls.

---

## Available Services

These are passed to tools via constructor injection in `registerLanguageModelTools()`:

| Service | Key Methods |
|---------|-------------|
| `CollectionService` | `getCollections()`, `getCollection(id)`, `resolveItems(collection)`, `loadRequestFile(path)` |
| `EnvironmentService` | `getCollectionEnvironments(collection)`, `getActiveEnvironmentName(id)`, `setActiveEnvironment(id, name)`, `resolveVariables(collection)`, `resolveVariablesWithSource(collection)` |
| `HttpClient` | `send(request, collection, folderDefaults?)` |

To add a new service dependency, update the `registerLanguageModelTools()` function signature and pass it through.

---

## Testing

After adding a tool:

1. Run `node esbuild.js --production` to build
2. Run `npx @vscode/vsce package` to create the VSIX
3. Install with `windsurf --install-extension missio-{version}.vsix --force`
4. Open a workspace with collections and test via Copilot Chat — ask it to use your tool
