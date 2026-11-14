import { useI18n } from '@/i18n'

const AUTHOR = { name: 'JoaquinRuiz', github: 'https://github.com/JoaquinRuiz' }
const YOUTUBE = 'https://youtube.com/@jokioki'
const BOOKS = [
  { title: 'Del vibe coding al Spec-Driven Development', url: 'https://amzn.eu/d/0f5t59gm' },
  { title: 'El motor de la Inteligencia Artificial', url: 'https://amzn.eu/d/083CTN3U' },
]

function External({ href, children }: { href: string; children: React.ReactNode }) {
  const { t } = useI18n()
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline-offset-4 hover:text-foreground hover:underline"
    >
      {children}
      <span className="sr-only"> ({t('opensInNewTab')})</span>
    </a>
  )
}

/** Author credit: shown in the app and in the web demo. Plain links, nothing is loaded. */
export function Footer() {
  const { t } = useI18n()
  return (
    <footer className="border-t" data-testid="footer">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-4 text-muted-foreground text-sm">
        <span>
          {t('footerBy')} <External href={AUTHOR.github}>{AUTHOR.name}</External>
        </span>
        <nav aria-label={t('footerLinks')} className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <External href={YOUTUBE}>YouTube</External>
          <External href={AUTHOR.github}>GitHub</External>
          <span className="flex flex-wrap items-center gap-x-2">
            <span>{t('footerBooks')}:</span>
            {BOOKS.map((b, i) => (
              <span key={b.url}>
                <External href={b.url}>
                  <cite className="not-italic">{b.title}</cite>
                </External>
                {i < BOOKS.length - 1 && <span aria-hidden="true"> · </span>}
              </span>
            ))}
          </span>
        </nav>
      </div>
    </footer>
  )
}
