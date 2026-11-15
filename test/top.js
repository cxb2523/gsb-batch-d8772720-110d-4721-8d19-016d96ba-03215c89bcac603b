'use strict'

const Module = require('module')
const test = require('ava')

const desktopUA = i =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${
    120 + i
  }.0.0.0 Safari/537.36`
const mobileUA = i =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS 17_${i} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1`
const JUNK_UA = 'Event-Admin/1.0 (thumbnail)'

// spec: array of 'desktop' | 'mobile' | 'junk', scores decrease with position
const buildDataset = spec =>
  spec.map((kind, i) => [
    kind === 'desktop' ? desktopUA(i) : kind === 'mobile' ? mobileUA(i) : JUNK_UA,
    1000 - i
  ])

let dataset = []
let calls = []

const realLoad = Module._load
const realUa = realLoad.call(module, '@microlink/ua', module, false)

Module._load = function (request, parent, isMain) {
  if (request === 'ioredis') return class Redis {}
  if (request === '@microlink/ua') {
    const factory = () => ({
      async top (limit, options) {
        calls.push([limit, options])
        return dataset.slice(0, limit)
      }
    })
    factory.isBrowser = realUa.isBrowser
    return factory
  }
  return realLoad.apply(this, arguments)
}

// util caches its connection, so every test gets a fresh module instance
const loadUtil = () => {
  delete require.cache[require.resolve('../bin/util')]
  return require('../bin/util')
}

test.beforeEach(() => {
  dataset = []
  calls = []
})

test.after(() => {
  Module._load = realLoad
})

const scores = list => list.map(([, score]) => score)
const isDesc = list => list.every((score, i) => i === 0 || list[i - 1] >= score)

test.serial('top fetches two scored candidates per slot on the first round', async t => {
  const { top } = loadUtil()
  dataset = buildDataset(['desktop', 'desktop'])

  const result = await top(1, { minPerDevice: 0 })

  t.deepEqual(calls, [[2, { withScore: true }]])
  t.deepEqual(result.index, [dataset[0]])
  t.false(result.toppedUp)
  t.is(result.attempts, 1)
})

test.serial('top tops up from Redis until every device reaches its quota', async t => {
  const { top } = loadUtil()
  // the first 8 candidates only contain a single mobile UA
  dataset = buildDataset([
    'desktop', 'desktop', 'desktop', 'desktop',
    'desktop', 'desktop', 'desktop', 'mobile',
    'mobile', 'mobile', 'mobile', 'desktop',
    'desktop', 'desktop', 'desktop', 'desktop'
  ])

  const result = await top(4, { minPerDevice: 2 })

  t.true(result.toppedUp)
  t.is(result.attempts, 2)
  t.deepEqual(
    calls.map(([limit]) => limit),
    [8, 16]
  )
  t.is(result.mobile.length, 2)
  t.is(result.desktop.length, 2)
  t.is(result.index.length, 4)
})

test.serial('top aborts when a device stays below quota up to the fetch cap', async t => {
  const { top } = loadUtil()
  dataset = buildDataset(Array.from({ length: 40 }, () => 'desktop'))

  const error = await t.throwsAsync(top(4, { minPerDevice: 2 }))

  t.regex(error.message, /mobile is short 2 \(has 0\/2\)/)
  t.regex(error.message, /Refusing to update/)
  // the fetch limit is capped, Redis is never asked for unbounded pages
  t.true(calls.length > 1)
  t.true(calls.every(([limit]) => limit <= 40))
  t.deepEqual(calls.map(([limit]) => limit), [8, 16, 32, 40])
})

test.serial('top aborts at once when Redis has no more candidates', async t => {
  const { top } = loadUtil()
  dataset = buildDataset(Array.from({ length: 5 }, () => 'desktop'))

  const error = await t.throwsAsync(top(4, { minPerDevice: 2 }))

  t.regex(error.message, /mobile is short 2 \(has 0\/2\)/)
  t.is(calls.length, 1)
})

test.serial('top keeps score order and a consistent device split', async t => {
  const { top } = loadUtil()
  dataset = buildDataset([
    'desktop', 'junk', 'mobile', 'desktop', 'mobile',
    'desktop', 'desktop', 'mobile', 'desktop', 'mobile',
    'desktop', 'mobile', 'desktop', 'desktop', 'mobile',
    'desktop', 'desktop', 'mobile', 'desktop', 'mobile'
  ])

  const result = await top(10, { minPerDevice: 3 })

  t.is(result.index.length, 10)
  t.true(isDesc(scores(result.index)))
  t.true(isDesc(scores(result.desktop)))
  t.true(isDesc(scores(result.mobile)))
  t.true(result.desktop.length >= 3)
  t.true(result.mobile.length >= 3)
  // index is exactly desktop + mobile
  t.deepEqual(
    [...result.index].sort(),
    [...result.desktop, ...result.mobile].sort()
  )
  // no filtered-out candidate leaks into the result
  t.false(result.index.some(([userAgent]) => userAgent === JUNK_UA))
})
