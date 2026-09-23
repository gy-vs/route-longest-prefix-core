import { maskHostBits } from './bits.js';

export type Family = 4 | 6;

export const FAMILY_BITS: Readonly<Record<Family, number>> = { 4: 32, 6: 128 };
export const FAMILY_BYTES: Readonly<Record<Family, number>> = { 4: 4, 6: 16 };

export interface Address {
  readonly family: Family;
  /** Full address width: 4 bytes for IPv4, 16 for IPv6. */
  readonly bytes: Uint8Array;
}

export interface Prefix extends Address {
  /**
   * Number of significant bits (0..32 for IPv4, 0..128 for IPv6).
   * Bits at or beyond `length` are guaranteed to be zero.
   */
  readonly length: number;
}

export interface MappedOptions {
  /**
   * How to treat IPv4-mapped IPv6 addresses (::ffff:a.b.c.d):
   * - `'ipv6'` (default): keep them in the IPv6 family, no silent folding.
   * - `'ipv4'`: fold them into the IPv4 family; prefix lengths shift by 96.
   */
  readonly mapped?: 'ipv6' | 'ipv4';
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseIPv4Text(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out[i] = value;
  }
  return out;
}

/**
 * Parses RFC-style IPv6 text, including `::` compression and an embedded
 * dotted-quad tail (e.g. `::ffff:10.0.0.1`).
 */
function parseIPv6Text(text: string): Uint8Array | null {
  let body = text;
  if (body.includes('.')) {
    const colon = body.lastIndexOf(':');
    if (colon < 0) return null;
    const v4 = parseIPv4Text(body.slice(colon + 1));
    if (v4 === null) return null;
    // The dotted quad occupies two 16-bit groups.
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    body = `${body.slice(0, colon)}:${hi}:${lo}`;
  }

  const halves = body.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const groups: number[] = [];
    for (const part of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      groups.push(parseInt(part, 16));
    }
    return groups;
  };

  const left = parseGroups(halves[0]);
  if (left === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const right = parseGroups(halves[1]);
    if (right === null) return null;
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null; // '::' must compress at least one group
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else if (left.length === 8) {
    groups = left;
  } else {
    return null; // not compressed and not 8 groups
  }

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[2 * i] = groups[i] >> 8;
    out[2 * i + 1] = groups[i] & 0xff;
  }
  return out;
}

function parseAddressRaw(text: string): Address {
  const v4 = parseIPv4Text(text);
  if (v4 !== null) return { family: 4, bytes: v4 };
  const v6 = parseIPv6Text(text);
  if (v6 !== null) return { family: 6, bytes: v6 };
  throw new Error(`invalid IP address: ${JSON.stringify(text)}`);
}

// ---------------------------------------------------------------------------
// IPv4-mapped policy
// ---------------------------------------------------------------------------

