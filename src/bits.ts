/**
 * Bit-string helpers. Bits are indexed from the most-significant bit of
 * byte 0, so bit `i` lives at byte `i >> 3` under mask `0x80 >> (i & 7)`.
 * All comparison is bit-exact; there is no byte-alignment anywhere.
 */

export function bitAt(bytes: Uint8Array, index: number): number {
  return (bytes[index >> 3] >> (7 - (index & 7))) & 1;
}

/**
 * Number of leading bits `a` and `b` agree on, capped at `limit`.
 * Only the first `limit` bits of either array are inspected.
 */
export function commonBits(a: Uint8Array, b: Uint8Array, limit: number): number {
  let n = 0;
  while (n + 8 <= limit) {
    const diff = a[n >> 3] ^ b[n >> 3];
    if (diff !== 0) return n + (Math.clz32(diff) - 24);
    n += 8;
  }
  while (n < limit && bitAt(a, n) === bitAt(b, n)) n += 1;
  return n;
}

/** Copy of `bytes` with every bit at index >= `length` cleared. */
export function maskHostBits(bytes: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(bytes.length);
  const fullBytes = length >> 3;
  out.set(bytes.subarray(0, fullBytes));
  const remaining = length & 7;
  if (remaining !== 0) {
    out[fullBytes] = bytes[fullBytes] & ((0xff << (8 - remaining)) & 0xff);
  }
  return out;
}
