import { loadProtocol, describe } from '../src/proto.mjs';

const t0 = Date.now();
const protocol = loadProtocol();
const stats = describe(protocol);
console.log(`loaded in ${Date.now() - t0}ms`);
console.log(stats);

const probe = ['LoginRequest', 'LoginResponse', 'PingRequest', 'PingResponse', 'Ack', 'Nack'];
for (const name of probe) {
  console.log(name, typeof protocol[name]?.encode === 'function' ? 'ok' : 'MISSING');
}
