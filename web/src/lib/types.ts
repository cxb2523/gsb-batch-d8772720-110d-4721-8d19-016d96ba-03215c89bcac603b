// Shapes returned by the local API (see src/mecha/core/serialize.py). No secrets, ever.

export type Overall = 'green' | 'amber' | 'red' | 'grey' | 'local'
export type Source = 'api' | 'header' | 'jwt' | 'file' | 'manual' | 'inferred'
export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'xai' | 'openrouter'
export type Kind = 'api_key' | 'admin_key' | 'management_key' | 'oauth_token' | 'oauth_file'

export interface Signal<T> {
  value: T
  source: Source
  observed_at: string
}

export interface Credential {
  id: string
  label: string
  provider: ProviderId
  kind: Kind
  redacted: string
  fingerprint: string
  tags: string[]
  notes: string | null
  linked_path: string | null
  manual_expires_at: string | null
  created_at: string
  token_expires_at: string | null
  subscription_until: string | null
  retiring: boolean
  active_probe: boolean
  parent_id: string | null
  manual_budget: { amount: string; currency: string; purchased_at: string } | null
  facts?: {
    funds?: { scope: string | null; by: string | null } | null
    /** Last `mecha scan` that found this key in plaintext (locations: `api.exposures`). */
    exposure?: { risky: number; info: number; scanned_at: string } | null
  }
}

export interface RateWindow {
  limit: number | null
  remaining: number | null
  reset: string | null
}

export interface CheckResult {
  credential_id: string
  checked_at: string
  mode: 'offline' | 'passive' | 'active' | 'enrich'
  check_status: 'not_checked' | 'failed' | 'ok'
  overall: Overall
  reasons: { code: string; overall: Overall }[]
  validity: Signal<string>
  funds: Signal<{ state: string; amount: string | null; currency: string | null }>
  expiry: Signal<{ state: string; expires_at: string | null }>
  limits: Signal<{ state: string; requests: RateWindow | null; tokens: RateWindow | null }> | null
  funds_info: Signal<{ amount: string; currency: string; until: string; estimated: boolean }> | null
  last_used_at: Signal<string> | null
  account: Record<string, Signal<string>>
  http: {
    endpoint: string
    status: number | null
    latency_ms: number | null
    headers: Record<string, string>
  } | null
  error: { code: string; message: string } | null
}

export interface CredentialStatus {
  credential: Credential
  result: CheckResult
  cached: boolean
  last_known: { overall: Overall; checked_at: string } | null
  probe_next_at: string | null
}

export interface DisplaySettings {
  soon_days: number
  fuse_horizon_days: number
}

export const DEFAULT_SETTINGS: DisplaySettings = { soon_days: 14, fuse_horizon_days: 90 }

export interface Listing {
  schema_version: number
  generated_at: string
  demo: boolean
  settings: DisplaySettings
  credentials: CredentialStatus[]
  /** Event position the listing was computed at (absent in the web demo). */
  events?: { boot: string; seq: number }
}

export interface Detection {
  format: 'prefix' | 'regex' | 'jwt' | 'session_file' | 'unknown'
  provider: ProviderId | null
  kind: Kind | null
  label: string | null
  verified: boolean
  ambiguous: boolean
  candidates: ProviderId[]
  storable: boolean
  retiring: boolean
  redacted: string
  warnings: string[]
}

export type Capability =
  | 'yes'
  | 'no'
  | 'error_only'
  | 'admin_key'
  | 'management_key'
  | 'admin_estimate'

export interface ProbeInfo {
  model: string
  input_tokens: number
  output_tokens: number
  usd_per_probe: string
  usd_per_month: string
  usd_per_month_label: string
  interval_hours: number
  prices_checked: string
}

export interface ProviderInfo {
  id: ProviderId
  name: string
  validate: Capability
  funds: Capability
  expiry: Capability
  kinds: Kind[]
  probe: ProbeInfo | null
}

export interface EnvEntry {
  index: number
  line: number
  name: string
  redacted: string
  provider: ProviderId | null
  kind: Kind | null
  ambiguous: boolean
  duplicate_of: string | null
  importable: boolean
}

export interface LinkCandidate {
  tool: 'codex' | 'claude-code' | 'gemini-cli'
  path: string
  exists: boolean
}

export const OVERALL_ORDER: Overall[] = ['red', 'amber', 'grey', 'local', 'green']

// --- mecha scan ------------------------------------------------------------------------

export type Risk =
  | 'shell_history'
  | 'notebook'
  | 'git_tracked'
  | 'git_not_ignored'
  | 'synced_folder'
  | 'readable_by_others'

/** A key found in plaintext: where and what (redacted), never the key or the line. */
export interface ScanFinding {
  id: string
  path: string
  line: number
  cell_line: number | null
  column: number
  provider: ProviderId | null
  kind: Kind | null
  redacted: string
  name: string | null
  confidence: 'high' | 'low'
  severity: 'amber' | 'info'
  risks: Risk[]
  notes: string[]
  stored_id: string | null
  session_file: string | null
  importable: boolean
  not_importable: string | null
  check: string | null
}

export interface ScanReport {
  home: string
  roots: string[]
  store_checked: boolean
  warnings: string[]
  files_scanned: number
  skipped: Record<string, number>
  finished_at: string | null
  expires_at: string | null
  findings: ScanFinding[]
}

export interface ScanState {
  running: boolean
  /** macOS: Desktop, Documents, Downloads and cloud folders need explicit consent. */
  protected_option: boolean
  report: ScanReport | null
}

export interface ScanImportResult {
  id: string
  ok: boolean
  credential_id?: string
  code?: string
  message?: string
}

export interface Exposure {
  path: string
  line: number
  cell_line: number | null
  column: number
  risks: Risk[]
  seen_at: string
}

export interface Exposures {
  home: string
  scanned_at: string | null
  exposures: Exposure[]
}
