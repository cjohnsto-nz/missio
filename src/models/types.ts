/**
 * Missio types — mirrors the OpenCollection v1.0.0 specification.
 * See https://spec.opencollection.com for the canonical schema.
 */

// ── Primitives ───────────────────────────────────────────────────────

export interface StructuredText {
  content: string;
  type: string;
}

export type Description = StructuredText | string | null;
export type Documentation = StructuredText | string | null;
export type Tag = string;

// ── Info ─────────────────────────────────────────────────────────────

export interface Author {
  name?: string;
  email?: string;
  url?: string;
}

export interface Info {
  name?: string;
  summary?: string;
  version?: string;
  authors?: Author[];
}

// ── Variables ────────────────────────────────────────────────────────

export type VariableValueType = 'string' | 'number' | 'boolean' | 'null' | 'object';

export interface VariableTypedValue {
  type: VariableValueType;
  data: string;
}

export type VariableValue = string | VariableTypedValue;

export interface VariableValueVariant {
  title: string;
  selected?: boolean;
  value: VariableValue;
}

export type VariableValueOrVariants = VariableValue | VariableValueVariant[];

export interface Variable {
  name: string;
  value?: VariableValueOrVariants;
  description?: Description;
  disabled?: boolean;
}

export interface SecretVariable {
  secret: true;
  name?: string;
  description?: Description;
  disabled?: boolean;
  type?: VariableValueType;
}

// ── Scripts & Assertions & Actions ──────────────────────────────────

export type ScriptType = 'before-request' | 'after-response' | 'tests' | 'hooks';

export interface Script {
  type: ScriptType;
  code: string;
}

export type Scripts = Script[];

export interface Assertion {
  expression: string;
  operator: string;
  value?: string;
  disabled?: boolean;
  description?: Description;
}

export type ActionPhase = 'before-request' | 'after-response';
export type ActionVariableScope = 'runtime' | 'request' | 'folder' | 'collection' | 'environment';

export interface SetVariableActionSelector {
  expression: string;
  method: 'jsonq';
}

export interface SetVariableActionTarget {
  name: string;
  scope: ActionVariableScope;
}

export interface ActionSetVariable {
  type: 'set-variable';
  description?: Description;
  phase?: ActionPhase;
  selector: SetVariableActionSelector;
  variable: SetVariableActionTarget;
  disabled?: boolean;
}

export type Action = ActionSetVariable;

// ── Auth ─────────────────────────────────────────────────────────────

export interface AuthBasic { type: 'basic'; username?: string; password?: string; }
export interface AuthBearer { type: 'bearer'; token?: string; }
export interface AuthDigest { type: 'digest'; username?: string; password?: string; }
export interface AuthNTLM { type: 'ntlm'; username?: string; password?: string; domain?: string; }
export interface AuthWsse { type: 'wsse'; username?: string; password?: string; }
export interface AuthApiKey { type: 'apikey'; key?: string; value?: string; placement?: 'header' | 'query'; }
export interface AuthAwsV4 {
  type: 'awsv4';
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  service?: string;
  region?: string;
  profileName?: string;
}

export interface AuthOAuth2 {
  type: 'oauth2';
  flow?: 'client_credentials' | 'password' | 'authorization_code';
  accessTokenUrl?: string;
  refreshTokenUrl?: string;
  authorizationUrl?: string;
  callbackUrl?: string;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  scope?: string;
  credentialsPlacement?: 'basic_auth_header' | 'body';
  credentialsId?: string;
  autoFetchToken?: boolean;
  autoRefreshToken?: boolean;
  pkce?: boolean;
}

export type Auth =
  | AuthBasic
  | AuthBearer
  | AuthDigest
  | AuthNTLM
  | AuthWsse
  | AuthApiKey
  | AuthAwsV4
  | AuthOAuth2
  | 'inherit';

// ── HTTP Request ─────────────────────────────────────────────────────

export interface HttpRequestHeader {
  name: string;
  value: string;
  description?: Description;
  disabled?: boolean;
}

export interface HttpResponseHeader {
  name: string;
  value: string;
}

export interface HttpRequestParam {
  name: string;
  value: string;
  description?: Description;
  type: 'query' | 'path';
  disabled?: boolean;
}

export interface RawBody { type: 'json' | 'text' | 'xml' | 'sparql'; data: string; }
export interface FormUrlEncodedEntry { name: string; value: string; description?: Description; disabled?: boolean; }
export interface FormUrlEncodedBody { type: 'form-urlencoded'; data: FormUrlEncodedEntry[]; }
export interface MultipartFormEntry { name: string; type: 'text' | 'file'; value: string | string[]; description?: Description; contentType?: string; disabled?: boolean; }
export interface MultipartFormBody { type: 'multipart-form'; data: MultipartFormEntry[]; }
export interface FileBodyVariant { filePath: string; contentType: string; selected: boolean; }
export interface FileBody { type: 'file'; data: FileBodyVariant[]; }
export type HttpRequestBody = RawBody | FormUrlEncodedBody | MultipartFormBody | FileBody;

