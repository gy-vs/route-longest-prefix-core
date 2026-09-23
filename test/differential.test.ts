import { describe, expect, it } from 'vitest';
import {
  FAMILY_BITS,
  FAMILY_BYTES,
  PrefixTable,
} from '../src/index.js';
import type { Address, Family, Prefix } from '../src/index.js';

// ---------------------------------------------------------------------------
// Deterministic PRNG so failures reproduce.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Naive reference model: an independent linear scan over all prefixes.
// It shares no code with the implementation under test.
// ---------------------------------------------------------------------------

function bitOf(bytes: Uint8Array, i: number): number {
  return (bytes[i >> 3] & (0x80 >> (i & 7))) === 0 ? 0 : 1;
}

function covers(prefix: Prefix, address: Address): boolean {
  if (prefix.family !== address.family) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bitOf(prefix.bytes, i) !== bitOf(address.bytes, i)) return false;
  }
  return true;
}

function keyOf(p: Prefix): string {
  return `${p.family}/${p.length}/${Array.from(p.bytes).join('.')}`;
}

interface ModelEntry {
  prefix: Prefix;
  value: string;
}

class NaiveModel {
  private entries = new Map<string, ModelEntry>();

  get size(): number {
    return this.entries.size;
  }

  insert(prefix: Prefix, value: string): void {
    this.entries.set(keyOf(prefix), { prefix, value });
  }

  delete(prefix: Prefix): boolean {
    return this.entries.delete(keyOf(prefix));
  }

  lookup(address: Address): { match: ModelEntry | undefined; candidates: ModelEntry[] } {
    const candidates: ModelEntry[] = [];
    for (const entry of this.entries.values()) {
      if (covers(entry.prefix, address)) candidates.push(entry);
    }
    candidates.sort((a, b) => a.prefix.length - b.prefix.length);
    return { match: candidates[candidates.length - 1], candidates };
  }
}

// ---------------------------------------------------------------------------
// Random workload generator. Prefixes are derived from a live pool so that
// nesting, adjacency and non-byte-aligned boundaries occur constantly.
// ---------------------------------------------------------------------------

function isMappedLocal(bytes: Uint8Array): boolean {
  if (bytes.length !== 16) return false;
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

function maskLocal(bytes: Uint8Array, length: number): Uint8Array {
  const out = bytes.slice();
  for (let i = length; i < out.length * 8; i++) {
    out[i >> 3] &= ~(0x80 >> (i & 7));
  }
  return out;
}

class Generator {
  constructor(private readonly rand: () => number) {}

  private ri(n: number): number {
    return Math.floor(this.rand() * n);
  }

  private randomBytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.ri(256);
    return out;
  }

  private flipFrom(bytes: Uint8Array, start: number): Uint8Array {
    const out = bytes.slice();
    for (let i = start; i < out.length * 8; i++) {
      if (this.rand() < 0.5) out[i >> 3] ^= 0x80 >> (i & 7);
    }
    return out;
  }

  private mappedBytes(): Uint8Array {
    const bytes = new Uint8Array(16);
    bytes[10] = 0xff;
    bytes[11] = 0xff;
    bytes.set(this.randomBytes(4), 12);
    return bytes;
  }

  prefix(pool: Prefix[]): Prefix {
    const mode = this.rand();
    let p: Prefix;
    if (mode < 0.1) {
      // IPv4-mapped IPv6 prefix, always >= /96 so it may fold into IPv4.
      const length = 96 + this.ri(33);
      p = { family: 6, length, bytes: maskLocal(this.mappedBytes(), length) };
    } else if (mode < 0.65 && pool.length > 0) {
      // Derive from a live prefix: shared leading bits, random tail and length.
      const base = pool[this.ri(pool.length)];
      const bits = FAMILY_BITS[base.family];
      const bytes = this.flipFrom(base.bytes, this.ri(bits + 1));
      const length = this.ri(bits + 1);
      p = { family: base.family, length, bytes: maskLocal(bytes, length) };
    } else {
      const family: Family = this.rand() < 0.5 ? 4 : 6;
      const bits = FAMILY_BITS[family];
      const length = this.ri(bits + 1);
      p = { family, length, bytes: maskLocal(this.randomBytes(FAMILY_BYTES[family]), length) };
    }
    // Folding policy requires mapped prefixes to be at least /96.
    if (p.family === 6 && isMappedLocal(p.bytes) && p.length < 96) {
      const length = 96 + this.ri(33);
      p = { family: 6, length, bytes: maskLocal(p.bytes, length) };
    }
    return p;
  }

  address(pool: Prefix[]): Address {
    const mode = this.rand();
    if (mode < 0.15) {
      return { family: 6, bytes: this.mappedBytes() };
    }
    if (mode < 0.65 && pool.length > 0) {
      const base = pool[this.ri(pool.length)];
      const bits = FAMILY_BITS[base.family];
      // Usually flip only host bits so the address stays inside the prefix.
      const start = this.rand() < 0.7 ? base.length : this.ri(bits + 1);
      return { family: base.family, bytes: this.flipFrom(base.bytes, Math.min(start, bits)) };
    }
    const family: Family = this.rand() < 0.5 ? 4 : 6;
    return { family, bytes: this.randomBytes(FAMILY_BYTES[family]) };
  }
}

