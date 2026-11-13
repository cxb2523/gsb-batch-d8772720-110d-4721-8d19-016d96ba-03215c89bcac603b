/*
 * End-to-end acceptance check against the local mock API (tools/mock-api.mjs).
 * It uses the REAL FieldDataCollector with Node's real fetch over HTTP.
 *
 *   node tools/acceptance.mjs
 *
 * Scenarios (mirrors the task's acceptance criteria):
 *   1. All three fields succeed -> one named success state per field, each
 *      request hits /api/devices/:id/measurements with Accept: application/csv.
 *   2. Pressure returns non-2xx -> only Pressure fails (message names the
 *      field) and can be retried on its own; retry success does not re-request
 *      the other fields.
 *   3. Rapid device switch while Pressure is still in flight -> the old
 *      device's late response never reaches the new device's state.
 */
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'

const PORT = 4099
const BASE = `http://localhost:${PORT}`
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const mock = spawn(process.execPath, [path.join(repoRoot, 'tools', 'mock-api.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
})

let failed = false
const check = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => console.log(`  PASS  ${name}`))
  .catch((err) => {
    failed = true
    console.error(`  FAIL  ${name}\n        ${err.message}`)
  })

async function control(patch) {
  const res = await fetch(`${BASE}/__control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return res.json()
}

async function settle(collector, timeoutMs = 2000) {
  const start = Date.now()
  const done = new Promise((resolve) => {
    const tick = () => {
      const s = collector.getState()
      const pending = Object.values(s).some((f) => f.status === 'loading' || f.status === 'idle')
      if (!pending || Date.now() - start > timeoutMs) resolve()
      else setTimeout(tick, 10)
    }
    tick()
  })
  await done
}

async function main() {
  // Wait for the mock to come up.
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetch(`${BASE}/devices`)
      break
    } catch {
      await delay(50)
    }
  }

  const { FieldDataCollector, FIELDS } = await import(
    pathToFileURL(path.join(repoRoot, 'components', 'devices', 'fieldData.ts')).href
  )

  // Rewrite the relative API URLs the collector uses to absolute ones.
  const httpFetch = (url, init) => fetch(`${BASE}${url}`, init)

  console.log('Scenario 1: all three fields succeed with field-named results')
  await control({ pressureFail: false, delayMs: 20, pressureDelayMs: 0 })
  {
    const calls = []
    const recordingFetch = (url, init) => {
      calls.push({ url, init })
      return httpFetch(url, init)
    }
    const collector = new FieldDataCollector(() => {}, recordingFetch)
    collector.collectAll('device-alpha')
    await settle(collector)
    const s = collector.getState()
    for (const field of FIELDS) {
      await check(`field ${field} succeeds and CSV names the field + device`, () => {
        assert.equal(s[field].status, 'success')
        assert.ok(s[field].csv.includes(field))
        assert.ok(s[field].csv.includes('device-alpha'))
      })
    }
    await check('exactly three requests, each POST .../measurements with Accept: application/csv', () => {
      assert.equal(calls.length, 3)
      for (const call of calls) {
        assert.equal(call.url, '/api/devices/device-alpha/measurements')
        assert.equal(call.init.method, 'POST')
        assert.equal(call.init.headers.Accept, 'application/csv')
        assert.equal(JSON.parse(call.init.body).query.length > 0, true)
      }
    })
  }

  console.log('Scenario 2: Pressure non-2xx -> isolated failure + single-field retry')
  await control({ pressureFail: true, delayMs: 10, pressureDelayMs: 0 })
  {
    const calls = []
    const recordingFetch = (url, init) => {
      calls.push({ url, init })
      return httpFetch(url, init)
    }
    const collector = new FieldDataCollector(() => {}, recordingFetch)
    collector.collectAll('device-alpha')
    await settle(collector)
    const s1 = collector.getState()
    await check('only Pressure is in error and the message names Pressure', () => {
      assert.equal(s1.Humidity.status, 'success')
      assert.equal(s1.Temperature.status, 'success')
      assert.equal(s1.Pressure.status, 'error')
      assert.ok(s1.Pressure.error.startsWith('Pressure failed:'))
      assert.ok(s1.Pressure.error.includes('502'))
    })
    const callsBeforeRetry = calls.length
    const humCalls = calls.filter((c) => c.url.includes('measurements')).length

    await control({ pressureFail: false })
    collector.collectField('device-alpha', 'Pressure')
    await settle(collector)
    const s2 = collector.getState()
    await check('retry succeeds for Pressure only', () => {
      assert.equal(s2.Pressure.status, 'success')
      assert.ok(s2.Pressure.csv.includes('Pressure'))
    })
    await check('retry issued exactly one new request; other fields not re-requested', () => {
      assert.equal(calls.length, callsBeforeRetry + 1)
      const fieldOf = (init) => /_field == "([^"]+)"/.exec(JSON.parse(init.body).query)[1]
      assert.equal(fieldOf(calls[calls.length - 1].init), 'Pressure')
      const perField = FIELDS.map((f) => calls.filter((c) => fieldOf(c.init) === f).length)
      assert.deepEqual(perField, [1, 2, 1]) // Humidity once, Pressure twice, Temperature once
      assert.equal(humCalls, 3)
    })
  }

  console.log('Scenario 3: rapid device switch discards the old device in-flight results')
  await control({ pressureFail: false, delayMs: 10, pressureDelayMs: 400 })
  {
    const collector = new FieldDataCollector(() => {}, httpFetch)
    collector.collectAll('device-alpha')
    await delay(30) // requests for old device are in flight
    collector.invalidateSession()
    collector.collectAll('device-beta')
    await settle(collector)
    // Give the old device's late Pressure response time to land; it must be
    // a no-op because its session was invalidated.
    await delay(600)
    const s = collector.getState()
    const snapshot = JSON.parse(JSON.stringify(s))
    for (const field of FIELDS) {
      await check(`new-device ${field} data contains only device-beta`, () => {
        assert.equal(s[field].status, 'success')
        assert.ok(s[field].csv.includes('device-beta'))
        assert.ok(!s[field].csv.includes('device-alpha'))
      })
    }
    await check('state stays unchanged after the stale response arrives', () => {
      assert.deepEqual(collector.getState(), snapshot)
    })
  }

  mock.kill()
  if (failed) {
    console.error('\nACCEPTANCE FAILED')
    process.exit(1)
  }
  console.log('\nALL ACCEPTANCE CHECKS PASSED')
  process.exit(0)
}

main().catch((err) => {
  mock.kill()
  console.error(err)
  process.exit(1)
})
