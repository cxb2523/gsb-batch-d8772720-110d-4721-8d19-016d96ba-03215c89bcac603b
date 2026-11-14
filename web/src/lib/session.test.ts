import { initSessionToken, STORAGE_KEY } from './session'

function goTo(url: string) {
  window.history.replaceState(null, '', url)
}

describe('initSessionToken', () => {
  it('reads the token from the fragment, stores it and cleans the URL', () => {
    goTo('/#t=abc123')
    expect(initSessionToken()).toBe('abc123')
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('abc123')
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain('abc123')
  })

  it('keeps other fragment params', () => {
    goTo('/?x=1#t=abc&view=table')
    initSessionToken()
    expect(window.location.search).toBe('?x=1')
    expect(window.location.hash).toBe('#view=table')
  })

  it('survives a reload via sessionStorage', () => {
    goTo('/#t=abc123')
    initSessionToken()
    goTo('/')
    expect(initSessionToken()).toBe('abc123')
  })

  it('a new fragment token replaces the stored one', () => {
    sessionStorage.setItem(STORAGE_KEY, 'old')
    goTo('/#t=new')
    expect(initSessionToken()).toBe('new')
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('new')
  })

  it('returns null without fragment or stored token', () => {
    goTo('/')
    expect(initSessionToken()).toBeNull()
  })
})
