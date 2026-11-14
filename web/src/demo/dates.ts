/**
 * The dump has a fixed "now" (`generated_at`). On load, one offset — browser now minus
 * `generated_at` — is added to every date field in it, `generated_at` included, so the
 * demo always looks the same: "checked 3 minutes ago", "expires in 12 days".
 *
 * Exception: fields that are real-world dates, not demo times (the price table's date).
 */
export const NOT_SHIFTED = new Set(['prices_checked'])

const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export function isDateString(value: unknown): value is string {
  return typeof value === 'string' && DATE.test(value)
}

export function shiftDate(value: string, offsetMs: number): string {
  if (DATE_ONLY.test(value)) {
    return new Date(Date.parse(`${value}T00:00:00Z`) + offsetMs).toISOString().slice(0, 10)
  }
  return new Date(Date.parse(value) + offsetMs).toISOString()
}

export function offsetFor(generatedAt: string, now: number = Date.now()): number {
  return now - Date.parse(generatedAt)
}

/** A deep copy of `value` with every date field shifted by `offsetMs`. */
export function shiftDates<T>(value: T, offsetMs: number, key?: string): T {
  if (Array.isArray(value)) return value.map((v) => shiftDates(v, offsetMs, key)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = shiftDates(v, offsetMs, k)
    return out as T
  }
  if (isDateString(value) && !(key && NOT_SHIFTED.has(key))) {
    return shiftDate(value, offsetMs) as T
  }
  return value
}
