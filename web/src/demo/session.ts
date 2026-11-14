/**
 * Web demo replacement for `lib/session`: there is no server and no session token, and the
 * client that calls /api must not be in this build (scripts/check_web_builds.py).
 */
export { ApiError } from '@/lib/errors'

export function initSessionToken(): string {
  return 'static-demo'
}

export function clearSessionToken(): void {}
