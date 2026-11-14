import { describe, expect, it } from 'vitest'
import { loadDemoData, RAW } from './data'
import { isDateString, NOT_SHIFTED, offsetFor, shiftDate, shiftDates } from './dates'

type Found = { path: string; key: string; value: string }

/** Every string in the dump that looks like a date, wherever it is. */
function dates(value: unknown, path = '$', key = ''): Found[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => dates(v, `${path}[${i}]`, key))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => dates(v, `${path}.${k}`, k))
  }
  return isDateString(value) ? [{ path, key, value }] : []
}

function at(root: unknown, path: string): unknown {
  const parts = path.slice(2).match(/[^.[\]]+/g) ?? []
  return parts.reduce<unknown>((node, p) => (node as Record<string, unknown>)[p], root)
}

describe('web demo dates', () => {
  const now = Date.parse('2027-03-15T12:34:56Z')
  const offset = offsetFor(RAW.generated_at, now)
  const shifted = loadDemoData(now)
  const found = dates(RAW)

  it('finds the dates in the dump (the test is not vacuous)', () => {
    expect(found.length).toBeGreaterThan(100)
    expect(found.some((f) => f.path === '$.generated_at')).toBe(true)
  })

  it('moves every date field by the same single offset, generated_at included', () => {
    const missed = found.filter((f) => {
      if (NOT_SHIFTED.has(f.key)) return false
      const got = at(shifted, f.path) as string
      return got !== shiftDate(f.value, offset) || got === f.value
    })
    expect(missed.map((f) => `${f.path} = ${f.value}`)).toEqual([])
    expect(Date.parse(shifted.generated_at)).toBe(now)
  })

  it('keeps real-world dates (price table) as they are, and only those', () => {
    const kept = found.filter((f) => NOT_SHIFTED.has(f.key))
    expect(kept.length).toBeGreaterThan(0)
    for (const key of NOT_SHIFTED) expect(kept.some((f) => f.key === key)).toBe(true)
    for (const f of kept) expect(at(shifted, f.path)).toBe(f.value)
  })

  it('does not modify the imported dump', () => {
    expect(shiftDates(RAW, offset)).not.toBe(RAW)
    expect(dates(RAW)).toEqual(found)
  })

  it('shifts date-only values by whole days', () => {
    expect(shiftDate('2026-11-04', 24 * 3600 * 1000)).toBe('2026-11-05')
  })
})
