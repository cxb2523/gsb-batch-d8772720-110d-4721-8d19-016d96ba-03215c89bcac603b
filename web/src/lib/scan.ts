/**
 * Query keys of the scan tab that the event stream feeds (Dashboard): kept apart from the
 * tab itself so the main bundle does not load it.
 */
export const SCAN_KEY = ['scan'] as const
export const SCAN_PROGRESS_KEY = ['scan-progress'] as const

export interface ScanProgress {
  files: number
  outcome: 'running' | 'done' | 'cancelled' | 'failed'
}
