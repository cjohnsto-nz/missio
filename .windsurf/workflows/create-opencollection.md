---
description: How to create OpenCollection schema-compliant API collections for use with Missio (or any OpenCollection-compatible tool)
---

# Creating OpenCollection API Collections

OpenCollection is a YAML-based, filesystem-driven specification for organizing API request collections. Missio is a VS Code extension that consumes these collections. This guide covers how to create spec-compliant collections from scratch.

## Filesystem Structure

An OpenCollection lives as a **directory tree** on disk. The root contains a `collection.yml`, and requests are individual `.yml` files organized into subdirectories (folders).

```
my-api/
├── collection.yml          # Root collection definition (required)
├── Users/                  # Folder (directory name = folder name)
│   ├── folder.yml          # Optional folder-level defaults
│   ├── get-users.yml       # Request file
│   └── get-user-by-id.yml  # Request file
├── Posts/
│   ├── folder.yml
│   ├── get-posts.yml
│   └── create-post.yml
└── Health/
    └── ping.yml
```

**Key rules:**
- The collection root is identified by the presence of `collection.yml` (or `collection.yaml`)
- Each subdirectory is a folder; nesting is supported
- Each `.yml`/`.yaml` file that is NOT `collection.yml`, `folder.yml`, or `workspace.yml` is treated as a request file
- File names become the default display names if `info.name` is not set, but always set `info.name`
- Use kebab-case for file names (e.g., `get-user-by-id.yml`)

## Naming & Style Conventions

### Variable Names — snake_case

All variable names must use **snake_case**:

```yaml
# Correct
- name: base_url
  value: https://api.example.com
- name: api_key
  value: my-key
- name: user_id
  value: "123"

# Wrong — do not use camelCase or PascalCase
- name: baseUrl      # NO
- name: ApiKey       # NO
- name: userId       # NO
```

### URL Path Segments — No Leading or Trailing Slashes

When composing URLs from variables, **never include leading or trailing slashes** in variable values. This keeps the UI readable and avoids double-slash bugs.

```yaml
# Environment variables — no trailing slash on base URLs
- name: base_url
  value: https://api.example.com       # Correct — no trailing slash

# Collection default variables — no leading or trailing slashes on path segments
- name: api_path
  value: api/v1                         # Correct — no slashes on either end

# Request URL — slashes only in the URL template itself
http:
  url: "{{base_url}}/{{api_path}}/users"  # Resolves to: https://api.example.com/api/v1/users
```

The slash is always part of the **URL template**, never part of the **variable value**:

```yaml
# Correct — slashes in the template, not the variables
url: "{{base_url}}/{{api_path}}/users/{{user_id}}/posts"

# Wrong — slash baked into variable value
- name: api_path
  value: /api/v1/     # NO — leads to double slashes
```

### File Names — kebab-case

Request file names use kebab-case: `get-user-by-id.yml`, `create-post.yml`, `list-users.yml`.

## Environment Design & Variable Placement Strategy

Variables should be defined at the **right level** based on what they represent. The guiding principle: **values that change per environment go in environments; values that are derived or constant go in collection/folder defaults.**

### Environment Level — Values That Change Between Environments

Environment variables hold values that differ between DEV, staging, production, etc. These are typically **base URLs, credentials, tenant IDs, and feature flags**.

```yaml
config:
  environments:
    - name: DEV
      variables:
        - name: base_url
          value: https://dev.api.example.com
        - name: auth_url
          value: https://dev.login.example.com
        - name: tenant_id
          value: dev-tenant-001
        - name: client_id
          value: dev-client-id
        - secret: true
          name: client_secret
    - name: PROD
      variables:
        - name: base_url
          value: https://api.example.com
        - name: auth_url
          value: https://login.example.com
        - name: tenant_id
          value: prod-tenant-001
        - name: client_id
          value: prod-client-id
        - secret: true
          name: client_secret
```

