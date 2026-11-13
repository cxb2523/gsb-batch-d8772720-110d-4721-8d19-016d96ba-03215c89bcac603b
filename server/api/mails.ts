import { defineEventHandler } from 'nuxt/server'
import { seedMails } from '../utils/mail-seed'
import { getCollectedMails } from '../utils/mail-store'

export default defineEventHandler(() => {
  return [...seedMails, ...getCollectedMails()]
})
