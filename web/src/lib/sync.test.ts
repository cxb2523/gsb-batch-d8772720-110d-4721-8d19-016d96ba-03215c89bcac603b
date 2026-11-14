import { describe, expect, it } from 'vitest'
import { missedEvents } from './sync'

describe('missedEvents', () => {
  const at = (seq: number, boot = 'b1') => ({ boot, seq })

  it('no events between the listing and the stream: nothing to reload', () => {
    expect(missedEvents(at(4), at(4))).toBe(false)
  })
  it('an event between them: reload', () => {
    expect(missedEvents(at(4), at(5))).toBe(true)
  })
  it('a server restart never matches, even with the same number', () => {
    expect(missedEvents(at(4, 'b1'), at(4, 'b2'))).toBe(true)
  })
  it('a listing newer than the hello already has those events', () => {
    expect(missedEvents(at(6), at(5))).toBe(false)
  })
  it('waits until both are known', () => {
    expect(missedEvents(undefined, at(5))).toBe(false)
    expect(missedEvents(at(5), undefined)).toBe(false)
  })
})