**Put at environment level:**
- `base_url` — the root domain/host that changes per environment
- `auth_url` — identity provider URLs
- `tenant_id`, `subscription_id`, `org_id` — environment-specific identifiers
- `client_id`, `client_secret` — OAuth credentials
- Any value where DEV ≠ PROD

### Collection Level — Derived Paths and Shared Constants

Collection default variables hold values that are **the same across all environments** or are **composed from environment variables**. This is the ideal place for API path prefixes and shared constants.

```yaml
# collection.yml
request:
  variables:
    - name: api_path
      value: api/v2
    - name: api_url
      value: "{{base_url}}/{{api_path}}"
    - name: content_type
      value: application/json
    - name: page_size
      value: "25"
```

Now every request can use `{{api_url}}` instead of repeating `{{base_url}}/api/v2`:

```yaml
# Request URL becomes clean and readable
http:
  url: "{{api_url}}/users"
```

**Put at collection level:**
- `api_url` — composed from `{{base_url}}` + path prefix (e.g., `{{base_url}}/api/v2`)
- `api_path` — the API version path segment (e.g., `api/v2`)
- Shared constants like `page_size`, `content_type`
- Any value that is the same regardless of environment

### Folder Level — Scoped Defaults for a Resource Group

Folder variables apply only to requests within that folder. Use them for resource-specific path segments or IDs.

```yaml
# Users/folder.yml
request:
  variables:
    - name: resource_path
      value: users
    - name: default_role
      value: member
```

**Put at folder level:**
- Resource-specific path segments or sub-paths
- Default values that only make sense for that resource group
- Folder-scoped auth overrides

### Request Level — Runtime Variables Only

Requests do **not** have a static variable definition block. The `runtime.variables` field exists but is for **runtime-scoped values** (e.g., values extracted from responses via actions). If you need a variable scoped to a specific request context, define it at the folder level instead.

```yaml
# This is a runtime variable, NOT a static definition:
runtime:
  actions:
    - type: set-variable
      phase: after-response
      selector:
        expression: res.body.token
        method: jsonq
      variable:
        name: auth_token
        scope: runtime
```

### Full Example — Layered Variable Strategy

```
Environment (DEV):    base_url = https://dev.api.example.com
Collection default:   api_url  = {{base_url}}/api/v2
Folder default:       (none needed)
Request URL:          {{api_url}}/users/{{user_id}}
                      → https://dev.api.example.com/api/v2/users/123
```

This layering means:
- Switching environments changes `base_url` → `api_url` updates automatically → all requests update
- Changing API version only requires editing `api_path` in one place
- Request URLs stay short and readable

## collection.yml — Root Collection File

This is the only required file. It defines collection metadata, environments, variables, and default request settings.

```yaml
opencollection: 1.0.0
info:
  name: My API
  summary: API collection for the My Service
  version: 1.0.0
  authors:
    - name: Your Name
      email: you@example.com

config:
  environments:
    - name: DEV
      color: charts.red
      variables:
        - name: base_url
          value: https://dev.api.example.com
        - name: api_key
          value: dev-key-123
        - secret: true
          name: db_password
    - name: PROD
      color: terminal.ansiGreen
      variables:
        - name: base_url
          value: https://api.example.com
        - name: api_key
          value: prod-key-456
        - secret: true
          name: db_password

# Collection-level request defaults (inherited by all requests)
request:
  headers:
    - name: Accept
      value: application/json
  auth:
    type: bearer
    token: "{{api_key}}"
  variables:
    - name: api_url
      value: "{{base_url}}/api/v1"
    - name: default_timeout
      value: "30000"
```

### Environment Colors

Environment `color` values use VS Code theme color IDs:
- `charts.red`, `charts.blue`, `charts.green`, `charts.yellow`, `charts.orange`, `charts.purple`
- `terminal.ansiGreen`, `terminal.ansiRed`, `terminal.ansiYellow`, `terminal.ansiBlue`

