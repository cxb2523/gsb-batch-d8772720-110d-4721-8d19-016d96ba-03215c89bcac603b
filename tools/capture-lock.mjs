import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// All capture entry points for this user contend for the same IPC listener,
// independent of the proxy port or checkout. Windows drops the pipe on exit.
const user = createHash('sha256').update(os.userInfo().homedir.toLowerCase()).digest('hex').slice(0, 24);
const address = process.platform === 'win32'
  ? `\\\\.\\pipe\\crazywaterword-capture-${user}`
  : path.join(os.tmpdir(), `crazywaterword-capture-${user}.sock`);

export async function acquireCaptureLock(endpoint = address) {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', (error) => reject(error.code === 'EADDRINUSE' || error.code === 'EACCES'
      ? new Error('采集锁不可用，请先结束当前用户的其他采集任务。') : error));
    server.listen({ path: endpoint, exclusive: true }, resolve);
  });
  server.unref();
  return () => new Promise((resolve) => server.close(resolve));
}
