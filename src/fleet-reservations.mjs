// Each operation owns its confirmation state. Share live predicates rather
// than duplicating their lifetimes or letting one module release another's ship.
const reservations = new WeakMap();

export function registerFleetReservations(client, owner, contains, hasAny = () => true, observe) {
  if (!reservations.has(client)) reservations.set(client, new Map());
  reservations.get(client).set(owner, { contains, hasAny, observe });
}

export function isFleetReserved(client, buildingId, exceptOwner) {
  for (const [owner, { contains }] of reservations.get(client) ?? []) {
    if (owner !== exceptOwner && contains(buildingId)) return true;
  }
  return false;
}

export function hasOtherFleetReservations(client, exceptOwner) {
  for (const [owner, { hasAny }] of reservations.get(client) ?? []) {
    if (owner !== exceptOwner && hasAny()) return true;
  }
  return false;
}

// Manual views can confirm a return even after the original auto task was
// switched off. Only the owning module decides whether the evidence releases it.
export function observeFleetReservations(client, snapshot) {
  for (const { observe } of reservations.get(client)?.values() ?? []) observe?.(snapshot);
}