### Variable Types

```yaml
# Plain variable — value stored as-is in YAML
- name: base_url
  value: https://api.example.com

# Secret variable — prompts for value at runtime, never stored in YAML
- secret: true
  name: api_key

# Disabled variable — exists but not resolved
- name: legacy_url
  value: https://old.api.example.com
  disabled: true
```

### Secret Providers (Azure Key Vault)

```yaml
config:
  secretProviders:
    - name: my-vault
      type: azure-keyvault
      url: "https://{{vault_name}}.vault.azure.net"
```

Reference secrets in variable values with: `$secret.my-vault.secret-name`

### Client Certificates

```yaml
config:
  clientCertificates:
    - domain: "*.example.com"
      type: pem
      certificateFilePath: ./certs/client.crt
      privateKeyFilePath: ./certs/client.key
      passphrase: optional-passphrase
    - domain: api.other.com
      type: pkcs12
      pkcs12FilePath: ./certs/client.pfx
      passphrase: optional-passphrase
```

### Proxy Configuration

```yaml
config:
  proxy:
    enabled: true
    inherit: false
    config:
      protocol: http
      hostname: proxy.corp.com
      port: 8080
      auth:
        username: proxyuser
        password: proxypass
      bypassProxy: "localhost,127.0.0.1,.internal.com"
```

## folder.yml — Folder Defaults

Place a `folder.yml` inside any subdirectory to set defaults that apply to all requests in that folder. These override collection-level defaults.

```yaml
info:
  name: User Management
  type: folder

request:
  headers:
    - name: X-Custom-Header
      value: folder-value
  auth:
    type: basic
    username: "{{service_user}}"
    password: "{{service_password}}"
  variables:
    - name: folder_var
      value: some-value
```

**Inheritance chain:** Collection defaults → Folder defaults → Environment variables (environment always wins)

## Request Files — HTTP Requests

Each request is a standalone `.yml` file with up to five top-level sections: `info`, `http`, `runtime`, `settings`, and `examples`.

### Minimal GET Request

```yaml
info:
  name: Get Users
  type: http

http:
  method: GET
  url: "{{api_url}}/users"
```

### Full GET Request with Query Params

```yaml
info:
  name: Get Users
  type: http
  seq: 1
  tags:
    - users
    - public

http:
  method: GET
  url: "{{api_url}}/users"
  headers:
    - name: Accept
      value: application/json
    - name: X-Request-ID
      value: "{{$uuid}}"
  params:
    - name: page
      value: "1"
      type: query
    - name: limit
      value: "25"
      type: query
    - name: status
      value: active
      type: query
      disabled: false

settings:
  encodeUrl: true
  timeout: 30000
  followRedirects: true
  maxRedirects: 5
```

### POST Request with JSON Body

```yaml
info:
  name: Create User
  type: http
  seq: 2
  tags:
    - users

http:
  method: POST
  url: "{{api_url}}/users"
  headers:
    - name: Content-Type
      value: application/json
  body:
    type: json
    data: |-
      {
        "name": "{{user_name}}",
        "email": "{{user_email}}",
        "role": "member"
      }

runtime:
  assertions:
    - expression: res.status
      operator: equals
      value: "201"
    - expression: res.body.id
      operator: isNotEmpty

settings:
  encodeUrl: true
  timeout: 30000
```

### POST with Form URL-Encoded Body

```yaml
info:
  name: Login
  type: http

http:
  method: POST
  url: "{{base_url}}/auth/login"
  headers:
    - name: Content-Type
      value: application/x-www-form-urlencoded
  body:
    type: form-urlencoded
    data:
      - name: username
        value: "{{username}}"
      - name: password
        value: "{{password}}"
      - name: grant_type
        value: password
```

### POST with Multipart Form Body

