import { en } from './en'
import { es } from './es'
import { makeI18n } from './index'

describe('i18n', () => {
  it('both languages have exactly the same keys', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort())
  })

  it('placeholders match between languages', () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(vars(es[key]), key).toEqual(vars(en[key]))
    }
  })

  it('every reason code shown by the engine has a text', () => {
    const codes = [
      'not_checked',
      'check_failed',
      'validity_unknown',
      'local_only',
      'valid',
      'expired',
      'expires_soon',
      'funds_empty',
      'funds_low',
      'funds_capped',
      'throttled',
      'retiring_key_type',
      'validity_invalid',
      'validity_revoked',
      'validity_blocked',
      'permission_denied',
      'billing_error',
      'team_blocked',
    ]
    const i18n = makeI18n('es')
    for (const code of codes) expect(i18n.has(`reason.${code}`), code).toBe(true)
  })

  it('uses Intl for plurals, relative times and money', () => {
    const en_ = makeI18n('en')
    const es_ = makeI18n('es')
    expect(en_.plural('plural.credential', 1)).toBe('1 credential')
    expect(es_.plural('plural.credential', 20)).toBe('20 credenciales')
    expect(en_.relative('2026-11-04T06:30:00Z', '2026-11-04T09:30:00Z')).toBe('3 hours ago')
    expect(es_.relative('2026-11-05T09:30:00Z', '2026-11-04T09:30:00Z')).toBe('mañana')
    expect(en_.money('12.4', 'USD')).toBe('$12.40')
    expect(es_.money(12.4, 'USD')).toMatch(/12,40/)
  })
})
