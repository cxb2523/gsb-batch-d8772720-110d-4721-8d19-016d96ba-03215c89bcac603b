import type {
  CheckResult,
  CredentialStatus,
  Exposures,
  Kind,
  Listing,
  ProviderInfo,
  ScanImportResult,
  ScanState,
} from '@/lib/types'
import raw from './data.json'
import { offsetFor, shiftDates } from './dates'

/** An API answer recorded from `mecha serve --demo` by scripts/dump_demo.py. */
export interface Answer {
  status: number
  body: unknown
}

export interface Sample {
  id: string
  label: string
  provider: string
  kind: Kind
  redacted: string
  added: CredentialStatus
  check: Answer
  probe: Answer
}

/** What importing one finding of the demo's scan adds (and how its checks answer). */
export interface ScanImport {
  result: ScanImportResult
  added: CredentialStatus
  check: Answer
  probe: Answer
  /** Where it was found: importing keeps the scan's locations. */
  exposures: Exposures
}

export interface DemoData {
  generated_at: string
  /** The demo's fixed scan of a made-up home folder (never this machine's). */
  scan: ScanState
  scan_imports: Record<string, ScanImport>
  exposures: Record<string, Exposures>
  listing: Listing
  providers: { providers: ProviderInfo[] }
  history: Record<string, CheckResult[]>
  check: Record<string, Answer>
  probe: Record<string, Answer>
  samples: Sample[]
}

export const RAW = raw as unknown as DemoData

/** The dump with all its dates moved to "now" (one offset for every field). */
export function loadDemoData(now: number = Date.now()): DemoData {
  return shiftDates(RAW, offsetFor(RAW.generated_at, now))
}