```yaml
info:
  name: Upload Avatar
  type: http

http:
  method: POST
  url: "{{api_url}}/users/{{user_id}}/avatar"
  body:
    type: multipart-form
    data:
      - name: file
        type: file
        value: ./fixtures/avatar.png
      - name: description
        type: text
        value: Profile photo
```

### PUT Request

```yaml
info:
  name: Update User
  type: http
  seq: 3

http:
  method: PUT
  url: "{{api_url}}/users/{{user_id}}"
  headers:
    - name: Content-Type
      value: application/json
  body:
    type: json
    data: |-
      {
        "name": "{{updated_name}}",
        "email": "{{updated_email}}"
      }
```

### DELETE Request

```yaml
info:
  name: Delete User
  type: http
  seq: 4

http:
  method: DELETE
  url: "{{api_url}}/users/{{user_id}}"
```

### Request with Path Parameters

Path parameters are referenced in the URL with `{{var_name}}` syntax and can optionally be declared in `params`:

```yaml
http:
  method: GET
  url: "{{api_url}}/users/{{user_id}}/posts/{{post_id}}"
  params:
    - name: user_id
      value: "{{user_id}}"
      type: path
    - name: post_id
      value: "123"
      type: path
```

## Authentication Types

Auth can be set at collection level (`request.auth`), folder level (`folder.yml → request.auth`), or request level (`runtime.auth`). Use `inherit` to inherit from the parent level.

### Bearer Token
```yaml
runtime:
  auth:
    type: bearer
    token: "{{access_token}}"
```

### Basic Auth
```yaml
runtime:
  auth:
    type: basic
    username: "{{username}}"
    password: "{{password}}"
```

### API Key
```yaml
runtime:
  auth:
    type: apikey
    key: X-API-Key
    value: "{{api_key}}"
    placement: header    # or "query"
```

### OAuth2 — Client Credentials
```yaml
runtime:
  auth:
    type: oauth2
    flow: client_credentials
    accessTokenUrl: "{{base_url}}/oauth/token"
    credentials:
      clientId: "{{client_id}}"
      clientSecret: "{{client_secret}}"
      placement: basic_auth_header    # or "body"
    scope: "read write"
    settings:
      autoFetchToken: true
      autoRefreshToken: true
```

### OAuth2 — Authorization Code
```yaml
runtime:
  auth:
    type: oauth2
    flow: authorization_code
    authorizationUrl: "{{auth_url}}/authorize"
    accessTokenUrl: "{{auth_url}}/token"
    callbackUrl: http://localhost:3000/callback
    credentials:
      clientId: "{{client_id}}"
      clientSecret: "{{client_secret}}"
    scope: "openid profile"
    pkce:
      enabled: true
      method: S256
```

### Digest Auth
```yaml
runtime:
  auth:
    type: digest
    username: "{{username}}"
    password: "{{password}}"
```

### NTLM Auth
```yaml
runtime:
  auth:
    type: ntlm
    username: "{{username}}"
    password: "{{password}}"
    domain: CORP
```

### AWS Signature V4
```yaml
runtime:
  auth:
    type: awsv4
    accessKeyId: "{{aws_access_key}}"
    secretAccessKey: "{{aws_secret_key}}"
    sessionToken: "{{aws_session_token}}"
    service: execute-api
    region: us-east-1
```

### Inherit (use parent auth)
```yaml
runtime:
  auth: inherit
```

## Body Types

| `type` value | Description | `data` type |
|---|---|---|
| `json` | JSON body | string (raw JSON) |
| `text` | Plain text | string |
| `xml` | XML body | string |
| `sparql` | SPARQL query | string |
| `form-urlencoded` | URL-encoded form | array of `{name, value}` |
| `multipart-form` | Multipart form | array of `{name, type, value}` |
| `file` | Binary file upload | array of `{filePath, contentType, selected}` |

For raw body types (`json`, `text`, `xml`, `sparql`), use YAML block scalar `|-` to preserve formatting:

```yaml
body:
  type: json
  data: |-
    {
      "key": "value"
    }
```