export interface HttpRequestBodyVariant {
  title: string;
  selected?: boolean;
  body: HttpRequestBody;
}

export interface HttpRequestSettings {
  encodeUrl?: boolean | 'inherit';
  timeout?: number | 'inherit';
  followRedirects?: boolean | 'inherit';
  maxRedirects?: number | 'inherit';
}

export interface HttpRequestInfo {
  name?: string;
  description?: Description;
  type?: 'http';
  seq?: number;
  tags?: Tag[];
}

export interface HttpRequestDetails {
  method?: string;
  url?: string;
  headers?: HttpRequestHeader[];
  params?: HttpRequestParam[];
  body?: HttpRequestBody | HttpRequestBodyVariant[];
  auth?: Auth;
}

export interface HttpRequestRuntime {
  variables?: Variable[];
  scripts?: Scripts;
  assertions?: Assertion[];
  actions?: Action[];
}

export interface HttpRequestExample {
  name?: string;
  description?: Description;
  request?: {
    url?: string;
    method?: string;
    headers?: HttpRequestHeader[];
    params?: HttpRequestParam[];
    body?: HttpRequestBody;
  };
  response?: {
    status?: number;
    statusText?: string;
    headers?: HttpResponseHeader[];
    body?: { type: 'json' | 'text' | 'xml' | 'html' | 'binary'; data: string; };
  };
}

export interface HttpRequest {
  info?: HttpRequestInfo;
  http?: HttpRequestDetails;
  runtime?: HttpRequestRuntime;
  settings?: HttpRequestSettings;
  examples?: HttpRequestExample[];
  docs?: string;
}

// ── Request Defaults ─────────────────────────────────────────────────

export interface RequestDefaults {
  headers?: HttpRequestHeader[];
  auth?: Auth;
  variables?: Variable[];
  scripts?: Scripts;
  settings?: { http?: HttpRequestSettings };
}

// ── Certificates ─────────────────────────────────────────────────────

export interface PemCertificate { domain: string; type: 'pem'; certificateFilePath: string; privateKeyFilePath: string; passphrase?: string; }
export interface Pkcs12Certificate { domain: string; type: 'pkcs12'; pkcs12FilePath: string; passphrase?: string; }
export type ClientCertificate = PemCertificate | Pkcs12Certificate;

// ── Proxy ────────────────────────────────────────────────────────────

export interface ProxyConnectionConfig {
  protocol?: string;
  hostname?: string;
  port?: number;
  auth?: { disabled?: boolean; username?: string; password?: string };
  bypassProxy?: string;
}

export interface Proxy {
  disabled?: boolean;
  inherit?: boolean;
  config?: ProxyConnectionConfig;
}

// ── Environments ─────────────────────────────────────────────────────

export interface Environment {
  name: string;
  color?: string;
  description?: Description;
  variables?: (Variable | SecretVariable)[];
  clientCertificates?: ClientCertificate[];
  extends?: string;
  dotEnvFilePath?: string;
}

// ── Collection Config ────────────────────────────────────────────────

export interface CollectionConfig {
  environments?: Environment[];
  proxy?: Proxy;
  clientCertificates?: ClientCertificate[];
  secretProviders?: SecretProvider[];
}

// ── Folder ───────────────────────────────────────────────────────────

export interface FolderInfo {
  name?: string;
  description?: Description;
  type?: 'folder';
  seq?: number;
  tags?: Tag[];
}

export interface Folder {
  info?: FolderInfo;
  items?: Item[];
  request?: RequestDefaults;
  docs?: Documentation;
}

// ── Item (union) ─────────────────────────────────────────────────────

export type Item = HttpRequest | Folder;

// ── Extensions ───────────────────────────────────────────────────────

export type Extensions = Record<string, unknown>;

// ── Root OpenCollection ──────────────────────────────────────────────

export interface OpenCollection {
  opencollection?: string;
  info?: Info;
  config?: CollectionConfig;
  items?: Item[];
  request?: RequestDefaults;
  docs?: Documentation;
  bundled?: boolean;
  extensions?: Extensions;
}

// ── Workspace ────────────────────────────────────────────────────────

export interface WorkspaceCollectionRef {
  name: string;
  path: string;
}

export interface WorkspaceInfo {
  name?: string;
  summary?: string;
  version?: string;
  links?: { name: string; url: string }[];
}

export interface OpenCollectionWorkspace {
  workspace?: string;
  info?: WorkspaceInfo;
  collections: WorkspaceCollectionRef[];
}

// ── Missio-specific runtime types ────────────────────────────────────

export interface MissioCollection {
  id: string;
  filePath: string;
  rootDir: string;
  data: OpenCollection;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  duration: number;
  size: number;
}

export interface SecretProvider {
  name: string;
  type: 'azure-keyvault';
  url: string;  // supports {{var}} interpolation, e.g. "https://{{vault-name}}.vault.azure.net"
  disabled?: boolean;
}
