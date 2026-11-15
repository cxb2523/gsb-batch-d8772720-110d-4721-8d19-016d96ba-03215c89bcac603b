'use strict'

const debug = require('debug-logfmt')('ua:rejected')
const { isBrowser } = require('@microlink/ua')
const uaParser = require('ua-parser-js')
const Redis = require('ioredis')

const CANDIDATES_PER_SLOT = 2
const MAX_FETCH_MULTIPLIER = 10
const MIN_DEVICE_SHARE = 0.25

const connect = () =>
  this.instance ||
  (this.instance = require('@microlink/ua')(
    new Redis(process.env.REDIS_UA_URI)
  ))

const isRealBrowser = userAgent => {
  const result = isBrowser(userAgent)
  if (!result) debug(userAgent)
  return result
}

const getDevice = userAgent => {
  const type = uaParser(userAgent).device.type
  return type === 'mobile' || type === 'tablet' ? 'mobile' : 'desktop'
}

const minDeviceQuota = n => Math.ceil(n * MIN_DEVICE_SHARE)

const byScoreDesc = (a, b) => b[1] - a[1]

const selectTopUserAgents = (
  data,
  n,
  { minPerDevice = minDeviceQuota(n) } = {}
) => {
  const byDevice = { desktop: [], mobile: [] }
  for (const entry of data) {
    if (!isRealBrowser(entry[0])) continue
    byDevice[getDevice(entry[0])].push(entry)
  }

  const total = byDevice.desktop.length + byDevice.mobile.length
  const shortages = ['desktop', 'mobile']
    .filter(device => byDevice[device].length < minPerDevice)
    .map(
      device =>
        `${device} is short ${
          minPerDevice - byDevice[device].length
        } (has ${byDevice[device].length}/${minPerDevice})`
    )
  if (total < n) shortages.push(`total is short ${n - total} (has ${total}/${n})`)
  if (shortages.length > 0) {
    throw new Error(
      `Unable to collect enough real browser user agents: ${shortages.join(
        ', '
      )}. Refusing to update.`
    )
  }

  // guarantee every device its quota first, then fill the remaining
  // slots with the best scoring candidates regardless of device
  const picked = {
    desktop: byDevice.desktop.slice(0, minPerDevice),
    mobile: byDevice.mobile.slice(0, minPerDevice)
  }
  const rest = [
    ...byDevice.desktop.slice(minPerDevice).map(entry => [entry, 'desktop']),
    ...byDevice.mobile.slice(minPerDevice).map(entry => [entry, 'mobile'])
  ].sort((a, b) => byScoreDesc(a[0], b[0]))

  for (const [entry, device] of rest.slice(0, n - 2 * minPerDevice)) {
    picked[device].push(entry)
  }

  const index = [...picked.desktop, ...picked.mobile].sort(byScoreDesc)
  return { index, ...picked, minPerDevice }
}

const top = async (
  n,
  {
    minPerDevice = minDeviceQuota(n),
    maxFetchMultiplier = MAX_FETCH_MULTIPLIER
  } = {}
) => {
  const ua = connect()
  const maxCandidates = n * maxFetchMultiplier
  let limit = Math.min(n * CANDIDATES_PER_SLOT, maxCandidates)
  let attempts = 0
  for (;;) {
    const data = await ua.top(limit, { withScore: true })
    attempts++
    try {
      const result = selectTopUserAgents(data, n, { minPerDevice })
      return { ...result, attempts, fetched: data.length, toppedUp: attempts > 1 }
    } catch (error) {
      // give up when the fetch cap is reached or Redis has no more candidates
      if (limit >= maxCandidates || data.length < limit) throw error
      limit = Math.min(limit * 2, maxCandidates)
    }
  }
}

module.exports = {
  top,
  selectTopUserAgents,
  isRealBrowser,
  getDevice,
  minDeviceQuota,
  CANDIDATES_PER_SLOT,
  MAX_FETCH_MULTIPLIER,
  MIN_DEVICE_SHARE
}