/** True for IPv6 bytes of the form ::ffff:a.b.c.d. */
export function isIPv4Mapped(bytes: Uint8Array): boolean {
  if (bytes.length !== 16 || bytes[10] !== 0xff || bytes[11] !== 0xff) return false;
  for (let i = 0; i < 10; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

/** Fold an IPv4-mapped IPv6 address into IPv4; everything else is unchanged. */
export function convertMappedAddress(address: Address): Address {
  if (address.family === 6 && isIPv4Mapped(address.bytes)) {
    return { family: 4, bytes: address.bytes.slice(12) };
  }
  return address;
}

/**
 * Fold an IPv4-mapped IPv6 prefix into IPv4 (the length shifts by 96).
 * Prefixes shorter than /96 do not cover only mapped space and are rejected.
 */
export function convertMappedPrefix(prefix: Prefix): Prefix {
  if (prefix.family === 6 && isIPv4Mapped(prefix.bytes)) {
    if (prefix.length < 96) {
      throw new RangeError(
        `cannot fold mapped prefix of length ${prefix.length} (< 96) into IPv4`,
      );
    }
    return {
      family: 4,
      length: prefix.length - 96,
      bytes: maskHostBits(prefix.bytes, prefix.length).slice(12),
    };
  }
  return prefix;
}

// ---------------------------------------------------------------------------
// Public parse / normalize
// ---------------------------------------------------------------------------

export function parseAddress(text: string, options: MappedOptions = {}): Address {
  const address = parseAddressRaw(text);
  return options.mapped === 'ipv4' ? convertMappedAddress(address) : address;
}

export function parsePrefix(text: string, options: MappedOptions = {}): Prefix {
  const slash = text.lastIndexOf('/');
  const addressText = slash < 0 ? text : text.slice(0, slash);
  const address = parseAddressRaw(addressText);
  const max = FAMILY_BITS[address.family];

  let length = max;
  if (slash >= 0) {
    const lengthText = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(lengthText)) {
      throw new Error(`invalid prefix length in ${JSON.stringify(text)}`);
    }
    length = Number(lengthText);
    if (length > max) {
      throw new Error(`prefix length ${length} exceeds ${max} bits in ${JSON.stringify(text)}`);
    }
  }

  // Fold before masking host bits: a length like /95 still contains the
  // full mapped marker in the raw bytes, and the length gate must see it.
  const raw: Prefix = { family: address.family, length, bytes: address.bytes };
  const folded = options.mapped === 'ipv4' ? convertMappedPrefix(raw) : raw;
  return {
    family: folded.family,
    length: folded.length,
    bytes: maskHostBits(folded.bytes, folded.length),
  };
}

function checkFamily(family: Family): void {
  if (family !== 4 && family !== 6) {
    throw new TypeError(`invalid address family: ${String(family)}`);
  }
}

/** Validate an address object and return a private copy of its bytes. */
export function normalizeAddress(address: Address): Address {
  checkFamily(address.family);
  if (address.bytes.length !== FAMILY_BYTES[address.family]) {
    throw new TypeError(
      `family ${address.family} requires ${FAMILY_BYTES[address.family]} bytes, ` +
        `got ${address.bytes.length}`,
    );
  }
  return { family: address.family, bytes: address.bytes.slice() };
}

/** Validate a prefix object, mask host bits, and return private bytes. */
export function normalizePrefix(prefix: Prefix): Prefix {
  checkFamily(prefix.family);
  const max = FAMILY_BITS[prefix.family];
  if (prefix.bytes.length !== FAMILY_BYTES[prefix.family]) {
    throw new TypeError(
      `family ${prefix.family} requires ${FAMILY_BYTES[prefix.family]} bytes, ` +
        `got ${prefix.bytes.length}`,
    );
  }
  if (!Number.isInteger(prefix.length) || prefix.length < 0 || prefix.length > max) {
    throw new RangeError(`prefix length must be an integer in 0..${max}, got ${prefix.length}`);
  }
  return {
    family: prefix.family,
    length: prefix.length,
    bytes: maskHostBits(prefix.bytes, prefix.length),
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatAddress(address: Address): string {
  const { family, bytes } = address;
  if (family === 4) {
    return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
  }
  if (isIPv4Mapped(bytes)) {
    return `::ffff:${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  }

  const groups: number[] = [];
  for (let i = 0; i < 8; i++) groups.push((bytes[2 * i] << 8) | bytes[2 * i + 1]);

  // Longest run of zero groups; ties pick the first run (RFC 5952).
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (runStart < 0) runStart = i;
      const runLength = i - runStart + 1;
      if (runLength > bestLength) {
        bestStart = runStart;
        bestLength = runLength;
      }
    } else {
      runStart = -1;
    }
  }
  if (bestLength < 2) bestStart = -1; // compress runs of two or more only

  let out = '';
  for (let i = 0; i < 8; i++) {
    if (i === bestStart) {
      out += '::';
      i += bestLength - 1;
    } else {
      if (out !== '' && !out.endsWith(':')) out += ':';
      out += groups[i].toString(16);
    }
  }
  return out;
}

export function formatPrefix(prefix: Prefix): string {
  return `${formatAddress(prefix)}/${prefix.length}`;
}
