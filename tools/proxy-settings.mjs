import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const KEY = process.env.CW_REG_KEY
  ?? 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
export const BACKUP = process.env.CW_PROXY_BACKUP
  ?? path.resolve(import.meta.dirname, '../certificates/proxy-backup.json');
const VALUES = ['ProxyEnable', 'ProxyServer', 'ProxyOverride'];

export function pointsToCapture(values, port) {
  if (Number(values.ProxyEnable) !== 1) return false;
  return String(values.ProxyServer ?? '').split(';').some((part) => {
    const address = part.split('=').at(-1).trim().replace(/^https?:\/\//i, '').toLowerCase();
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(address);
  });
}

function equals(name, left, right) {
  if (name === 'ProxyEnable' && left !== undefined && right !== undefined) return Number(left) === Number(right);
  return left === right;
}

export function prepareCaptureProxy(settings, port) {
  const original = settings.readCurrent();
  if (pointsToCapture(original, port)) throw new Error('系统代理已指向本机采集端口，请先恢复上次的代理设置，避免覆盖原始备份');
  const target = { ProxyEnable: '0x1', ProxyServer: `127.0.0.1:${port}`, ProxyOverride: '<local>' };
  let ready = false, owned = false;
  let pending = [];
  return {
    original,
    enable() {
      settings.backup(original);
      owned = true;
      pending = VALUES.filter((name) => !equals(name, original[name], target[name]));
      settings.setProxy('127.0.0.1', port, { backedUp: true });
      const active = settings.readCurrent();
      if (!VALUES.every((name) => equals(name, active[name], target[name]))) throw new Error('代理设置写入后校验失败');
      ready = true;
    },
    restore() {
      if (!pending.length) {
        if (owned) { settings.removeBackup?.(); owned = false; }
        return;
      }
      // Restore the enable flag first. If that write fails, leave the server
      // untouched so a retry can still establish which session owns the route.
      for (const name of [...pending]) {
        const active = settings.readCurrent();
        const switchedServer = ready && active.ProxyServer !== target.ProxyServer;
        if (equals(name, active[name], target[name]) && !(switchedServer && name === 'ProxyEnable')) {
          settings.restore(original, [name]);
          if (!equals(name, settings.readCurrent()[name], original[name])) throw new Error('代理还原校验失败');
        }
        pending = pending.filter((field) => field !== name);
      }
      if (owned) { settings.removeBackup?.(); owned = false; }
    },
  };
}

function reg(args) {
  try {
    return execFileSync('reg', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (error) {
    return error.stdout?.toString() ?? '';
  }
}

export function readCurrent() {
  const out = execFileSync('reg', ['query', KEY], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const values = {};
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_\w+\s+(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

export function backup(values = readCurrent()) {
  fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
  fs.writeFileSync(BACKUP, JSON.stringify({ key: KEY, values, savedAt: new Date().toISOString() }, null, 2));
  return values;
}

export function removeBackup() {
  fs.rmSync(BACKUP, { force: true });
}

export function setProxy(host, port, { backedUp = false } = {}) {
  if (!backedUp) backup();
  reg(['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
  reg(['add', KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', `${host}:${port}`, '/f']);
  reg(['add', KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', '<local>', '/f']);
  return readCurrent();
}

export function restore(values, names = VALUES) {
  if (values === undefined) {
    if (!fs.existsSync(BACKUP)) throw new Error(`no backup at ${BACKUP}`);
    values = JSON.parse(fs.readFileSync(BACKUP, 'utf8')).values;
  }
  for (const name of names) {
    const original = values[name];
    if (original === undefined) {
      reg(['delete', KEY, '/v', name, '/f']);
    } else {
      const type = name === 'ProxyEnable' ? 'REG_DWORD' : 'REG_SZ';
      reg(['add', KEY, '/v', name, '/t', type, '/d', original, '/f']);
    }
  }
  return readCurrent();
}

export function isProxyOn() {
  return readCurrent().ProxyEnable === '0x1';
}

function main() {
  const [cmd, host = '127.0.0.1', port = '17321'] = process.argv.slice(2);
  if (cmd === 'show') {
    console.log(readCurrent());
  } else if (cmd === 'backup') {
    console.log('backed up:', backup());
  } else if (cmd === 'set') {
    console.log('now:', setProxy(host, Number(port)));
  } else if (cmd === 'restore') {
    console.log('restored:', restore());
    removeBackup();
  } else {
    console.log('usage: proxy-settings.mjs show | backup | set [host] [port] | restore');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
