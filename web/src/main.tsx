import '@fontsource-variable/geist-mono'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'motion/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { Toaster } from './components/mecha/Toaster'
import { TooltipProvider } from './components/ui/tooltip'
import { detectLang, I18nProvider } from './i18n'
import { installNonce } from './lib/nonce'

// Before the first render: Radix (react-style-singleton) and Motion inject <style>
// elements that the CSP only allows with this per-response nonce.
const nonce = installNonce()

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 5_000 } },
})

createRoot(root).render(
  <StrictMode>
    <MotionConfig nonce={nonce} reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <I18nProvider lang={detectLang()}>
          <TooltipProvider delayDuration={300}>
            <Toaster>
              <App />
            </Toaster>
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
)
