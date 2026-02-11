# Missio REST Client

A lightweight, [OpenCollection](https://www.opencollection.com) compatible REST API client for VS Code.

Missio uses the OpenCollection standard, which is file based (and AI friendly). Collaboration is supported via Git and external secret providers.

<img width="1813" height="1209" alt="Missio Editor" src="https://github.com/user-attachments/assets/f9aea382-110c-4c45-a505-ae970daba555" />

## Missio is a REST Client without an identity crisis

### What Missio Is:
- **A VSCode Extension**
- **A REST Client**
- **Local, Git Native**

### What Missio Is Not:
- **A Standalone IDE**
- **A SAAS Platform**
- **Cloud Synced**
- **A Monthly Subscription**
- **Feature Complete vs Postman**

Missio aims to use VSCode functionality whereever possible.

Git integration, Workspaces, Commands, are all provided by VSCode. 

BYO Agentic Coding tools. 

### Please Note

Missio is still in alpha. Key missing features from Postman include:
- Scripting
- Websockets
- GraphQL

We aim to support these in the coming weeks.

## Features

### Collections & Requests
- **OpenCollection v1.0.0 compatible (partially at least)** — YAML-based collections, requests, folder, and environments
- **Auto-detect collections** — scans workspace for `collection.yml` / `workspace.yml`
- **Custom editors** — visual editors for requests, folders, and collections with native dirty indicators, Ctrl+S save, and undo/redo
- **Tree view sidebar** — browse collections, folders, and requests with inline actions
- **CodeLens** — send requests directly from YAML files
- **Import from Postman** — import Postman v2.0/v2.1 collections and environments
- **Import requests** — paste a cURL, wget, or raw HTTP request and import it directly into a collection

### Request Editor
- **Visual request builder** — method selector, URL bar, headers, query params, body (raw, form-encoded, multipart)
- **Send with Ctrl+Enter** — keyboard shortcut to send requests
- **Response viewer** — formatted body (JSON, XML, HTML) with syntax highlighting, word wrap, line numbers, headers, status, timing, and size
- **Response preview** — PDF and image responses render inline with an option to open in browser
- **Cancel requests** — cancel in-flight requests from the command palette or UI
- **Request timer** — live elapsed time display while a request is in progress, with the previous response dimmed until the new one arrives
- **Auto headers** — `Content-Type` and `Content-Length` are calculated automatically and shown as read-only (override by specifying your own)
- **Unresolved variable prompts** — if any `{{variables}}` remain unresolved after interpolation, a modal prompts you to fill them in before sending
- **Save examples** — save response snapshots and load them later

### Variables & Environments
- **Environment management** — switch between dev/staging/prod with `{{variable}}` interpolation
- **Variable inheritance** — Collection > Folder > Environment (each layer overrides the previous)
- **Variable highlighting** — source-colored overlays on all input fields (URL, headers, params, body, auth)
- **Click-to-inspect** — click any `{{variable}}` to see its resolved value, source, and actions
- **Toggle resolved values** — `{{}}` button shows actual resolved values in-place across all fields
- **Autocomplete** — type `{{` to get variable suggestions with source labels
- **`.env` file support** — automatically loads `.env` files from collection directories

### Authentication
- **Auth types** — None, Bearer Token, Basic Auth, API Key, OAuth 2.0
- **Auth inheritance** — Request > Folder > Collection (first non-inherit wins)
- **OAuth 2.0** — client credentials, password, and authorization code (PKCE) flows with automatic token management
- **Token status display** — live token expiry countdown with Get Token / Refresh buttons in request, folder, and collection editors
- **Token caching** — tokens stored securely per collection, environment, and credentials
- **Refresh on 4xx** — helper button on 4xx responses to clear a stale OAuth token and retry

### Folder Defaults
- **Folder editor** — configure folder-level auth, headers, and variables via `folder.yml`
- **Folder inheritance** — folder defaults apply to all requests in the folder
- **New folders default to inherit** — auth set to `inherit` by default

### Collection Editor
- **Visual collection editor** — overview, auth, headers, variables, and environments tabs
- **Environment editor** — add, remove, rename environments with variable key-value editing
- **Collection-level defaults** — set default auth and headers for all requests

### Secret Providers
- **Azure Key Vault** — fetch secrets at runtime via `az cli` (no SDK required)
- **Collection-scoped config** — secret providers defined in `collection.yml`, fully portable
- **`$secret` syntax** — reference secrets with `{{$secret.providerName.secretName}}` in any field
- **Secret autocomplete** — type `{{$secret.` to get provider and secret name suggestions
- **On-demand reveal** — click a secret variable to see its source, then click "Reveal Value" to fetch and display it
- **Test connection** — verify vault access and RBAC from the collection editor's Secrets tab

## Secret Providers

Secret providers are configured per-collection in `collection.yml`. Secrets are resolved at runtime — no secret values are stored in files.

### Azure Key Vault

Prerequisites: `az login` and RBAC access (Key Vault Secrets User) on the vault.

Add a provider to your collection:

```yaml
config:
  secretProviders:
    - name: my-vault
      type: azure-keyvault
      url: "https://my-vault.vault.azure.net"
```

The vault URL supports variables — useful for per-environment vaults:

```yaml
config:
  secretProviders:
    - name: kv
      type: azure-keyvault
      url: "https://{{vault_name}}.vault.azure.net"
```

Then reference secrets anywhere you'd use a variable:

```yaml
http:
  auth:
    type: bearer
    token: "{{$secret.my-vault.api-key}}"
```

Secrets are resolved at send time and during OAuth2 token acquisition. The collection editor's **Secrets** tab lets you test connections and see available secret names.

## Commands

| Command | Description |
|---------|-------------|
| `Missio: Send Request` | Execute the current request |
| `Missio: Select Active Environment` | Choose the active environment |
| `Missio: New Collection` | Scaffold a new collection |
| `Missio: Import Collection` | Import from Postman (v2.0/v2.1) |
| `Missio: Import Request` | Import a request from cURL, wget, or raw HTTP format |
| `Missio: Import Environment` | Import environment from Postman |
| `Missio: New Request` | Create a new request YAML file |
| `Missio: New Folder` | Create a new folder in a collection |
| `Missio: New Environment` | Add an environment to a collection |
| `Missio: Configure Collection` | Open the collection editor |
| `Missio: Configure Folder` | Open the folder editor |
| `Missio: Refresh Collections` | Re-scan the workspace |
| `Missio: Configure Secret Provider` | Set up secret providers in collection |
| `Missio: Cancel Request` | Cancel all in-flight requests |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Send request (in request editor) |

## OpenCollection Spec

This extension implements the [OpenCollection v1.0.0 specification](https://spec.opencollection.com). All unknown/unsupported fields in YAML files are preserved on save (round-trip safe).

- Schema: `https://schema.opencollection.com/json/draft-07/opencollection/v1.0.0`
- Workspace schema: `https://schema.opencollection.com/json/draft-07/opencollection-workspace/v1.0.0`

## License

MIT
