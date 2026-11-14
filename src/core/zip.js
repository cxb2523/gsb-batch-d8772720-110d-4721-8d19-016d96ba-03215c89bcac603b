/**
 * axuse — zero-dependency PKZip extraction (Node's zlib only).
 *
 * Exists for `axuse install-browser`: provisioning a pinned Chrome-for-
 * Testing build on a bare server WITHOUT sudo (no apt repo, no unzip
 * binary, no npm packages) — the same zero-dep discipline as the rest of
 * axuse. Handles the two compression methods CfT archives use (STORE and
 * DEFLATE) and, critically, restores the Unix exec bits from the central
 * directory's external attributes (a chrome binary without +x is a very
 * confusing failure).
 */
import { inflateRawSync } from "node:zlib";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** Find the End Of Central Directory record (search back for its signature;
 *  the comment field makes its offset variable). */
function findEocd(buf) {
  const SIG = 0x06054b50;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_536); i--) {
    if (buf.readUInt32LE(i) === SIG) return i;
  }
  throw new Error("not a zip: End Of Central Directory not found");
}

/**
 * Extract one zip archive into `outDir`.
 * @param {Buffer} buf the archive bytes
 * @param {(name: string) => void} [onEntry] progress hook (called after each entry)
 * @returns {{ files: number, bytes: number }} extraction accounting
 */
export function unzip(buf, outDir, { onEntry, writeEntry } = {}) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  let files = 0;
  let bytes = 0;
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`corrupt zip: bad central directory entry at ${p}`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttrs = buf.readUInt32LE(p + 38);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    // Zip-path traversal guard: entries must stay inside the target root.
    const target = join(resolve(outDir), name);
    if (!target.startsWith(resolve(outDir) + sep)) {
      throw new Error(`zip entry escapes the target directory: ${name}`);
    }
    if (name.endsWith("/")) { mkdirSync(target, { recursive: true }); continue; }

    // Local header: skip its (own) name+extra lengths to the payload.
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`corrupt zip: bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataAt = localOff + 30 + lNameLen + lExtraLen;
    const payload = buf.subarray(dataAt, dataAt + compSize);
    const data = method === 0 ? Buffer.from(payload)
      : method === 8 ? inflateRawSync(payload)
        : (() => { throw new Error(`unsupported compression method ${method} for ${name}`); })();
    if (data.length !== size) throw new Error(`corrupt zip: size mismatch for ${name} (${data.length} ≠ ${size})`);

    mkdirSync(dirname(target), { recursive: true });
    if (writeEntry) writeEntry(target, data);
    else writeFileSync(target, data);
    // Unix permissions live in the high half of the external attributes;
    // without this the chrome binary lands without +x and "does not run".
    const mode = (extAttrs >>> 16) & 0o7777;
    if (mode) { try { chmodSync(target, mode); } catch {} }
    files++;
    bytes += data.length;
    if (onEntry) onEntry(name);
  }
  return { files, bytes };
}
