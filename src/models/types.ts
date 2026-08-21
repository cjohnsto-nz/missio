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

export type RuntimePhase = 'before-request' | 'after-response' | 'tests' | 'assertions' | 'actions';
export type RuntimeLogLevel = 'log' | 'info' | 'warn' | 'error';

export interface RuntimeLogEntry {
  phase: RuntimePhase;
  level: RuntimeLogLevel;
  message: string;
}

export interface RuntimeTestResult {
  name: string;
  passed: boolean;
  message?: string;
  duration?: number;
}

export interface RuntimeAssertionResult {
  expression: string;
  operator: string;
  expected?: unknown;
  actual?: unknown;
  passed: boolean;
  skipped?: boolean;
  description?: string;
  message?: string;
}

export interface RuntimeActionResult {
  type: Action['type'];
  phase: ActionPhase;
  target?: string;
  value?: unknown;
  passed: boolean;
  skipped?: boolean;
  message?: string;
}

export interface RuntimeVariableMutation {
  scope: ActionVariableScope;
  name: string;
  value: string;
  source: 'script' | 'action';
}

export interface RuntimeErrorDiagnostic {
  phase: RuntimePhase;
  message: string;
  scriptType?: ScriptType;
  stack?: string;
}

export interface RuntimeExecutionSummary {
  passed: number;
  failed: number;
  skipped: number;
}

export interface RuntimeExecutionResult {
  success: boolean;
  summary: RuntimeExecutionSummary;
  logs: RuntimeLogEntry[];
  tests: RuntimeTestResult[];
  assertions: RuntimeAssertionResult[];
  actions: RuntimeActionResult[];
  variableMutations: RuntimeVariableMutation[];
  errors: RuntimeErrorDiagnostic[];
}

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

export interface AuthCliCache {
  enabled?: boolean;
  ttlSeconds?: number;
}

export interface AuthCli {
  type: 'cli';
  command: string;
  tokenHeader?: string;
  tokenPrefix?: string;
  cache?: AuthCliCache;
}

export interface OAuth2Credentials {
  clientId?: string;
  clientSecret?: string;
  placement?: 'basic_auth_header' | 'body';
}

export interface OAuth2ResourceOwner {
  username?: string;
  password?: string;
}

export interface OAuth2PKCE {
  enabled?: boolean;
  method?: 'S256' | 'plain';
}

export interface OAuth2Settings {
  autoFetchToken?: boolean;
  autoRefreshToken?: boolean;
}

export interface AuthOAuth2Base {
  type: 'oauth2';
  accessTokenUrl?: string;
  refreshTokenUrl?: string;
  scope?: string;
  credentials?: OAuth2Credentials;
  settings?: OAuth2Settings;
  credentialsId?: string;
}

export interface AuthOAuth2ClientCredentials extends AuthOAuth2Base {
  flow: 'client_credentials';
}

export interface AuthOAuth2ResourceOwnerPassword extends AuthOAuth2Base {
  flow: 'resource_owner_password_credentials';
  resourceOwner?: OAuth2ResourceOwner;
}

export interface AuthOAuth2AuthorizationCode extends AuthOAuth2Base {
  flow: 'authorization_code';
  authorizationUrl?: string;
  callbackUrl?: string;
  pkce?: OAuth2PKCE;
}

export type AuthOAuth2 =
  | AuthOAuth2ClientCredentials
  | AuthOAuth2ResourceOwnerPassword
  | AuthOAuth2AuthorizationCode;

export type Auth =
  | AuthBasic
  | AuthBearer
  | AuthDigest
  | AuthNTLM
  | AuthWsse
  | AuthApiKey
  | AuthAwsV4
  | AuthCli
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

export interface RawBody { type: 'json' | 'text' | 'xml' | 'html' | 'yaml' | 'sparql'; data: string; }
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
}

