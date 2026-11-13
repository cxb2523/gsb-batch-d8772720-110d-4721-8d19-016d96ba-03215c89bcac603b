import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FieldDataCollector,
  FIELDS,
  buildMeasurementsQuery,
  initialFieldState,
} from '../components/devices/fieldData.ts'
import type { FieldDataState, FieldName } from '../components/devices/fieldData.ts'

interface Call {
  url: string
  init?: RequestInit
  field: string
}

/* Minimal Response stand-in. */
function makeResponse(ok: boolean, body: string, status = 200, statusText = ok ? 'OK' : 'Internal Server Error'): Response {
  return {
    ok,
    status,
    statusText,
    text: () => Promise.resolve(body),
  } as unknown as Response
}

function csvFor(deviceId: string, field: string) {
  return `#group,false,false
#datatype,string,long
#default,_result,
,result,table
,,0
#group,true,true,true
#datatype,string,string,string
#default,,,
,result,_field,_measurement
,,${field},environment
#group,false,false,true,true,false
#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,double,string
#default,mean,,,,
,result,table,_start,_stop,_time,_value,_field,device
,,0,2020-01-01T00:00:00Z,2026-01-01T00:00:00Z,2020-01-01T00:00:00Z,42,${field},${deviceId}
`
}

/* Controlled mock fetch: records calls and lets each response be resolved
 * explicitly so request ordering can be tested. */
class MockFetch {
  calls: Call[] = []
  private pending = new Map<string, { resolve: (r: Response) => void; reject: (e: unknown) => void }>()

