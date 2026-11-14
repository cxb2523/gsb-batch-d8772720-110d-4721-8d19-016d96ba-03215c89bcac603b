import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LANG_KEY, useI18n, useSetLang } from '@/i18n'
import { renderUi } from '@/test/render'
import { Footer } from './Footer'

describe('Footer', () => {
  it('credits the author with links to YouTube, GitHub and the books, in new tabs', () => {
    renderUi(<Footer />)
    const footer = screen.getByRole('contentinfo')
    expect(footer).toHaveTextContent('Made by JoaquinRuiz')
    const hrefs = [...footer.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual([
      'https://github.com/JoaquinRuiz',
      'https://youtube.com/@jokioki',
      'https://github.com/JoaquinRuiz',
      'https://amzn.eu/d/0f5t59gm',
      'https://amzn.eu/d/083CTN3U',
    ])
    for (const a of footer.querySelectorAll('a')) {
      expect(a).toHaveAttribute('target', '_blank')
      expect(a).toHaveAttribute('rel', 'noopener noreferrer')
    }
    expect(footer).toHaveTextContent('Del vibe coding al Spec-Driven Development')
    expect(footer).toHaveTextContent('El motor de la Inteligencia Artificial')
  })

  it('is translated', () => {
    renderUi(<Footer />, { lang: 'es' })
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Hecho por JoaquinRuiz')
  })
})

function Switcher() {
  const { t, lang } = useI18n()
  const setLang = useSetLang()
  return (
    <button type="button" onClick={() => setLang(lang === 'es' ? 'en' : 'es')}>
      {t('checkAll')}
    </button>
  )
}

describe('language switch', () => {
  it('changes the language, remembers it and updates <html lang>', () => {
    localStorage.removeItem(LANG_KEY)
    renderUi(<Switcher />)
    const button = screen.getByRole('button')
    expect(button).toHaveTextContent('Check all')
    fireEvent.click(button)
    expect(button).toHaveTextContent('Comprobar todo')
    expect(localStorage.getItem(LANG_KEY)).toBe('es')
    expect(document.documentElement.lang).toBe('es')
    fireEvent.click(button)
    expect(button).toHaveTextContent('Check all')
    expect(localStorage.getItem(LANG_KEY)).toBe('en')
  })
})