export interface HttpRequestRuntime {
  variables?: Variable[];
  scripts?: Scripts;
  assertions?: Assertion[];
  actions?: Action[];
  auth?: Auth;
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

// ── GraphQL Request ──────────────────────────────────────────────────

export interface GraphQLBody {
  query?: string;
  variables?: string;
}

export interface GraphQLBodyVariant {
  title: string;
  selected?: boolean;
  body: GraphQLBody;
}

export interface GraphQLRequestSettings {
  encodeUrl?: boolean | 'inherit';
  timeout?: number | 'inherit';
  followRedirects?: boolean | 'inherit';
  maxRedirects?: number | 'inherit';
}

export interface GraphQLRequestInfo {
  name?: string;
  description?: Description;
  type?: 'graphql';
  seq?: number;
  tags?: Tag[];
}

export interface GraphQLRequestDetails {
  method?: string;
  url?: string;
  headers?: HttpRequestHeader[];
  params?: HttpRequestParam[];
  body?: GraphQLBody | GraphQLBodyVariant[];
}

export interface GraphQLRequestRuntime {
  variables?: Variable[];
  scripts?: Scripts;
  assertions?: Assertion[];
  actions?: Action[];
  auth?: Auth;
}

export interface GraphQLRequest {
  info?: GraphQLRequestInfo;
  graphql?: GraphQLRequestDetails;
  runtime?: GraphQLRequestRuntime;
  settings?: GraphQLRequestSettings;
  docs?: string;
}

// ── gRPC Request ─────────────────────────────────────────────────────

export interface GrpcMetadata {
  name: string;
  value: string;
  description?: Description;
  disabled?: boolean;
}

export interface GrpcRequestMessage {
  description?: Description;
  message: string;
}

export type GrpcMessage = string;

export interface GrpcMessageVariant {
  title: string;
  selected?: boolean;
  message: GrpcMessage;
}

export type GrpcMethodType = 'unary' | 'client-streaming' | 'server-streaming' | 'bidi-streaming';

export interface GrpcRequestInfo {
  name?: string;
  description?: Description;
  type?: 'grpc';
  seq?: number;
  tags?: Tag[];
}

export interface GrpcRequestDetails {
  url?: string;
  method?: string;
  methodType?: GrpcMethodType;
  protoFilePath?: string;
  metadata?: GrpcMetadata[];
  message?: GrpcMessage | GrpcMessageVariant[] | GrpcRequestMessage[];
}

export interface GrpcRequestRuntime {
  variables?: Variable[];
  scripts?: Scripts;
  assertions?: Assertion[];
  auth?: Auth;
}

export interface GrpcRequest {
  info?: GrpcRequestInfo;
  grpc?: GrpcRequestDetails;
  runtime?: GrpcRequestRuntime;
  docs?: string;
}

// ── WebSocket Request ────────────────────────────────────────────────

export type WebSocketMessageType = 'text' | 'json' | 'xml' | 'binary';

export interface WebSocketMessage {
  type: WebSocketMessageType;
  data: string;
}

export interface WebSocketMessageVariant {
  title: string;
  selected?: boolean;
  message: WebSocketMessage;
}

export interface WebSocketRequestInfo {
  name?: string;
  description?: Description;
  type?: 'websocket';
  seq?: number;
  tags?: Tag[];
}

export interface WebSocketRequestDetails {
  url?: string;
  headers?: HttpRequestHeader[];
  message?: WebSocketMessage | WebSocketMessageVariant[];
}

export interface WebSocketRequestRuntime {
  variables?: Variable[];
  scripts?: Scripts;
  auth?: Auth;
}

export interface WebSocketRequest {
  info?: WebSocketRequestInfo;
  websocket?: WebSocketRequestDetails;
  runtime?: WebSocketRequestRuntime;
  docs?: string;
}

// ── Request Defaults ─────────────────────────────────────────────────

export interface RequestDefaults {
  headers?: HttpRequestHeader[];
  metadata?: GrpcMetadata[];
  auth?: Auth;
  variables?: Variable[];
  scripts?: Scripts;
  settings?: { http?: HttpRequestSettings; graphql?: GraphQLRequestSettings };
}

// ── Certificates ─────────────────────────────────────────────────────

export interface PemCertificate { domain: string; type: 'pem'; certificateFilePath: string; privateKeyFilePath: string; passphrase?: string; }
export interface Pkcs12Certificate { domain: string; type: 'pkcs12'; pkcs12FilePath: string; passphrase?: string; }
export type ClientCertificate = PemCertificate | Pkcs12Certificate;

// ── Protobuf ─────────────────────────────────────────────────────────

export interface ProtoFile {
  type: 'file';
  path: string;
}

export type ProtoFileItem = ProtoFile;

export interface ProtoFileImportPath {
  path: string;
  disabled?: boolean;
}

export interface ProtobufConfig {
  protoFiles?: ProtoFileItem[];
  importPaths?: ProtoFileImportPath[];
}

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
  protobuf?: ProtobufConfig;
  proxy?: Proxy;
  clientCertificates?: ClientCertificate[];
  secretProviders?: SecretProvider[];
  /** When true, all requests use collection-level auth, ignoring request and folder auth. */
  forceAuthInherit?: boolean;
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
  items?: OpenCollectionItem[];
  request?: RequestDefaults;
  docs?: Documentation;
}

