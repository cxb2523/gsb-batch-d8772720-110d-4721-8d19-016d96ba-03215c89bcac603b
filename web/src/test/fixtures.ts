import type { CredentialStatus, Overall } from '@/lib/types'

export const NOW = '2026-11-04T09:30:00+00:00'

export function status(overrides: {
  overall?: Overall
  expires_at?: string | null
  kind?: CredentialStatus['credential']['kind']
  label?: string
  reasons?: string[]
  expiry_state?: string
  created_at?: string
}): CredentialStatus {
  const overall = overrides.overall ?? 'green'
  return {
    credential: {
      id: '01DEMO00000000000000000001',
      label: overrides.label ?? 'Prod key',
      provider: 'anthropic',
      kind: overrides.kind ?? 'api_key',
      redacted: 'sk-ant-api03-Qm7…x2Pa',
      fingerprint: 'abcdefabcdef',
      tags: ['prod'],
      notes: null,
      linked_path: null,
      manual_expires_at: null,
      created_at: overrides.created_at ?? '2026-10-01T00:00:00+00:00',
      token_expires_at: null,
      subscription_until: null,
      retiring: false,
      active_probe: false,
      parent_id: null,
      manual_budget: null,
    },
    result: {
      credential_id: '01DEMO00000000000000000001',
      checked_at: '2026-11-04T06:30:00+00:00',
      mode: 'passive',
      check_status: 'ok',
      overall,
      reasons: (overrides.reasons ?? ['valid']).map((code) => ({ code, overall })),
      validity: { value: 'valid', source: 'api', observed_at: NOW },
      funds: {
        value: { state: 'unknown', amount: null, currency: null },
        source: 'inferred',
        observed_at: NOW,
      },
      expiry: {
        value: {
          state: overrides.expiry_state ?? (overrides.expires_at ? 'scheduled' : 'unknown'),
          expires_at: overrides.expires_at ?? null,
        },
        source: 'api',
        observed_at: NOW,
      },
      limits: null,
      funds_info: null,
      last_used_at: null,
      account: {},
      http: null,
      error: null,
    },
    cached: false,
    last_known: null,
    probe_next_at: null,
  }
}
