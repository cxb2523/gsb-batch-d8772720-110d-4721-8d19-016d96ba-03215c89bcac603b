import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTraceLog } from '../src/trace-log.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-trace-log-'));
const file = path.join(dir, 'protocol.log');
const log = createTraceLog(file, { maxBytes: 1024 });
log.write('a'.repeat(700) + '\n');
log.write('b'.repeat(700) + '\n');
log.write('c'.repeat(700) + '\n');
await log.close();
const files = [file, file + '.1'];
assert.deepEqual(log.files, files);
for (const target of files) {
  const stat = fs.statSync(target);
  assert(stat.size > 0 && stat.size <= 1024, target + ' must stay within the size limit');
}
assert.match(fs.readFileSync(file, 'utf8'), /^c+$/m);
assert.match(fs.readFileSync(file + '.1', 'utf8'), /^b+$/m);

const oversized = path.join(dir, 'oversized.log');
fs.writeFileSync(oversized, 'o'.repeat(4096));
const trimmed = createTraceLog(oversized, { maxBytes: 1024 });
trimmed.write('z\n');
await trimmed.close();
assert(fs.statSync(oversized).size <= 1024);
assert.equal(fs.statSync(oversized).size, 2);

const empty = createTraceLog(path.join(dir, 'empty.log'), { maxBytes: 1024 });
assert.equal(fs.existsSync(path.join(dir, 'empty.log')), false, 'lazy: no file before the first write');
await empty.close();
console.log('protocol log rotation selftest ok: bounded files, rotation, oversized truncation and lazy open');
