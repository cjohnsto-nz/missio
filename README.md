# Missio REST Client

A lightweight, [OpenCollection](https://www.opencollection.com)-compliant REST API client for VS Code.

## Features

- **OpenCollection v1.0.0 compliant** — YAML-based collections, requests, and environments
- **Auto-detect collections** — scans workspace for `collection.yml` / `workspace.yml`
- **Environment management** — switch between dev/staging/prod with `{{variable}}` interpolation
- **Secret providers** — Azure Key Vault and Keeper Secrets Manager integration
- **Send requests** — execute HTTP requests directly from YAML files with CodeLens
- **Tree view sidebar** — browse collections, folders, and requests
- **Response viewer** — formatted response display with headers, body, timing

## Getting Started

### 1. Create a collection

Run **Missio: New Collection** from the command palette, or create a `collection.yml`:

```yaml
opencollection: "1.0.0"

info:
  name: My API
  version: "1.0.0"

config:
  environments:
    - name: development
      variables:
        - name: baseUrl
          value: "http://localhost:3000"
    - name: production
      variables:
        - name: baseUrl
          value: "https://api.example.com"

items: []
```

### 2. Create a request

Create a `.yml` file in the same directory:

```yaml
info:
  name: Get Users
  type: http
  seq: 1

http:
  method: GET
  url: "{{baseUrl}}/api/users"
  headers:
    - name: Authorization
      value: "Bearer {{token}}"
  params:
    - name: page
      value: "1"
      type: query

settings:
  encodeUrl: true
  timeout: 30000
  followRedirects: true
  maxRedirects: 5
```

### 3. Send it

Click **▶ Send Request** in the CodeLens above the file, or use the play button in the tree view.

## Workspace File

Use a `workspace.yml` to organize multiple collections:

```yaml
workspace: "1.0.0"

info:
  name: My Workspace

collections:
  - name: Users API
    path: ./users-api
  - name: Orders API
    path: ./orders-api
```

## Secret Providers

### Azure Key Vault

Configure in VS Code settings:

```json
{
  "missio.secretProviders": {
    "azureKeyVault": {
      "vaultUrl": "https://my-vault.vault.azure.net"
    }
  }
}
```

Then use `SecretVariable` in your environments:

```yaml
config:
  environments:
    - name: production
      variables:
        - secret: true
          name: "azureKeyVault:my-api-key"
```

### Keeper Secrets Manager

```json
{
  "missio.secretProviders": {
    "keeper": {
      "configFile": "/path/to/keeper-config.json"
    }
  }
}
```

## Commands

| Command | Description |
|---------|-------------|
| `Missio: Send Request` | Execute the current request |
| `Missio: Select Active Environment` | Choose the active environment |
| `Missio: New Collection` | Scaffold a new collection |
| `Missio: New Request File` | Create a new request YAML file |
| `Missio: New Environment` | Add an environment to a collection |
| `Missio: Refresh Collections` | Re-scan the workspace |
| `Missio: Configure Secret Provider` | Set up Azure Key Vault or Keeper |
| `Missio: Cancel Request` | Cancel all in-flight requests |

## OpenCollection Spec

This extension implements the [OpenCollection v1.0.0 specification](https://spec.opencollection.com).

- Schema: `https://schema.opencollection.com/json/draft-07/opencollection/v1.0.0`
- Workspace schema: `https://schema.opencollection.com/json/draft-07/opencollection-workspace/v1.0.0`

## License

MIT
