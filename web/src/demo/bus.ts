/** In-page stand-in for the server's event stream (`/api/events`). */
type Listener = (type: string, data: unknown) => void

const listeners = new Set<Listener>()

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emit(type: string, data: unknown): void {
  for (const listener of listeners) listener(type, data)
}