  handler = (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse((init?.body as string) ?? '{}')
    const field = /_field == "([^"]+)"/.exec(body.query ?? '')?.[1] ?? 'unknown'
    this.calls.push({ url, init, field })
    return new Promise((resolve, reject) => {
      this.pending.set(this.key(field), { resolve, reject })
    })
  }

  private key(field: string) {
    // index by occurrence so repeated requests for the same field are distinct
    const count = this.calls.filter((c) => c.field === field).length
    return `${field}#${count}`
  }

  private slot(field: string, occurrence: number) {
    const pending = this.pending.get(`${field}#${occurrence}`)
    assert.ok(pending, `no pending request for ${field}#${occurrence}`)
    return pending!
  }

  resolve(field: string, occurrence: number, res: Response) {
    this.slot(field, occurrence).resolve(res)
  }

  reject(field: string, occurrence: number, err: Error) {
    this.slot(field, occurrence).reject(err)
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function makeCollector() {
  const mock = new MockFetch()
  const states: FieldDataState[] = []
  const collector = new FieldDataCollector((s) => states.push({
    Humidity: { ...s.Humidity },
    Pressure: { ...s.Pressure },
    Temperature: { ...s.Temperature },
  }), mock.handler)
  return { mock, states, collector }
}

const latest = (states: FieldDataState[]) => states[states.length - 1]

test('initial state has one idle entry per field', () => {
  const state = initialFieldState()
  assert.deepEqual(FIELDS, ['Humidity', 'Pressure', 'Temperature'])
  for (const field of FIELDS) {
    assert.equal(state[field].status, 'idle')
    assert.equal(state[field].error, null)
    assert.equal(state[field].csv, '')
  }
})

test('collectAll fires one independent CSV request per field with the Flux JSON body', async () => {
  const { mock, collector } = makeCollector()
  collector.collectAll('dev-1')

  assert.equal(mock.calls.length, 3)
  for (const field of FIELDS) {
    const call = mock.calls.find((c) => c.field === field)!
    assert.ok(call, `missing request for ${field}`)
    assert.equal(call.url, '/api/devices/dev-1/measurements')
    assert.equal(call.init?.method, 'POST')
    assert.equal((call.init?.headers as Record<string, string>).Accept, 'application/csv')
    assert.equal((call.init?.headers as Record<string, string>)['Content-Type'], 'application/json')
    const body = JSON.parse(call.init?.body as string)
    assert.ok(body.query.includes(`r._field == "${field}"`))
    assert.ok(body.query.includes('r.device == "dev-1"'))
    mock.resolve(field, 1, makeResponse(true, csvFor('dev-1', field)))
  }
  await flush()

  const state = collector.getState()
  for (const field of FIELDS) {
    assert.equal(state[field].status, 'success')
    assert.ok(state[field].csv.includes(field))
  }
})

test('a non-2xx for Pressure fails only Pressure and names the field; others succeed', async () => {
  const { mock, collector } = makeCollector()
  collector.collectAll('dev-1')

  mock.resolve('Humidity', 1, makeResponse(true, csvFor('dev-1', 'Humidity')))
  mock.resolve('Pressure', 1, makeResponse(false, '', 500, 'Internal Server Error'))
  mock.resolve('Temperature', 1, makeResponse(true, csvFor('dev-1', 'Temperature')))
  await flush()

  const state = collector.getState()
  assert.equal(state.Humidity.status, 'success')
  assert.equal(state.Temperature.status, 'success')
  assert.equal(state.Pressure.status, 'error')
  assert.ok(state.Pressure.error!.startsWith('Pressure failed:'))
  assert.ok(state.Pressure.error!.includes('500'))
})

test('retrying one field only re-requests that field and recovers without touching others', async () => {
  const { mock, collector } = makeCollector()
  collector.collectAll('dev-1')
  mock.resolve('Humidity', 1, makeResponse(true, csvFor('dev-1', 'Humidity')))
  mock.resolve('Pressure', 1, makeResponse(false, '', 503, 'Service Unavailable'))
  mock.resolve('Temperature', 1, makeResponse(true, csvFor('dev-1', 'Temperature')))
  await flush()
  assert.equal(mock.calls.length, 3)
  assert.equal(collector.getState().Pressure.status, 'error')

  collector.collectField('dev-1', 'Pressure') // retry Pressure only
  assert.equal(mock.calls.length, 4)
  assert.deepEqual(mock.calls.slice(3).map((c) => c.field), ['Pressure'])
  mock.resolve('Pressure', 2, makeResponse(true, csvFor('dev-1', 'Pressure')))
  await flush()

  const state = collector.getState()
  assert.equal(state.Pressure.status, 'success')
  assert.ok(state.Pressure.csv.includes('Pressure'))
  assert.equal(state.Humidity.status, 'success')
  assert.equal(state.Temperature.status, 'success')
  // No extra requests were made for the already-successful fields.
  assert.equal(mock.calls.filter((c) => c.field === 'Humidity').length, 1)
  assert.equal(mock.calls.filter((c) => c.field === 'Temperature').length, 1)
  assert.equal(mock.calls.filter((c) => c.field === 'Pressure').length, 2)
})

test('retriggering the same field keeps only the last request result', async () => {
  const { mock, collector } = makeCollector()
  collector.collectField('dev-1', 'Humidity')
  collector.collectField('dev-1', 'Humidity')
  assert.equal(mock.calls.length, 2)

  // First (superseded) request resolves late.
  mock.resolve('Humidity', 1, makeResponse(true, 'STALE_CSV'))
  await flush()
  assert.equal(collector.getState().Humidity.status, 'loading')

  mock.resolve('Humidity', 2, makeResponse(true, csvFor('dev-1', 'Humidity')))
  await flush()
  const state = collector.getState()
  assert.equal(state.Humidity.status, 'success')
  assert.ok(!state.Humidity.csv.includes('STALE_CSV'))
  assert.ok(state.Humidity.csv.includes('Humidity'))
})

test('switching device discards in-flight results of the old device', async () => {
  const { mock, collector } = makeCollector()
  collector.collectAll('old-device')
  assert.equal(mock.calls.length, 3)

  collector.invalidateSession()
  collector.collectAll('new-device')
  assert.equal(mock.calls.length, 6)

  // All three old-device responses arrive late.
  for (const field of FIELDS) {
    mock.resolve(field, 1, makeResponse(true, csvFor('old-device', field)))
  }
  await flush()
  // Nothing from the old device may be applied.
  for (const field of FIELDS) {
    assert.equal(collector.getState()[field].status, 'loading')
    assert.equal(collector.getState()[field].csv, '')
  }

  for (const field of FIELDS) {
    mock.resolve(field, 2, makeResponse(true, csvFor('new-device', field)))
  }
  await flush()
  for (const field of FIELDS) {
    assert.equal(collector.getState()[field].status, 'success')
    assert.ok(collector.getState()[field].csv.includes('new-device'))
    assert.ok(!collector.getState()[field].csv.includes('old-device'))
  }
  // New device's requests target the new URL.
  for (const call of mock.calls.slice(3)) {
    assert.equal(call.url, '/api/devices/new-device/measurements')
  }
})

test('network errors are reported per field and remain retryable', async () => {
  const { mock, collector } = makeCollector()
  collector.collectField('dev-1', 'Temperature')
  mock.reject('Temperature', 1, new TypeError('network down'))
  await flush()

  const failed = collector.getState().Temperature
  assert.equal(failed.status, 'error')
  assert.ok(failed.error!.startsWith('Temperature failed:'))
  assert.ok(failed.error!.includes('network down'))

  collector.collectField('dev-1', 'Temperature')
  mock.resolve('Temperature', 2, makeResponse(true, csvFor('dev-1', 'Temperature')))
  await flush()
  assert.equal(collector.getState().Temperature.status, 'success')
})

test('onChange emits a loading update first, then success with a new state object', async () => {
  const { mock, states, collector } = makeCollector()
  const before = collector.getState()
  collector.collectField('dev-1', 'Humidity')
  assert.equal(latest(states).Humidity.status, 'loading')
  assert.notEqual(latest(states), before)

  mock.resolve('Humidity', 1, makeResponse(true, csvFor('dev-1', 'Humidity')))
  await flush()
  assert.equal(latest(states).Humidity.status, 'success')
})

test('invalidateSession resets every field to idle', () => {
  const { mock, states, collector } = makeCollector()
  collector.collectField('dev-1', 'Humidity')
  assert.equal(latest(states).Humidity.status, 'loading')
  collector.invalidateSession()
  const reset = latest(states)
  for (const field of FIELDS) {
    assert.equal(reset[field].status, 'idle')
    assert.equal(reset[field].csv, '')
    assert.equal(reset[field].error, null)
  }
  // unused mock reference kept for symmetry
  assert.equal(mock.calls.length, 1)
})

test('buildMeasurementsQuery contains device and field filters', () => {
  const q = buildMeasurementsQuery('dev-7', 'Pressure')
  assert.ok(q.includes('r.device == "dev-7"'))
  assert.ok(q.includes('r._field == "Pressure"'))
  assert.ok(q.includes('aggregateWindow(every: 1h, fn: mean'))
})
