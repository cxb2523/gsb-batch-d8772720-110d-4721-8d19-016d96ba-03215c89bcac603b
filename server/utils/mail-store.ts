import type { Mail } from '~/types'
import { seedMails } from './mail-seed'

interface CollectedMail {
  mail: Mail
}

// Collected mails live in memory for the lifetime of the server process.
// Each entry keeps its source-side key out of band so deduplication is per-source.
const collected: CollectedMail[] = []
const seenSourceEntries = new Set<string>()

/**
 * Ids already taken by the built-in seed mails. Collected mails keep their
 * source id whenever it does not clash with an existing inbox entry, otherwise
 * they get the next free id so no two inbox mails ever share an id.
 */
const usedIds = new Set<number>(seedMails.map(mail => mail.id))
let nextFreeId = 1

function reserveId(): number {
  while (usedIds.has(nextFreeId)) {
    nextFreeId++
  }
  const id = nextFreeId
  usedIds.add(id)
  nextFreeId++
  return id
}

/**
 * Merge mails fetched from `url` into the inbox.
 * Entries already collected from the same source (same source-internal id)
 * are skipped. Returns the number of newly written mails.
 */
export function mergeCollectedMails(url: string, mails: Mail[]): number {
  const sourceKey = url.trim()
  let fetched = 0

  for (const mail of mails) {
    const entryKey = `${sourceKey}::${mail.id}`
    if (seenSourceEntries.has(entryKey)) {
      continue
    }

    seenSourceEntries.add(entryKey)

    let id = mail.id
    if (usedIds.has(id)) {
      id = reserveId()
    } else {
      usedIds.add(id)
    }

    collected.push({ mail: { ...mail, id } })
    fetched++
  }

  return fetched
}

export function getCollectedMails(): Mail[] {
  return collected.map(entry => entry.mail)
}
