import type { StreamExecutionEvent } from './events.js';

export type RunMode = 'auto' | 'cloud' | 'extension';

export interface CloudFile {
  displayName: string;
  uri: string;
  mimeType: string;
}

export interface WebhookAuthBearer {
  type: 'bearer';
  token: string;
}

export interface WebhookAuthBasic {
  type: 'basic';
  username: string;
  password: string;
}

export type WebhookAuth = WebhookAuthBearer | WebhookAuthBasic;

export interface WebhookSubscription {
  url: string;
  events?: string[];
  auth?: WebhookAuth;
  secret?: string;
}

export interface ExecutionControls {
  /** Include tool output in progress events; the full final response is unaffected. */
  includeEventOutput?: boolean;
  /** Aborting explicitly cancels a cloud run, with a bounded acknowledgement wait. */
  signal?: AbortSignal;
  /** Observers run sequentially; a returned promise shares the run's abort/deadline. */
  onEvent?: (event: StreamExecutionEvent, signal: AbortSignal) => unknown;
}

export interface AgentRequest extends ExecutionControls {
  input: string;
  /** Analytics-only product origin. It never changes authorization or routing. */
  clientSurface?: 'cli';
  urls?: string[];
  schema?: Record<string, unknown>;
  files?: CloudFile[];
  dataInputs?: unknown[];
  settings?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  options?: Record<string, unknown>;
  response?: {
    verbosity?: 'final' | 'steps' | 'debug';
    inlineOutputMaxBytes?: number;
  };
  webhooks?: WebhookSubscription[];
  trajectoryId?: string;
  phase?: number;
  recordingContext?: string;
  authToken?: string;
}

export interface ScrapeRequest extends ExecutionControls {
  urls: string[];
  settings?: Record<string, unknown>;
  options?: Record<string, unknown>;
  response?: {
    inlineOutputMaxBytes?: number;
  };
  webhooks?: WebhookSubscription[];
  trajectoryId?: string;
  authToken?: string;
}

export interface UnifiedScrapeRequest extends ScrapeRequest {
  target?: RunMode;
  preferExtension?: boolean;
  requireLocalSession?: boolean;
  deviceId?: string;
}

export interface ExtensionPlannerRequest extends ExecutionControls {
  input: string;
  /** Analytics-only product origin. It never changes authorization or routing. */
  clientSurface?: 'cli';
  urls?: string[];
  schema?: Record<string, unknown>;
  fileUrls?: string[];
  deviceId?: string;
  params?: Record<string, unknown>;
}

export interface ToolRequest {
  signal?: AbortSignal;
  tool: string;
  params?: Record<string, unknown>;
  deviceId?: string;
}

export interface UnifiedRunRequest extends ExecutionControls {
  input: string;
  /** Analytics-only product origin. It never changes authorization or routing. */
  clientSurface?: 'cli';
  urls?: string[];
  schema?: Record<string, unknown>;
  files?: CloudFile[];
  fileUrls?: string[];
  dataInputs?: unknown[];
  settings?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  options?: Record<string, unknown>;
  response?: {
    verbosity?: 'final' | 'steps' | 'debug';
    inlineOutputMaxBytes?: number;
  };
  webhooks?: WebhookSubscription[];
  trajectoryId?: string;
  phase?: number;
  recordingContext?: string;
  authToken?: string;

  target?: RunMode;
  preferExtension?: boolean;
  requireLocalSession?: boolean;
  deviceId?: string;
  extensionTool?: string;
  extensionParams?: Record<string, unknown>;
}

/**
 * Routing decision reported with every unified run/scrape response. It describes the request
 * that actually left the client, not just the caller's preference.
 */
export interface RunMetadata {
  /** Mode that executed the request. Never `auto`. */
  selectedMode: Exclude<RunMode, 'auto'>;
  /** Mode the caller asked for (explicit `target`, or the client's default). */
  requestedMode: RunMode;
  /**
   * True only when the client re-routed away from the mode it had already selected:
   * an extension device lost during execution (auto mode), or a backend that resolved the
   * `scrape` tool to `cloud_scrape`. An explicit `target` is never changed, and a plain
   * "no device online" selection in auto mode is not a fallback.
   */
  fallbackApplied: boolean;
  /** Why the request ended up in `selectedMode`; set whenever a fallback occurred. */
  fallbackReason?: string;
  /** Extension device the request was routed to, when one was selected. */
  deviceId?: string;
  /** Server request id of the response that produced `data`. */
  requestId?: string;
  /** Transport attempt that produced `data` (retries included). */
  attempt?: number;
}


export interface UnifiedRunResponse<T = unknown> {
  metadata: RunMetadata;
  data: T;
}

export type UnifiedScrapeResponse<T = unknown> = UnifiedRunResponse<T>;

export interface DeviceInfo {
  deviceId: string;
  deviceName?: string;
  lastSeen?: string;
  hasFcmToken?: boolean;
}

export interface DeviceListResult {
  online: boolean;
  deviceCount: number;
  devices: DeviceInfo[];
}

export interface ClientOptions {
  apiKey: string;
  cloudBaseUrl?: string;
  mcpBaseUrl?: string;
  controlBaseUrl?: string;
  timeoutMs?: number;
  retryPolicy?: RetryPolicy;
  defaultTarget?: RunMode;
  preferExtensionByDefault?: boolean;
  defaultHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export interface RetryPolicy {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retriableStatusCodes?: number[];
}

export interface CliProfileResponse {
  [key: string]: unknown;
}

export interface CliCapabilitiesResponse {
  [key: string]: unknown;
}