## Variables

Variables use `{{variable_name}}` syntax and can appear in URLs, headers, body content, auth fields, and any other text field.

**Resolution order:** Request variables → Folder variables → Collection default variables → Environment variables (environment always wins)

### Variable Definition Levels (Summary)

| Level | Location | Purpose |
|---|---|---|
| Environment | `config.environments[].variables` | Values that change per environment (`base_url`, credentials) |
| Collection | `request.variables` (root) | Derived/shared constants (`api_url`, `page_size`) |
| Folder | `request.variables` (in `folder.yml`) | Resource-group scoped defaults |
| Runtime | `runtime.variables` (in request) | Runtime-only; populated by actions, not static definitions |

## Runtime — Assertions

Assertions validate response data after a request completes:

```yaml
runtime:
  assertions:
    - expression: res.status
      operator: equals
      value: "200"
    - expression: res.body.data.length
      operator: greaterThan
      value: "0"
    - expression: res.headers.content-type
      operator: contains
      value: application/json
    - expression: res.body.id
      operator: isNotEmpty
    - expression: res.body.error
      operator: isUndefined
      disabled: true
```

## Runtime — Actions (Set Variable)

Extract values from responses and store them as variables:

```yaml
runtime:
  actions:
    - type: set-variable
      phase: after-response
      selector:
        expression: res.body.token
        method: jsonq
      variable:
        name: access_token
        scope: environment    # runtime | request | folder | collection | environment
    - type: set-variable
      phase: after-response
      selector:
        expression: res.body.data[0].id
        method: jsonq
      variable:
        name: first_item_id
        scope: runtime
```

## Runtime — Scripts

```yaml
runtime:
  scripts:
    - type: before-request
      code: |
        console.log("About to send request");
    - type: after-response
      code: |
        console.log("Response status:", res.status);
    - type: tests
      code: |
        test("status is 200", () => expect(res.status).toBe(200));
```

## Saved Examples

Capture request/response pairs as documentation:

```yaml
examples:
  - name: Successful response
    request:
      url: "https://api.example.com/users"
      method: GET
      headers:
        - name: Accept
          value: application/json
    response:
      status: 200
      statusText: OK
      headers:
        - name: Content-Type
          value: application/json
      body:
        type: json
        data: |-
          [{"id": 1, "name": "Alice"}]
```

## Settings

Request-level settings (can also be set at collection/folder level via `request.settings.http`):

```yaml
settings:
  encodeUrl: true          # URL-encode the request URL (true | false | "inherit")
  timeout: 30000           # Timeout in ms (number | "inherit")
  followRedirects: true    # Follow HTTP redirects (true | false | "inherit")
  maxRedirects: 5          # Max redirects to follow (number | "inherit")
```

## Ordering with `seq`

Use `info.seq` to control display order in the tree view. Lower numbers appear first:

```yaml
info:
  name: First Request
  type: http
  seq: 1
```

Items without `seq` default to 999 and appear last.

## Workspace File (Optional)

To group multiple collections, create a `workspace.yml` at a parent level:

```yaml
workspace: 1.0.0
info:
  name: My API Workspace
  summary: All API collections
collections:
  - name: User Service
    path: ./user-service
  - name: Payment Service
    path: ./payment-service
```

## Complete Example — Creating a REST API Collection

Here is a step-by-step example for a typical REST API:

### 1. Create the directory structure
```
my-api/
├── collection.yml
├── Auth/
│   └── login.yml
├── Users/
│   ├── folder.yml
│   ├── list-users.yml
│   ├── get-user.yml
│   ├── create-user.yml
│   └── delete-user.yml
└── Posts/
    ├── list-posts.yml
    └── create-post.yml
```

