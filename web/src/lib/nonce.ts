import { setNonce } from 'get-nonce'

const PLACEHOLDER = '__MECHA_CSP_NONCE__'

/**
 * The per-response CSP nonce. Read through the `nonce` property: with the CSP sent as a
 * header, browsers hide the attribute value (getAttribute returns "").
 */
export function readNonce(doc: Document = document): string | undefined {
  const meta = doc.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')
  const value = meta?.nonce || undefined
  return value && value !== PLACEHOLDER ? value : undefined
}

let current: string | undefined

/** Call once before the first render: Radix (react-style-singleton) reads it via get-nonce. */
export function installNonce(): string | undefined {
  current = readNonce()
  if (current) setNonce(current)
  return current
}

export function getCspNonce(): string | undefined {
  return current
}
