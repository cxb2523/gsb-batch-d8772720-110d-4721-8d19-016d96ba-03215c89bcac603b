import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NOW, status } from '@/test/fixtures'
import { renderUi } from '@/test/render'
import { CredentialCard } from './CredentialCard'

describe('CredentialCard', () => {
  it('shows status with icon and text, the redacted key and the reasons', () => {
    renderUi(
      <CredentialCard
        item={status({ overall: 'red', reasons: ['validity_invalid'] })}
        now={NOW}
        horizonDays={90}
        onOpen={() => {}}
        onCheck={() => {}}
        checking={false}
      />,
    )
    const pill = screen.getByText('Broken').closest('[data-status]')
    expect(pill).toHaveAttribute('data-status', 'red')
    expect(pill?.querySelector('svg')).not.toBeNull()
    expect(screen.getByText('sk-ant-api03-Qm7…x2Pa')).toBeInTheDocument()
    expect(screen.getByTestId('reasons')).toHaveTextContent('Invalid')
    expect(screen.getByRole('article')).toHaveClass('mecha-burning')
  })

  it('opens and checks from the keyboard', async () => {
    const onOpen = vi.fn()
    const onCheck = vi.fn()
    renderUi(
      <CredentialCard
        item={status({})}
        now={NOW}
        horizonDays={90}
        onOpen={onOpen}
        onCheck={onCheck}
        checking={false}
      />,
    )
    const user = userEvent.setup()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Prod key' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledWith('01DEMO00000000000000000001')
    await user.click(screen.getByRole('button', { name: /Check now/ }))
    expect(onCheck).toHaveBeenCalledOnce()
  })

  it('OAuth credentials have no remote check button', () => {
    renderUi(
      <CredentialCard
        item={status({ overall: 'local', kind: 'oauth_token', reasons: ['local_only'] })}
        now={NOW}
        horizonDays={90}
        onOpen={() => {}}
        onCheck={() => {}}
        checking={false}
      />,
      { lang: 'es' },
    )
    expect(screen.getByText('Solo local')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Comprobar ahora/ })).toBeNull()
  })
})
