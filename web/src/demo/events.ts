import type { StreamOptions } from '@/lib/events'
import { subscribe } from './bus'

/** Same signature as the real `connectEvents`, fed by the in-memory API instead of /api. */
export async function connectEvents({ onEvent, onOpen, signal }: StreamOptions): Promise<void> {
  if (signal.aborted) return
  const unsubscribe = subscribe(onEvent)
  onOpen?.()
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
  unsubscribe()
}