### 2. Create `collection.yml`
```yaml
opencollection: 1.0.0
info:
  name: My REST API
  summary: Complete REST API collection
  version: 1.0.0

config:
  environments:
    - name: Local
      color: charts.blue
      variables:
        - name: base_url
          value: http://localhost:3000
        - name: username
          value: admin
        - name: password
          value: admin123
    - name: Staging
      color: charts.yellow
      variables:
        - name: base_url
          value: https://staging.api.example.com
        - secret: true
          name: username
        - secret: true
          name: password

request:
  headers:
    - name: Accept
      value: application/json
    - name: Content-Type
      value: application/json
  variables:
    - name: api_url
      value: "{{base_url}}/api/v1"
```

### 3. Create `Auth/login.yml`
```yaml
info:
  name: Login
  type: http
  seq: 1

http:
  method: POST
  url: "{{base_url}}/auth/login"
  body:
    type: json
    data: |-
      {
        "username": "{{username}}",
        "password": "{{password}}"
      }

runtime:
  assertions:
    - expression: res.status
      operator: equals
      value: "200"
  actions:
    - type: set-variable
      phase: after-response
      selector:
        expression: res.body.token
        method: jsonq
      variable:
        name: auth_token
        scope: runtime
```

### 4. Create `Users/folder.yml`
```yaml
info:
  name: Users
  type: folder

request:
  auth:
    type: bearer
    token: "{{auth_token}}"
```

### 5. Create `Users/list-users.yml`
```yaml
info:
  name: List Users
  type: http
  seq: 1

http:
  method: GET
  url: "{{api_url}}/users"
  params:
    - name: page
      value: "1"
      type: query
    - name: limit
      value: "20"
      type: query

runtime:
  auth: inherit
```

### 6. Create `Users/create-user.yml`
```yaml
info:
  name: Create User
  type: http
  seq: 3

http:
  method: POST
  url: "{{api_url}}/users"
  body:
    type: json
    data: |-
      {
        "name": "New User",
        "email": "newuser@example.com",
        "role": "member"
      }

runtime:
  auth: inherit
  assertions:
    - expression: res.status
      operator: equals
      value: "201"
```

## Validating a Collection

A validation script is included at `scripts/validate-collection.js`. It validates every YAML file in a collection directory against the OpenCollection JSON schema:

- `collection.yml` → root OpenCollection schema
- `folder.yml` → `$defs/Folder` schema
- `*.yml` request files → `$defs/HttpRequest` schema

### Running validation

```bash
node scripts/validate-collection.js <collection-directory>
```

Example:

```bash
node scripts/validate-collection.js examples/demo-api
```

Output:

```
Validating: C:\Repos\missio\examples\demo-api

  ✓ examples\demo-api\collection.yml
  ✓ examples\demo-api\Posts\create-post.yml
  ✓ examples\demo-api\Posts\folder.yml
  ✗ examples\demo-api\Tests\Get Image.yml

──────────────────────────────────────────────────
Files: 4  |  Pass: 3  |  Fail: 1

Errors:

  examples\demo-api\Tests\Get Image.yml (HttpRequest):
    /http: must NOT have additional properties
```

The script exits with code 0 if all files pass, or code 1 if any fail. **Always run validation after creating or modifying collection files.**

## Important Rules

1. **All values in YAML must be strings** — wrap numbers in quotes when they are header/param/variable values (e.g., `value: "1"`)
2. **Variable syntax is `{{variable_name}}`** — double curly braces, no spaces; use snake_case for all variable names
3. **`info.type` must be `http` for HTTP requests** and `folder` for folder.yml files
4. **Body `data` for raw types should use `|-` block scalar** to preserve formatting and avoid YAML parsing issues
5. **`collection.yml` must exist** at the root of every collection directory
6. **Auth `inherit` is a plain string**, not an object — use `auth: inherit`
7. **`seq` controls ordering** — always set it for predictable display order
8. **Round-trip safety** — never remove unknown fields from existing files; the spec allows extensions
9. **Params `type` is required** — must be `query` or `path`
10. **Headers require both `name` and `value`** — both are required fields
