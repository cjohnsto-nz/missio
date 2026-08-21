# OC-050 Auth, Proxy, mTLS, And Transport Completion

## Goal

Close schema-native auth and transport gaps for HTTP-compatible protocols while keeping Missio extensions explicit.

## Current Support

| Supported | Notes |
| --- | --- |
| Basic auth | Applies `Authorization: Basic ...`. |
| Bearer auth | Applies `Authorization: Bearer ...`. |
| API key header | Applies configured header. |
| CLI token | Missio extension, supports approval and cache. |
| OAuth2 client credentials | Implemented. |
| OAuth2 resource-owner password | Implemented. |
| OAuth2 authorization code with PKCE | Implemented but not all schema fields are honored. |

## Missing Or Incomplete

| Feature | Gap |
| --- | --- |
| API key query placement | Code comments note it is not mutating URL. |
| Digest auth | Modeled but not implemented. |
| NTLM auth | Modeled but not implemented. |
| WSSE auth | Modeled but not implemented. |
| AWS SigV4 | Modeled but not implemented. |
| OAuth2 implicit | In schema, absent from model and service. |
| OAuth2 token placement | Schema supports header/query placement; service always uses bearer header. |
| OAuth2 additional parameters | Authorization/token request params are ignored. |
| PKCE method | Schema has method; service always uses S256 when enabled. |
| Proxy | Schema has `enabled`, `inherit`, config, auth, bypass; execution ignores proxy. |
| Client certificates | Schema has collection/environment mTLS; execution ignores it. |
| Redirects | Settings are read but Node transport does not follow redirects. |
| URL encoding | Setting is read but not consistently applied. |

## Implementation Plan

1. Fix small HTTP-only issues first:

| Item | Work |
| --- | --- |
| API key query | Mutate final URL before request execution and exports. |
| Redirects | Implement bounded redirects using `followRedirects` and `maxRedirects`. |
| URL encoding | Define and test behavior for `encodeUrl`. |

2. Add OAuth2 schema completeness:

| Field | Work |
| --- | --- |
| `tokenConfig.placement` | Place token in configured header or query param. |
| `additionalParameters` | Apply authorization/token params by placement. |
| `pkce.method` | Support `S256` and `plain`. |
| `callbackUrl` | Honor configured callback when feasible; otherwise document local callback behavior. |
| `implicit` | Either implement with browser callback fragment handling or explicitly mark unsupported with validation/UI diagnostics. |

3. Add auth implementations or explicit staged diagnostics for digest, NTLM, WSSE, AWS SigV4.
4. Add proxy agent support and bypass rules.
5. Add client certificate selection by request host:

| Source | Precedence |
| --- | --- |
| Environment certificates | Highest when active environment defines a matching domain. |
| Collection certificates | Fallback by matching domain. |

6. Cover GraphQL and WebSocket where their protocols use HTTP headers/handshakes.

## Acceptance Criteria

| Requirement | Acceptance |
| --- | --- |
| API key query | Request URL contains key/value, and export/dry-run reflect it. |
| Redirects | 3xx redirects follow or stop according to settings. |
| Proxy | HTTP request can route through local proxy test server. |
| mTLS | HTTPS request can present configured client certificate. |
| OAuth2 | Token placement and additional params are honored. |
| Unsupported auth | Any unimplemented schema auth shows a clear diagnostic instead of silent no-op. |

## Suggested Tests

| Test | Expected Result |
| --- | --- |
| API key query auth. | Server receives query param. |
| Redirect chain with max 1. | Stops after one redirect with clear error/status. |
| Proxy with basic auth. | Proxy receives authenticated request. |
| mTLS fixture. | Server verifies client certificate. |
| OAuth2 query token placement. | Resource URL contains token param. |

