import { Toast } from 'radix-ui'
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react'
import { cn } from '@/lib/utils'

/** Minimal toasts on Radix Toast (Sonner injects an un-nonced <style> on import). */
interface ToastItem {
  id: number
  text: string
  tone: 'info' | 'error'
}

const ToastContext = createContext<(text: string, tone?: ToastItem['tone']) => void>(() => {})

export function Toaster({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const push = useCallback((text: string, tone: ToastItem['tone'] = 'info') => {
    setItems((prev) => [...prev.slice(-3), { id: Date.now() + Math.random(), text, tone }])
  }, [])
  return (
    <ToastContext.Provider value={push}>
      <Toast.Provider swipeDirection="right" duration={4000}>
        {children}
        {items.map((item) => (
          <Toast.Root
            key={item.id}
            type={item.tone === 'error' ? 'foreground' : 'background'}
            onOpenChange={(open) => {
              if (!open) setItems((prev) => prev.filter((i) => i.id !== item.id))
            }}
            className={cn(
              'rounded-md border bg-popover px-4 py-3 text-popover-foreground text-sm shadow-lg',
              item.tone === 'error' && 'border-red-500/50',
            )}
          >
            <Toast.Description>{item.text}</Toast.Description>
          </Toast.Root>
        ))}
        <Toast.Viewport className="fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
      </Toast.Provider>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}