// ---------------------------------------------------------------------------
// Differential run: replay identical operations on both implementations and
// compare the full lookup result (longest match + candidate trace).
// ---------------------------------------------------------------------------

function convertMappedPrefixLocal(p: Prefix): Prefix {
  if (p.family === 6 && isMappedLocal(p.bytes)) {
    if (p.length < 96) throw new Error('generator bug: mapped prefix shorter than /96');
    return { family: 4, length: p.length - 96, bytes: maskLocal(p.bytes, p.length).slice(12) };
  }
  return p;
}

function convertMappedAddressLocal(a: Address): Address {
  return a.family === 6 && isMappedLocal(a.bytes) ? { family: 4, bytes: a.bytes.slice(12) } : a;
}

function describeEntry(e: { prefix: Prefix; value: string }): string {
  return `${e.value}@${keyOf(e.prefix)}`;
}

function runDifferential(seed: number, mapped: 'ipv6' | 'ipv4', operations: number): void {
  const rand = mulberry32(seed);
  const gen = new Generator(rand);
  const table = new PrefixTable<string>({ mapped });
  const model = new NaiveModel();
  const pool: Prefix[] = []; // raw (pre-conversion) prefixes believed live
  let values = 0;

  const convertP = (p: Prefix): Prefix => (mapped === 'ipv4' ? convertMappedPrefixLocal(p) : p);
  const convertA = (a: Address): Address => (mapped === 'ipv4' ? convertMappedAddressLocal(a) : a);

  const checkLookup = (rawAddress: Address): void => {
    const address = convertA(rawAddress);
    const got = table.lookup(address);
    const want = model.lookup(address);
    expect(
      got.candidates.map(describeEntry),
      `candidates for ${JSON.stringify(address)}`,
    ).toEqual(want.candidates.map(describeEntry));
    expect(got.match && describeEntry(got.match)).toEqual(want.match && describeEntry(want.match));
  };

  for (let i = 0; i < operations; i++) {
    const roll = rand();
    if (roll < 0.45 || pool.length === 0) {
      const raw = gen.prefix(pool);
      const p = convertP(raw);
      const value = `v${values++}`;
      table.insert(p, value);
      model.insert(p, value);
      pool.push(raw);
    } else if (roll < 0.7) {
      const raw = pool[Math.floor(rand() * pool.length)];
      const p = convertP(raw);
      expect(table.delete(p)).toBe(model.delete(p));
      const gone = keyOf(p);
      for (let j = pool.length - 1; j >= 0; j--) {
        if (keyOf(convertP(pool[j])) === gone) pool.splice(j, 1);
      }
    } else {
      checkLookup(gen.address(pool));
    }
    expect(table.size).toBe(model.size);
  }

  for (let i = 0; i < 200; i++) checkLookup(gen.address(pool));
}

describe('randomized differential test against a naive linear-scan model', () => {
  for (const mapped of ['ipv6', 'ipv4'] as const) {
    for (const seed of [1, 7, 42, 1337, 20260923]) {
      it(`agrees on ${1500} random ops (mapped=${mapped}, seed=${seed})`, () => {
        runDifferential(seed, mapped, 1500);
      });
    }
  }
});
