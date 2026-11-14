import type { I18n } from '@/i18n'
import type { MessageKey } from '@/i18n/en'
import type { CredentialStatus } from '@/lib/types'
import { PROVIDER_LABEL } from './status'

export function reasonText(i18n: I18n, code: string): string {
  const key = `reason.${code}`
  return i18n.has(key) ? i18n.t(key as MessageKey) : code
}

export function reasonsLine(i18n: I18n, item: CredentialStatus, now: string): string {
  const parts = item.result.reasons.map((r) => reasonText(i18n, r.code))
  if (item.result.overall === 'grey' && item.last_known) {
    parts.push(
      i18n.t('lastKnown', {
        status: i18n.t(`status.${item.last_known.overall}`),
        when: i18n.relative(item.last_known.checked_at, now),
      }),
    )
  }
  return parts.join(' · ')
}

export function fundsLine(i18n: I18n, item: CredentialStatus): string {
  const f = item.result.funds.value
  if (f.amount !== null) {
    const money = i18n.money(f.amount, f.currency)
    return item.credential.facts?.funds?.scope === 'team'
      ? i18n.t('fundsTeam', { amount: money })
      : money
  }
  if (f.state === 'empty') return i18n.t('fundsEmpty')
  if (f.state === 'ok') return i18n.t('fundsOk')
  if (f.state === 'not_applicable') return i18n.t('fundsNotApplicable')
  return i18n.t('fundsNotAvailable')
}

export function limitsLine(i18n: I18n, item: CredentialStatus): string | null {
  const limits = item.result.limits?.value
  if (!limits) return null
  if (limits.state === 'throttled') return i18n.t('limitsThrottled')
  const r = limits.requests
  if (r?.remaining != null && r.limit != null) {
    return i18n.t('limitsLine', {
      remaining: i18n.number(r.remaining),
      limit: i18n.number(r.limit),
    })
  }
  return null
}

export function checkedLine(i18n: I18n, item: CredentialStatus, now: string): string {
  if (item.result.mode === 'offline') return i18n.t('neverChecked')
  const when = i18n.t('checkedWhen', { when: i18n.relative(item.result.checked_at, now) })
  return item.cached ? `${when} (${i18n.t('cachedNote')})` : when
}

export function providerName(id: string): string {
  return PROVIDER_LABEL[id] ?? id
}

/** Informational funds (an organization-wide estimate): never colours the card. */
export function fundsInfoLine(i18n: I18n, item: CredentialStatus): string | null {
  const info = item.result.funds_info?.value
  if (!info) return null
  return i18n.t('orgEstimate', {
    amount: i18n.money(info.amount, info.currency),
    date: i18n.date(info.until),
  })
}

/** A path under the home folder as `~/…` (the server sends full paths, in bodies only). */
export function shortPath(path: string, home: string): string {
  const trimmed = home.replace(/[\\/]+$/, '')
  if (trimmed && (path.startsWith(`${trimmed}/`) || path.startsWith(`${trimmed}\\`))) {
    return `~${path.slice(trimmed.length)}`
  }
  return path
}

/** Where a key was found: `~/proj/.env:3`, or a notebook's cell and line. */
export function whereText(
  i18n: I18n,
  at: { path: string; line: number; cell_line: number | null },
  home: string,
): string {
  const path = shortPath(at.path, home)
  if (at.cell_line !== null) {
    return i18n.t('scanCell', { path, cell: at.line, line: at.cell_line })
  }
  return `${path}:${at.line}`
}

export function riskText(i18n: I18n, risk: string): string {
  const key = `risk.${risk}`
  return i18n.has(key) ? i18n.t(key as MessageKey) : risk
}
