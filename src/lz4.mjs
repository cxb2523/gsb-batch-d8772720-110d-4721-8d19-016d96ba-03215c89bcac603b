const blockSizeTable = { 4: 65536, 5: 262144, 6: 1048576, 7: 4194304 };

export function makeBuffer(size) {
  return new Uint8Array(size);
}

export function decompressBlock(source, target, sourceOffset, blockLength, targetOffset) {
  let token;
  let literalLength;
  let matchLength;
  let matchOffset;
  let end;
  let copyEnd;
  const sourceEnd = sourceOffset + blockLength;
  while (sourceOffset < sourceEnd) {
    token = source[sourceOffset++];
    literalLength = token >> 4;
    if (literalLength > 0) {
      if (literalLength === 15) {
        while ((literalLength += source[sourceOffset]), source[sourceOffset++] === 255);
      }
      copyEnd = sourceOffset + literalLength;
      while (sourceOffset < copyEnd) target[targetOffset++] = source[sourceOffset++];
    }
    if (sourceOffset >= sourceEnd) break;
    matchLength = token & 15;
    matchOffset = source[sourceOffset++] | (source[sourceOffset++] << 8);
    if (matchLength === 15) {
      while ((matchLength += source[sourceOffset]), source[sourceOffset++] === 255);
    }
    matchLength += 4;
    end = (copyEnd = targetOffset - matchOffset) + matchLength;
    while (copyEnd < end) target[targetOffset++] = target[copyEnd++];
  }
  return targetOffset;
}

export function hashU32(value) {
  let e = value;
  e = (e | 0) + 2127912214 + (e << 12) | 0;
  e = -949894596 ^ e;
  e = e ^ e >>> 19;
  e = (e + 374761393 + (e << 5)) | 0;
  e = (e + -744332180) ^ e << 9;
  e = (e + -42973499 + (e << 3)) | 0;
  return (-1252372727 ^ e) ^ e >>> 16 | 0;
}

export function makeHashTable() {
  return new Uint32Array(65536);
}

export function compressBlock(source, target, sourceOffset, blockLength, hashTable) {
  let matchIndex;
  let offset;
  let hash;
  let value;
  let literalLength;
  let searchEnd;
  let destOffset = 0;
  let anchor = sourceOffset;
  let scan = sourceOffset;
  const blockEnd = sourceOffset + blockLength;
  if (blockLength >= 13) {
    let step = 67;
    while (scan + 4 < blockEnd - 5) {
      value = source[scan] | (source[scan + 1] << 8) | (source[scan + 2] << 16) | (source[scan + 3] << 24);
      hash = hashU32(value) >>> 0;
      hash = ((hash >> 16) ^ hash) >>> 0 & 65535;
      matchIndex = hashTable[hash] - 1;
      hashTable[hash] = scan + 1;
      if (matchIndex < 0 || (scan - matchIndex) >>> 16 > 0
        || (source[matchIndex] | (source[matchIndex + 1] << 8) | (source[matchIndex + 2] << 16) | (source[matchIndex + 3] << 24)) !== value) {
        scan += step++ >> 6;
        continue;
      }
      step = 67;
      literalLength = scan - anchor;
      offset = scan - matchIndex;
      matchIndex += 4;
      searchEnd = scan += 4;
      while (scan < blockEnd - 5 && source[scan] === source[matchIndex]) {
        scan++;
        matchIndex++;
      }
      const token = ((searchEnd = scan - searchEnd) < 15 ? searchEnd : 15);
      if (literalLength >= 15) {
        target[destOffset++] = 240 + token;
        for (let rest = literalLength - 15; rest >= 255; rest -= 255) target[destOffset++] = 255;
        target[destOffset++] = literalLength - 15 - Math.floor((literalLength - 15) / 255) * 255;
      } else {
        target[destOffset++] = (literalLength << 4) + token;
      }
      for (let i = 0; i < literalLength; i++) target[destOffset++] = source[anchor + i];
      target[destOffset++] = offset;
      target[destOffset++] = offset >> 8;
      if (searchEnd >= 15) {
        for (let rest = searchEnd - 15; rest >= 255; rest -= 255) target[destOffset++] = 255;
        target[destOffset++] = searchEnd - 15 - Math.floor((searchEnd - 15) / 255) * 255;
      }
      anchor = scan;
    }
    if (anchor === 0) return 0;
  }
  literalLength = blockEnd - anchor;
  if (literalLength >= 15) {
    target[destOffset++] = 240;
    for (let rest = literalLength - 15; rest >= 255; rest -= 255) target[destOffset++] = 255;
    target[destOffset++] = literalLength - 15 - Math.floor((literalLength - 15) / 255) * 255;
  } else {
    target[destOffset++] = literalLength << 4;
  }
  for (let i = anchor; i < blockEnd; i++) target[destOffset++] = source[i];
  return destOffset;
}

export function compressBound(length) {
  return (length + length / 255 + 16) | 0;
}

export const BLOCK_SIZES = blockSizeTable;
