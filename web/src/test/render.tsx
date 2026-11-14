import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { MotionConfig } from 'motion/react'
import type { ReactElement } from 'react'
import { Toaster } from '@/components/mecha/Toaster'
import { TooltipProvider } from '@/components/ui/tooltip'
import { I18nProvider, type Lang } from '@/i18n'

export function renderUi(
  ui: ReactElement,
  {
    lang = 'en',
    reducedMotion = 'never',
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  }: { lang?: Lang; reducedMotion?: 'always' | 'never'; client?: QueryClient } = {},
) {
  return render(
    <MotionConfig reducedMotion={reducedMotion}>
      <QueryClientProvider client={client}>
        <I18nProvider lang={lang}>
          <TooltipProvider>
            <Toaster>{ui}</Toaster>
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>
    </MotionConfig>,
  )
}
