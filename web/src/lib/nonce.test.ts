import { readNonce } from './nonce'

describe('readNonce', () => {
  it('reads the nonce property (browsers hide the attribute under a CSP header)', () => {
    const doc = document.implementation.createHTMLDocument('x')
    const meta = doc.createElement('meta')
    meta.setAttribute('property', 'csp-nonce')
    // Browsers expose the nonce only through the property and blank the attribute.
    meta.setAttribute('nonce', '')
    Object.defineProperty(meta, 'nonce', { value: 'abc123' })
    doc.head.append(meta)
    expect(meta.getAttribute('nonce')).toBe('')
    expect(readNonce(doc)).toBe('abc123')
  })

  it('ignores the build placeholder (dev server) and a missing meta', () => {
    const doc = document.implementation.createHTMLDocument('x')
    expect(readNonce(doc)).toBeUndefined()
    const meta = doc.createElement('meta')
    meta.setAttribute('property', 'csp-nonce')
    meta.nonce = '__MECHA_CSP_NONCE__'
    doc.head.append(meta)
    expect(readNonce(doc)).toBeUndefined()
  })
})
