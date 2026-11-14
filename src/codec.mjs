import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { decompressBlock } from './lz4.mjs';

const require = createRequire(import.meta.url);
const minimal = require('protobufjs/minimal');
const { Reader, Writer } = minimal;

export const PROTOCOL_VERSION = 2;
export const HEADER_PREFIX = 10;
export const MAX_NAME_LENGTH = 127;
export const FLAG_PLAIN = 0;
export const FLAG_LZ4 = 1;

export function createCodec(protocol, { optionalPush } = {}) {
  function typeOf(name) {
    const type = protocol[name];
    if (!type || typeof type.encode !== 'function') {
      throw new Error(`Unknown message type: ${name}`);
    }
    return type;
  }

  function encode(name, seq, body) {
    if (!name) throw new Error('Message name cannot be empty');
    const nameLength = name.length;
    if (nameLength > MAX_NAME_LENGTH) throw new Error(`Message name too long: ${name}`);
    const payload = typeOf(name).encode(body || {}, Writer.create()).finish();
    const headerLength = HEADER_PREFIX + nameLength + 1;
    const frame = new Uint8Array(headerLength + payload.byteLength);
    const view = new DataView(frame.buffer);
    view.setInt32(0, frame.byteLength - 4);
    view.setInt8(4, PROTOCOL_VERSION);
    view.setInt32(5, seq);
    view.setInt8(9, nameLength);
    for (let i = 0; i < nameLength; i += 1) view.setUint8(10 + i, name.charCodeAt(i));
    view.setInt8(HEADER_PREFIX + nameLength, FLAG_PLAIN);
    frame.set(payload, headerLength);
    return frame;
  }

  function decode(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return decodeView(view);
  }

  function decodeView(view) {
    const version = view.getInt8(4);
    if (version !== PROTOCOL_VERSION) throw new Error(`Unsupported protocol version: ${version}`);
    const declaredLength = view.getInt32(0);
    if (declaredLength !== view.byteLength - 4) {
      throw new Error(`Frame length mismatch: header says ${declaredLength}, got ${view.byteLength - 4}`);
    }
    const seq = view.getInt32(5);
    const nameLength = view.getInt8(9);
    const name = String.fromCharCode.apply(
      String,
      new Uint8Array(view.buffer, view.byteOffset + HEADER_PREFIX, nameLength),
    );
    const flagOffset = HEADER_PREFIX + nameLength;
    const flag = view.getInt8(flagOffset);
    let payload;
    if (flag) {
      const decompressedLength = view.getInt32(flagOffset + 1);
      const sourceOffset = flagOffset + 5;
      const sourceLength = view.byteLength - sourceOffset;
      const source = new Uint8Array(view.buffer, view.byteOffset + sourceOffset, sourceLength);
      payload = new Uint8Array(decompressedLength);
      decompressBlock(source, payload, 0, sourceLength, 0);
    } else {
      const payloadOffset = flagOffset + 1;
      payload = new Uint8Array(view.buffer, view.byteOffset + payloadOffset, view.byteLength - payloadOffset);
    }
    if (name === optionalPush && !protocol[name]) return { seq, name, skipped: true };
    const body = typeOf(name).decode(Reader.create(payload));
    return { seq, name, body };
  }

  return { encode, decode, decodeView };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === 'selftest') {
    import('./selftest.mjs').catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
