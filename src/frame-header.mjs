// Inspect the game's envelope without loading protobuf definitions or decoding credentials.
// A raw sample proves only that this envelope matched, not that the login was accepted.
export function inspectGameFrame(input) {
  const bytes = input instanceof Uint8Array ? input
    : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!bytes || bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getInt32(0) !== bytes.byteLength - 4 || view.getUint8(4) !== 2) return null;
  const nameLength = view.getUint8(9);
  if (!nameLength || nameLength > 127 || 11 + nameLength > bytes.byteLength) return null;
  const nameBytes = bytes.subarray(10, 10 + nameLength);
  const name = String.fromCharCode(...nameBytes);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  const flag = view.getUint8(10 + nameLength);
  const payloadOffset = 11 + nameLength + (flag ? 4 : 0);
  if (payloadOffset > bytes.byteLength) return null;
  if (flag && view.getInt32(11 + nameLength) < 0) return null;
  return { version: 2, name, seq: view.getInt32(5), flag, payloadOffset };
}
