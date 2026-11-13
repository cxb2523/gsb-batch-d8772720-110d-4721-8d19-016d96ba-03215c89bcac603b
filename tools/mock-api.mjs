/*
 * Local mock of the iot-api backend for acceptance testing the device page.
 * Zero dependencies: `node tools/mock-api.mjs` (optionally PORT=xxxx).
 *
 * Point the Next.js dev server at it via .env.development:
 *   API_URL=http://localhost:4010
 *
 * Behaviour controls (so failure/retry/switch scenarios can be scripted):
 *   POST /__control  { "pressureFail": true|false,
 *                      "generateFail": true|false,
 *                      "delayMs": <number>,
 *                      "pressureDelayMs": <number> }
 *   GET  /__control  -> current settings
 *
 * Every measurements CSV row carries the requested deviceId, so a stale
 * response from an old device is visible if it ever leaks onto the page.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT) || 4010
const DEVICES = ['device-alpha', 'device-beta']

const settings = {
  pressureFail: false,
  generateFail: false,
  delayMs: 30,
  pressureDelayMs: 0, // extra delay only for Pressure (used in switch tests)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

function fieldFromQuery(query) {
  const match = /_field\s*==\s*"([^"]+)"/.exec(query || '')
  return match ? match[1] : 'Unknown'
}

/* Annotated Flux CSV that Giraffe's fromFlux() can parse. */
function measurementsCsv(deviceId, field) {
  const base = field === 'Humidity' ? 55 : field === 'Pressure' ? 1010 : 22
  const rows = []
  for (let i = 0; i < 6; i += 1) {
    const time = new Date(Date.UTC(2026, 0, 1, i, 0, 0)).toISOString()
    const value = (base + i * 0.5).toFixed(2)
    rows.push(`,,0,2026-01-01T00:00:00Z,2026-01-01T06:00:00Z,${time},${value},${field},${deviceId}`)
  }
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
#group,false,false,true,true,false,false,true
#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,double,string
#default,mean,,,,,,
,result,table,_start,_stop,_time,_value,_field,device
${rows.join('\n')}
`
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  // Next.js rewrites strip "/api" before proxying, but accept the prefix
  // too so the mock can be hit directly during acceptance runs.
  const pathname = url.pathname.replace(/^\/api(?=\/)/, '')
  const segments = pathname.split('/').filter(Boolean) // ['devices', ...]

  try {
    if (segments[0] === '__control') {
      if (req.method === 'POST') {
        Object.assign(settings, await readBody(req))
      }
      sendJson(res, 200, settings)
      return
    }

    if (segments[0] !== 'devices') {
      sendJson(res, 404, { error: 'not found' })
      return
    }

    // POST /devices/generate
    if (req.method === 'POST' && segments[1] === 'generate') {
      await readBody(req)
      await sleep(settings.delayMs)
      if (settings.generateFail) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'simulated generate failure' }))
        return
      }
      sendJson(res, 200, { written: true })
      return
    }

    // POST /devices/:id/measurements
    if (req.method === 'POST' && segments[2] === 'measurements') {
      const deviceId = decodeURIComponent(segments[1])
      const body = await readBody(req)
      const field = fieldFromQuery(body.query)
      const delay = settings.delayMs + (field === 'Pressure' ? settings.pressureDelayMs : 0)
      await sleep(delay)

      if (field === 'Pressure' && settings.pressureFail) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'simulated pressure failure' }))
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/csv',
        'X-Mock-Field': field,
        'X-Mock-Device': deviceId,
      })
      res.end(measurementsCsv(deviceId, field))
      return
    }

    // GET /devices or /devices/:id
    if (req.method === 'GET') {
      const id = segments[1] ? decodeURIComponent(segments[1]) : null
      const now = new Date().toISOString()
      const list = DEVICES
        .filter((d) => !id || d === id)
        .map((deviceId) => ({ deviceId, key: 'env', updatedAt: now }))
      sendJson(res, 200, list)
      return
    }

    sendJson(res, 405, { error: 'method not allowed' })
  } catch (err) {
    sendJson(res, 500, { error: String(err) })
  }
})

server.listen(PORT, () => {
  console.log(`mock iot-api listening on http://localhost:${PORT}`)
  console.log(`devices: ${DEVICES.join(', ')}`)
  console.log('controls: POST/GET /__control { pressureFail, generateFail, delayMs, pressureDelayMs }')
})
