import { setTimeout as sleep } from 'node:timers/promises';

const nextChallengeAt = new WeakMap();
export const CHALLENGE_INTERVAL_MS = 5000;

// 主线与试炼共用服务器挑战限频；必须在账号串行队列内等待，发送前再检查开关。
export async function waitForChallenge(client, { signal, wait = sleep, now = Date.now, beforeSend } = {}) {
  signal?.throwIfAborted();
  const remaining = (nextChallengeAt.get(client) ?? 0) - now();
  if (remaining > 0) await wait(remaining, undefined, { signal });
  signal?.throwIfAborted();
  await beforeSend?.();
  signal?.throwIfAborted();
  nextChallengeAt.set(client, now() + CHALLENGE_INTERVAL_MS);
}
