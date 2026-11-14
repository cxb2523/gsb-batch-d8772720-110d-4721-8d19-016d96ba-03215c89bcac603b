/**
 * Did the UI miss a server event? The listing says at which event position (boot, seq) it
 * was computed; a new event stream first says `hello` with the current position. Events
 * after the hello arrive on the stream, so only a gap before it matters:
 *
 * - another server start (boot differs): everything may have changed;
 * - the listing is older than the hello (listing.seq < hello.seq): events were missed.
 *
 * A listing computed after the hello (listing.seq > hello.seq) already includes them.
 */
export interface EventPosition {
  boot: string
  seq: number
}

export function missedEvents(
  listing: EventPosition | undefined,
  hello: EventPosition | undefined,
): boolean {
  if (!listing || !hello) return false // compared once both are known
  return listing.boot !== hello.boot || listing.seq < hello.seq
}
