import { QueryClient } from '@tanstack/react-query'
import { screen, waitFor } from '@testing-library/react'
import type { Api } from '@/lib/api'
import { SCAN_PROGRESS_KEY } from '@/lib/scan'
import { renderUi } from '@/test/render'
import { ScanPanel } from './ScanPanel'

describe('ScanPanel', () => {
  it('is running only if the server says so, whatever the last progress event was', async () => {
    // A reconnect lost scan_done: the last progress event still says "running".
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(SCAN_PROGRESS_KEY, { files: 120, outcome: 'running' })
    const api = {
      scanState: async () => ({ running: false, protected_option: false, report: null }),
    } as unknown as Api
    renderUi(<ScanPanel api={api} onDone={() => {}} />, { client })
    const start = await screen.findByRole('button', { name: 'Scan my home folder' })
    await waitFor(() => expect(start).toBeEnabled())
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.queryByTestId('scan-progress')).toBeNull()
  })
})
