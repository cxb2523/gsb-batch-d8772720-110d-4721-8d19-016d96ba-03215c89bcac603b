import { screen } from '@testing-library/react'
import { makeI18n } from '@/i18n'
import { NOW, status } from '@/test/fixtures'
import { renderUi } from '@/test/render'
import { Fuse, fuseModel } from './Fuse'

const i18n = makeI18n('en')
const model = (opts: Parameters<typeof status>[0], horizon = 90) =>
  fuseModel(status(opts), NOW, i18n.t, i18n.relative, horizon)

describe('fuseModel', () => {
  it('uses a fixed horizon: the same time left is the same length, whenever the key was added', () => {
    const in10 = '2026-11-14T09:30:00+00:00'
    const addedToday = model({ expires_at: in10, created_at: NOW })
    const addedLongAgo = model({ expires_at: in10, created_at: '2025-01-01T00:00:00+00:00' })
    expect(addedToday.fraction).toBeCloseTo(10 / 90, 5)
    expect(addedLongAgo.fraction).toBe(addedToday.fraction)
    expect(model({ expires_at: '2028-01-01T00:00:00Z' }).fraction).toBe(1) // beyond the horizon: full
    expect(model({ expires_at: in10 }, 30).fraction).toBeCloseTo(10 / 30, 5)
  })

  it('takes the tone from the backend expiry state (which knows soon_days)', () => {
    // 30 days left: green with soon_days = 14, amber if config.toml says soon_days = 60.
    const in30 = '2026-12-04T09:30:00+00:00'
    expect(model({ expires_at: in30, expiry_state: 'scheduled' }).tone).toBe('green')
    expect(model({ expires_at: in30, expiry_state: 'soon' }).tone).toBe('amber')
    const gone = model({ expires_at: '2026-11-01T00:00:00Z', expiry_state: 'expired' })
    expect(gone.tone).toBe('red')
    expect(gone.fraction).toBe(0)
    expect(gone.text).toMatch(/^Expired/)
  })

  it('without a known date it says so', () => {
    const m = model({ expires_at: null })
    expect(m.fraction).toBeNull()
    expect(m.text).toBe('No known date')
  })
})

describe('Fuse', () => {
  const future = { expires_at: '2026-12-31T00:00:00Z' }

  it('is an accessible meter with an animated spark', () => {
    renderUi(<Fuse model={model(future)} />)
    const meter = screen.getByRole('meter')
    expect(meter).toHaveAttribute('value')
    expect(meter).toHaveAccessibleName(/Expires/)
    expect(screen.getByTestId('fuse-spark')).toBeInTheDocument()
  })

  it('respects prefers-reduced-motion: no spark', () => {
    renderUi(<Fuse model={model(future)} />, { reducedMotion: 'always' })
    expect(screen.getByRole('meter')).toBeInTheDocument()
    expect(screen.queryByTestId('fuse-spark')).toBeNull()
  })

  it('unknown date is a dotted bar with text, not just a colour', () => {
    renderUi(<Fuse model={model({ expires_at: null })} />)
    expect(screen.getByRole('img', { name: 'No known date' })).toBeInTheDocument()
    expect(screen.getByText('No known date')).toBeInTheDocument()
  })
})
