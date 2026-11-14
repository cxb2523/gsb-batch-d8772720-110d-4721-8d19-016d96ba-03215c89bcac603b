import { makeI18n } from '@/i18n'
import { shortPath, whereText } from './text'

describe('scan paths', () => {
  it('shows the home folder as ~ (POSIX and Windows separators)', () => {
    expect(shortPath('/home/ana/proj/.env', '/home/ana')).toBe('~/proj/.env')
    expect(shortPath('/home/ana/proj/.env', '/home/ana/')).toBe('~/proj/.env')
    expect(shortPath('/home/anabel/x', '/home/ana')).toBe('/home/anabel/x')
    expect(shortPath('C:\\Users\\ana\\x.env', 'C:\\Users\\ana')).toBe('~\\x.env')
  })

  it('says the line, or the notebook cell and line', () => {
    const en = makeI18n('en')
    const at = { path: '/h/a/.env', line: 3, cell_line: null }
    expect(whereText(en, at, '/h')).toBe('~/a/.env:3')
    const nb = { path: '/h/n.ipynb', line: 4, cell_line: 2 }
    expect(whereText(makeI18n('es'), nb, '/h')).toBe('~/n.ipynb (celda 4, línea 2)')
  })
})
