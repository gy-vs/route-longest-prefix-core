import { describe, expect, it } from 'vitest';
import {
  formatAddress,
  formatPrefix,
  isIPv4Mapped,
  parseAddress,
  parsePrefix,
} from '../src/index.js';

describe('parseAddress', () => {
  it('parses IPv4 into 4 bytes', () => {
    expect(parseAddress('10.1.2.3')).toEqual({
      family: 4,
      bytes: Uint8Array.from([10, 1, 2, 3]),
    });
  });

  it('rejects malformed IPv4', () => {
    for (const bad of ['10.1.2', '10.1.2.256', '10.1.2.3.4', 'a.b.c.d', '10.1.2.', '']) {
      expect(() => parseAddress(bad), bad).toThrow();
    }
  });

  it('parses compressed and full IPv6 into 16 bytes', () => {
    const expected = Uint8Array.from([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
    expect(parseAddress('2001:db8::1')).toEqual({ family: 6, bytes: expected });
    expect(parseAddress('2001:0db8:0000:0000:0000:0000:0000:0001')).toEqual(
      parseAddress('2001:db8::1'),
    );
    expect(parseAddress('::')).toEqual({ family: 6, bytes: new Uint8Array(16) });
  });

  it('parses embedded dotted-quad tails', () => {
    const mapped = parseAddress('::ffff:10.0.0.1');
    expect(mapped.family).toBe(6);
    expect(isIPv4Mapped(mapped.bytes)).toBe(true);
    expect(mapped.bytes.slice(12)).toEqual(Uint8Array.from([10, 0, 0, 1]));

    const mixed = parseAddress('2001:db8::1.2.3.4');
    expect(mixed.bytes.slice(12)).toEqual(Uint8Array.from([1, 2, 3, 4]));
  });

  it('keeps mapped addresses in IPv6 by default', () => {
    expect(parseAddress('::ffff:10.0.0.1').family).toBe(6);
  });

  it('folds mapped addresses into IPv4 only under the explicit policy', () => {
    expect(parseAddress('::ffff:10.0.0.1', { mapped: 'ipv4' })).toEqual({
      family: 4,
      bytes: Uint8Array.from([10, 0, 0, 1]),
    });
  });

  it('rejects malformed IPv6', () => {
    for (const bad of [
      '1::2::3',
      '1:2:3:4:5:6:7:8:9',
      'gggg::',
      '1:2:3:4:5:6:7',
      '::ffff:999.1.1.1',
      ':::',
      ':',
    ]) {
      expect(() => parseAddress(bad), bad).toThrow();
    }
  });
});

describe('parsePrefix', () => {
  it('parses IPv4 prefixes and masks host bits', () => {
    expect(parsePrefix('10.0.0.0/8')).toEqual({
      family: 4,
      length: 8,
      bytes: Uint8Array.from([10, 0, 0, 0]),
    });
    expect(parsePrefix('10.1.2.3/8')).toEqual(parsePrefix('10.0.0.0/8'));
    expect(parsePrefix('10.0.0.1')).toEqual({
      family: 4,
      length: 32,
      bytes: Uint8Array.from([10, 0, 0, 1]),
    });
  });

  it('parses non-byte-aligned IPv6 prefixes bit-exactly', () => {
    const p57 = parsePrefix('2001:db8:abcd:1294:5678:9abc:def0:1234/57');
    expect(p57.length).toBe(57);
    expect(p57.bytes[6]).toBe(0x12); // 7 full bytes
    expect(p57.bytes[7]).toBe(0x80); // only the top bit of byte 7 survives
    expect(p57.bytes[8]).toBe(0);

    const p73 = parsePrefix('2001:db8:0:0:80::/73');
    expect(p73.length).toBe(73);
    expect(p73.bytes[9]).toBe(0x80); // the 73rd bit is the top bit of byte 9
    expect(p73.bytes[10]).toBe(0);
  });

  it('accepts /0 and the family maxima /32 and /128', () => {
    expect(parsePrefix('0.0.0.0/0')).toEqual({ family: 4, length: 0, bytes: new Uint8Array(4) });
    expect(parsePrefix('::/0')).toEqual({ family: 6, length: 0, bytes: new Uint8Array(16) });
    expect(parsePrefix('192.0.2.1/32').length).toBe(32);
    expect(parsePrefix('2001:db8::1/128').length).toBe(128);
  });

  it('rejects over-long lengths', () => {
    expect(() => parsePrefix('10.0.0.0/33')).toThrow();
    expect(() => parsePrefix('2001:db8::/129')).toThrow();
    expect(() => parsePrefix('10.0.0.0/')).toThrow();
  });

  it('keeps mapped prefixes in IPv6 by default', () => {
    const p = parsePrefix('::ffff:10.0.0.0/104');
    expect(p.family).toBe(6);
    expect(p.length).toBe(104);
  });

  it('folds mapped prefixes into IPv4 only under the explicit policy', () => {
    expect(parsePrefix('::ffff:10.0.0.0/104', { mapped: 'ipv4' })).toEqual({
      family: 4,
      length: 8,
      bytes: Uint8Array.from([10, 0, 0, 0]),
    });
    expect(parsePrefix('::ffff:10.0.0.1', { mapped: 'ipv4' })).toEqual({
      family: 4,
      length: 32,
      bytes: Uint8Array.from([10, 0, 0, 1]),
    });
    // A mapped prefix shorter than /96 spans more than mapped space.
    expect(() => parsePrefix('::ffff:0:0/95', { mapped: 'ipv4' })).toThrow();
  });
});

describe('format', () => {
  it('formats IPv6 canonically (longest zero run, first tie wins)', () => {
    expect(formatAddress(parseAddress('2001:0db8:0000:0000:0000:0000:0000:0001'))).toBe(
      '2001:db8::1',
    );
    expect(formatAddress(parseAddress('::'))).toBe('::');
    expect(formatAddress(parseAddress('1::'))).toBe('1::');
    expect(formatAddress(parseAddress('2001:db8:0:1:0:0:0:1'))).toBe('2001:db8:0:1::1');
    expect(formatAddress(parseAddress('::ffff:10.0.0.1'))).toBe('::ffff:10.0.0.1');
  });

  it('round-trips representative prefixes', () => {
    for (const text of [
      '10.0.0.0/8',
      '0.0.0.0/0',
      '192.168.1.128/25',
      '2001:db8::/32',
      '2001:db8:abcd:1200::/57',
      '::/0',
      '2001:db8::1/128',
      '::ffff:10.0.0.0/104',
    ]) {
      expect(formatPrefix(parsePrefix(text)), text).toBe(text);
    }
  });
});