// ── Script File ──────────────────────────────────────────────────────

export interface ScriptFile {
  type: 'script';
  script: string;
}

// ── Item (union) and type guards ─────────────────────────────────────

export type OpenCollectionRequest = HttpRequest | GraphQLRequest | GrpcRequest | WebSocketRequest;
export type OpenCollectionItem = OpenCollectionRequest | Folder | ScriptFile;
export type RequestFileItem = OpenCollectionRequest | ScriptFile;
export type Item = OpenCollectionItem;
export type RequestProtocol = 'http' | 'graphql' | 'grpc' | 'websocket';
export type OpenCollectionItemKind = RequestProtocol | 'folder' | 'script' | 'unknown';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasObjectKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key) && isRecord(value[key]);
}

export function isHttpRequest(item: unknown): item is HttpRequest {
  if (!isRecord(item)) return false;
  return (isRecord(item.info) && item.info.type === 'http') || hasObjectKey(item, 'http');
}

export function isGraphQLRequest(item: unknown): item is GraphQLRequest {
  if (!isRecord(item)) return false;
  return (isRecord(item.info) && item.info.type === 'graphql') || hasObjectKey(item, 'graphql');
}

export function isGrpcRequest(item: unknown): item is GrpcRequest {
  if (!isRecord(item)) return false;
  return (isRecord(item.info) && item.info.type === 'grpc') || hasObjectKey(item, 'grpc');
}

export function isWebSocketRequest(item: unknown): item is WebSocketRequest {
  if (!isRecord(item)) return false;
  return (isRecord(item.info) && item.info.type === 'websocket') || hasObjectKey(item, 'websocket');
}

export function isFolder(item: unknown): item is Folder {
  if (!isRecord(item)) return false;
  return (isRecord(item.info) && item.info.type === 'folder')
    || Array.isArray(item.items)
    || (hasObjectKey(item, 'request') && !isHttpRequest(item) && !isGraphQLRequest(item) && !isGrpcRequest(item) && !isWebSocketRequest(item));
}

export function isScriptFile(item: unknown): item is ScriptFile {
  return isRecord(item) && item.type === 'script' && typeof item.script === 'string';
}

export function isProtocolRequest(item: unknown): item is OpenCollectionRequest {
  return isHttpRequest(item) || isGraphQLRequest(item) || isGrpcRequest(item) || isWebSocketRequest(item);
}

export function getItemKind(item: unknown): OpenCollectionItemKind {
  if (isHttpRequest(item)) return 'http';
  if (isGraphQLRequest(item)) return 'graphql';
  if (isGrpcRequest(item)) return 'grpc';
  if (isWebSocketRequest(item)) return 'websocket';
  if (isFolder(item)) return 'folder';
  if (isScriptFile(item)) return 'script';
  return 'unknown';
}

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
  /** Base64-encoded body for binary content types (images, PDF, etc.) */
  bodyBase64?: string;
  duration: number;
  size: number;
  runtime?: RuntimeExecutionResult;
  timing?: { label: string; start: number; end: number }[];
}

export interface SecretProvider {
  name: string;
  type: 'azure-keyvault';
  namespace: string;  // vault name, supports {{var}} interpolation, e.g. "{{vault-name}}" or "my-vault"
  subscription?: string;  // Azure subscription ID or name (for cross-subscription vaults)
  disabled?: boolean;
}
