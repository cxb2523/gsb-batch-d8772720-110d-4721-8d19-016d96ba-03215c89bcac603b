import fs from 'node:fs';
import path from 'node:path';
import { GameClient } from '../src/client.mjs';
import { loadProtocol } from '../src/proto.mjs';

// Corrupts the stored signature and asserts the server rejects the login while the
// client stays alive. A clean protocol-level rejection also proves the framing is right.
const CREDENTIALS = path.resolve(import.meta.dirname, '../data/credentials.json');
const raw = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8'));
const login = JSON.parse(JSON.stringify(raw.login));

const sign = login.eworldParams?.sign;
if (typeof sign !== 'string' || sign.length === 0) {
  throw new Error('stored credentials have no eworldParams.sign to corrupt');
}
login.eworldParams.sign = `${sign.slice(0, -1)}${sign.at(-1) === '0' ? '1' : '0'}`;

const client = new GameClient({ url: raw.url, protocol: loadProtocol() });
let fatal = null;
client.on('fatal', (info) => { fatal = info; });
client.on('warn', (message) => console.log(`warn: ${message}`));

try {
  const response = await client.connect(login);
  console.log(`unexpected success: ${JSON.stringify(response)}`);
  client.stop();
  process.exitCode = 1;
} catch (error) {
  console.log(`rejected as expected: ${error.message}`);
  console.log(`fatal event: ${JSON.stringify(fatal)}`);
  console.log(`state: ${client.state}`);
  client.stop();
  if (fatal) process.exitCode = 1;
}
