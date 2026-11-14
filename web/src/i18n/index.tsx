import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react'
import { en, type MessageKey } from './en'
import { es } from './es'

export type Lang = 'en' | 'es'
const DICTS: Record<Lang, Record<MessageKey, string>> = { en, es }

export function detectLang(doc: Document = document): Lang {
  return doc.documentElement.lang === 'es' ? 'es' : 'en'
}

type Params = Record<string, string | number>

export interface I18n {
  lang: Lang
  t: (key: MessageKey, params?: Params) => string
  has: (key: string) => boolean
  /** Plural form via Intl.PluralRules; `base` + ".one"/".other" keys, "#" = number. */
  plural: (base: 'plural.credential', count: number) => string
  relative: (date: string | Date, now: string | Date) => string
  date: (date: string | Date) => string
  time: (date: string | Date) => string
  money: (amount: number | string, currency?: string | null) => string
  number: (n: number) => string
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
]

export function makeI18n(lang: Lang): I18n {
  const dict = DICTS[lang]
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  const rules = new Intl.PluralRules(lang)
  const nf = new Intl.NumberFormat(lang)
  const df = new Intl.DateTimeFormat(lang, { dateStyle: 'medium' })
  const tf = new Intl.DateTimeFormat(lang, { timeStyle: 'short' })
  const t = (key: MessageKey, params: Params = {}) =>
    dict[key].replace(/\{(\w+)\}/g, (m, name: string) =>
      name in params ? String(params[name]) : m,
    )
  return {
    lang,
    t,
    has: (key) => Object.hasOwn(dict, key),
    plural: (base, count) => {
      const form = rules.select(count) === 'one' ? 'one' : 'other'
      return t(`${base}.${form}` as MessageKey).replace('#', nf.format(count))
    },
    relative: (date, now) => {
      const seconds = (new Date(date).getTime() - new Date(now).getTime()) / 1000
      for (const [unit, size] of UNITS) {
        if (Math.abs(seconds) >= size || unit === 'second') {
          return rtf.format(Math.round(seconds / size), unit)
        }
      }
      return rtf.format(0, 'second')
    },
    date: (date) => df.format(new Date(date)),
    time: (date) => tf.format(new Date(date)),
    money: (amount, currency) =>
      new Intl.NumberFormat(lang, {
        style: 'currency',
        currency: currency || 'USD',
        maximumFractionDigits: 2,
      }).format(Number(amount)),
    number: (n) => nf.format(n),
  }
}

const I18nContext = createContext<I18n>(makeI18n('en'))

export const LANG_KEY = 'mecha.lang'

/** Change the language, remember it in this browser and update <html lang>. */
const SetLangContext = createContext<(lang: Lang) => void>(() => {})

export function I18nProvider({ lang: initial, children }: { lang: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial)
  const value = useMemo(() => makeI18n(lang), [lang])
  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    document.documentElement.lang = next
    try {
      window.localStorage.setItem(LANG_KEY, next)
    } catch {
      // storage blocked: the choice lasts for this page only
    }
  }, [])
  return (
    <SetLangContext.Provider value={setLang}>
      <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
    </SetLangContext.Provider>
  )
}

export function useSetLang(): (lang: Lang) => void {
  return useContext(SetLangContext)
}

export function useI18n(): I18n {
  return useContext(I18nContext)
}
