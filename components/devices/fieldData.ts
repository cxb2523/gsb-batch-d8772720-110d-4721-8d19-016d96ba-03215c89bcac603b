/*
 * Per-field measurement collection.
 *
 * The device detail page collects three fields (Humidity, Pressure,
 * Temperature) independently: each field gets its own
 * `/api/devices/{deviceId}/measurements` request, its own success/error
 * state, and can be retried without touching the other fields.
 *
 * `FieldDataCollector` is framework-agnostic (no React imports) so the
 * stale-result / retry logic can be exercised directly in node:test.
 * It keeps two monotonic counters:
 *
 *  - sessionId: bumped (and all previous results discarded) whenever the
 *    device changes, so an in-flight response for the old device can
 *    never be rendered for the new one.
 *  - per-field requestId: bumped on every request for that field, so
 *    when the same field is triggered more than once only the result of
 *    the last request is kept.
 */

export const FIELDS = ['Humidity', 'Pressure', 'Temperature'] as const
export type FieldName = (typeof FIELDS)[number]

export type FieldStatus = 'idle' | 'loading' | 'success' | 'error'

export interface FieldState {
  status: FieldStatus
  /* CSV payload returned by the measurements endpoint (empty until success) */
  csv: string
  /* Human-readable failure message; always names the field. */
  error: string | null
}

export type FieldDataState = Record<FieldName, FieldState>

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export function initialFieldState(): FieldDataState {
  const state = {} as FieldDataState
  for (const field of FIELDS) {
    state[field] = { status: 'idle', csv: '', error: null }
  }
  return state
}

/* Builds the Flux query for one field of one device (same shape as before). */
export function buildMeasurementsQuery(deviceId: string, field: string): string {
  return `from(bucket: "${process.env.NEXT_PUBLIC_INFLUX_BUCKET}")
         |> range(start: -60d)
         |> filter(fn: (r) => r._measurement == "environment" and r.device == "${deviceId}" )
         |> filter(fn: (r) => r._field == "${field}" )
         |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)
         |> yield(name: "mean")
         `
}

export class FieldDataCollector {
  private state: FieldDataState
  /* Every device switch gets a fresh session; older sessions are ignored. */
  private sessionId = 0
  /* Last request per field; superseded requests are ignored. */
  private requestIds: Record<FieldName, number>
  private readonly onChange: (state: FieldDataState) => void
  private readonly fetchImpl: FetchLike

  constructor(
    onChange: (state: FieldDataState) => void,
    fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  ) {
    this.onChange = onChange
    this.fetchImpl = fetchImpl
    this.state = initialFieldState()
    this.requestIds = { Humidity: 0, Pressure: 0, Temperature: 0 }
  }

  getState(): FieldDataState {
    return this.state
  }

  /*
   * Forget every result produced before this call. Used when the device
   * changes (and on unmount): in-flight responses of the previous device
   * complete on the network but their callbacks become no-ops.
   */
  invalidateSession(): void {
    this.sessionId += 1
    this.requestIds = { Humidity: 0, Pressure: 0, Temperature: 0 }
    this.state = initialFieldState()
    this.emit()
  }

  /* Re-request every field for the given device. */
  collectAll(deviceId: string): void {
    for (const field of FIELDS) {
      this.collectField(deviceId, field)
    }
  }

  /*
   * Request a single field. Retries go through the same path, so a retry
   * only affects this field: the other fields are never requested again.
   */
  collectField(deviceId: string, field: FieldName): void {
    const sessionId = this.sessionId
    const requestId = this.requestIds[field] + 1
    this.requestIds[field] = requestId

    this.patch(field, { status: 'loading', error: null })

    const query = buildMeasurementsQuery(deviceId, field)
    this.fetchImpl(`/api/devices/${deviceId}/measurements`, {
      method: 'POST',
      headers: { Accept: 'application/csv', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`measurements request failed: ${res.status} ${res.statusText}`.trim())
        }
        return res.text()
      })
      .then((csv) => {
        if (!this.isCurrent(sessionId, field, requestId)) {
          return
        }
        this.patch(field, { status: 'success', csv, error: null })
      })
      .catch((err: unknown) => {
        if (!this.isCurrent(sessionId, field, requestId)) {
          return
        }
        const reason = err instanceof Error ? err.message : String(err)
        this.patch(field, {
          status: 'error',
          error: `${field} failed: ${reason}`,
        })
      })
  }

  private isCurrent(sessionId: number, field: FieldName, requestId: number): boolean {
    return sessionId === this.sessionId && requestId === this.requestIds[field]
  }

  private patch(field: FieldName, patch: Partial<FieldState>): void {
    this.state = {
      ...this.state,
      [field]: { ...this.state[field], ...patch },
    }
    this.emit()
  }

  private emit(): void {
    this.onChange(this.state)
  }
}
