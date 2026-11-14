import { screen } from '@testing-library/react'
import { renderUi } from '@/test/render'
import { App } from './App'

function mockFetch(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify(body), { status }))
}

describe('App', () => {
  it('shows locked on 401', async () => {
    mockFetch(401, { code: 'unauthorized', message: 'nope' })
    renderUi(<App token="bad" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Locked')
  })

  it('shows locked without a token and does not call the API', async () => {
    const fetchMock = mockFetch(200, {})
    renderUi(<App token={null} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Locked')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the token as a bearer header', async () => {
    const fetchMock = mockFetch(401, {})
    renderUi(<App token="tok" />)
    await screen.findByRole('alert')
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer tok')
  })
})
