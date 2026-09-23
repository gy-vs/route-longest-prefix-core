import { describe, expect, it } from 'vitest';
import { PrefixTable, formatPrefix } from '../src/index.js';

const lengths = <V>(r: { candidates: readonly { prefix: { length: number } }[] }): number[] =>
  r.candidates.map((c) => c.prefix.length);
const texts = <V>(r: { candidates: readonly { prefix: { length: number } }[] }): string[] =>
  (r.candidates as readonly { prefix: Parameters<typeof formatPrefix>[0] }[]).map((c) =>
    formatPrefix(c.prefix),
  );

describe('default routes /0', () => {
  it('matches any address but defers to more specific prefixes', () => {
    const t = new PrefixTable<string>();
    t.insert('0.0.0.0/0', 'v4-default');
    t.insert('::/0', 'v6-default');
    expect(t.lookup('203.0.113.9').match?.value).toBe('v4-default');
    expect(t.lookup('2001:db8::1').match?.value).toBe('v6-default');

    t.insert('203.0.113.0/24', 'specific');
    const r = t.lookup('203.0.113.9');
    expect(r.match?.value).toBe('specific');
    expect(lengths(r)).toEqual([0, 24]);
  });

  it('does not let one family default route cover the other family', () => {
    const t = new PrefixTable<string>();
    t.insert('0.0.0.0/0', 'v4');
    expect(t.lookup('2001:db8::1').match).toBeUndefined();
    expect(t.lookup('::').match).toBeUndefined();
  });
});

describe('host routes /32 and /128', () => {
  it('matches the single host and still falls back to the network', () => {
    const t = new PrefixTable<string>();
    t.insert('192.0.2.0/24', 'net4');
    t.insert('192.0.2.1/32', 'host4');
    t.insert('2001:db8::/64', 'net6');
    t.insert('2001:db8::1/128', 'host6');

    expect(t.lookup('192.0.2.1').match?.value).toBe('host4');
    expect(t.lookup('192.0.2.2').match?.value).toBe('net4');
    expect(t.lookup('2001:db8::1').match?.value).toBe('host6');
    expect(t.lookup('2001:db8::2').match?.value).toBe('net6');
  });
});

describe('non-byte-aligned prefixes', () => {
  it('keeps two /57s distinct when they differ only in bit 56', () => {
    // Byte 7: 0x00 (bit 56 = 0) vs 0x80 (bit 56 = 1). A byte-only
    // comparison would collapse these into one route.
    const t = new PrefixTable<string>();
    t.insert('2001:db8:abcd:1200::/57', 'a');
    t.insert('2001:db8:abcd:1280::/57', 'b');
    expect(t.size).toBe(2);
    expect(t.lookup('2001:db8:abcd:1200::1').match?.value).toBe('a');
    expect(t.lookup('2001:db8:abcd:12ff::1').match?.value).toBe('b');
    expect(t.lookup('2001:db8:abcd:1300::1').match).toBeUndefined();
  });

  it('keeps two /73s distinct when they differ only in bit 72', () => {
    const t = new PrefixTable<string>();
    t.insert('2001:db8::/73', 'low');
    t.insert('2001:db8:0:0:80::/73', 'high');
    expect(t.lookup('2001:db8::1').match?.value).toBe('low');
    expect(t.lookup('2001:db8:0:0:80::1').match?.value).toBe('high');
  });

  it('never lets a shorter route override a more specific one', () => {
    const make = () => {
      const t = new PrefixTable<string>();
      t.insert('2001:db8::/32', 'short');
      t.insert('2001:db8:abcd:1200::/57', 'specific');
      return t;
    };
    // Same table, both insertion orders.
    for (const t of [make(), (() => {
      const u = new PrefixTable<string>();
      u.insert('2001:db8:abcd:1200::/57', 'specific');
      u.insert('2001:db8::/32', 'short');
      return u;
    })()]) {
      const inside = t.lookup('2001:db8:abcd:1200::');
      expect(inside.match?.value).toBe('specific');
      expect(lengths(inside)).toEqual([32, 57]);

      // Bit 56 set, so outside the /57 but still inside the /32.
      expect(t.lookup('2001:db8:abcd:1280::').match?.value).toBe('short');
      // Different /32 entirely.
      expect(t.lookup('2001:db9::').match).toBeUndefined();
    }
  });

  it('stacks odd-length prefixes (/56, /57, /73, /120, /128)', () => {
    const t = new PrefixTable<string>();
    t.insert('2001:db8::/32', '32');
    t.insert('2001:db8:abcd:1200::/56', '56');
    t.insert('2001:db8:abcd:1200::/57', '57');
    t.insert('2001:db8:0:0:80::/73', '73');
    t.insert('2001:db8:0:0:80::/120', '120');
    t.insert('2001:db8:0:0:80::beef/128', '128');

    expect(lengths(t.lookup('2001:db8:abcd:1200::1'))).toEqual([32, 56, 57]);
    expect(lengths(t.lookup('2001:db8:abcd:1280::1'))).toEqual([32, 56]);
    expect(lengths(t.lookup('2001:db8:0:0:80::5'))).toEqual([32, 73, 120]);
    expect(lengths(t.lookup('2001:db8:0:0:80::beef'))).toEqual([32, 73, 128]);
    expect(t.lookup('2001:db8:0:0:80::1').match?.value).toBe('120');
  });
});

describe('adjacent prefixes', () => {
  it('splits /24 into two adjacent /25 siblings', () => {
    const t = new PrefixTable<string>();
    t.insert('10.0.0.0/25', 'low');
    t.insert('10.0.0.128/25', 'high');
    expect(t.lookup('10.0.0.1').match?.value).toBe('low');
    expect(t.lookup('10.0.0.127').match?.value).toBe('low');
    expect(t.lookup('10.0.0.128').match?.value).toBe('high');
    expect(t.lookup('10.0.0.255').match?.value).toBe('high');
    expect(t.lookup('10.0.1.0').match).toBeUndefined();
  });

  it('handles adjacent /31 pairs and a /32 between them', () => {
    const t = new PrefixTable<string>();
    t.insert('192.0.2.0/31', 'link-a');
    t.insert('192.0.2.2/31', 'link-b');
    t.insert('192.0.2.1/32', 'router');
    expect(t.lookup('192.0.2.0').match?.value).toBe('link-a');
    expect(t.lookup('192.0.2.1').match?.value).toBe('router');
    expect(t.lookup('192.0.2.2').match?.value).toBe('link-b');
    expect(t.lookup('192.0.2.3').match?.value).toBe('link-b');
  });

  it('keeps adjacent IPv6 prefixes distinct at /63 boundaries', () => {
    const t = new PrefixTable<string>();
    t.insert('2001:db8::/63', 'a');
    t.insert('2001:db8:0:2::/63', 'b');
    expect(t.lookup('2001:db8::1').match?.value).toBe('a');
    expect(t.lookup('2001:db8:0:1::').match?.value).toBe('a');
    expect(t.lookup('2001:db8:0:2::').match?.value).toBe('b');
    expect(t.lookup('2001:db8:0:3:ffff::').match?.value).toBe('b');
  });
});

describe('family isolation and mapped policy', () => {
  it('isolates IPv4 from IPv6', () => {
    const t = new PrefixTable<string>();
    t.insert('10.0.0.0/8', 'v4');
    t.insert('0a00::/8', 'v6');
    expect(t.lookup('10.1.2.3').match?.value).toBe('v4');
    expect(t.lookup('0a00::1').match?.value).toBe('v6');
    expect(t.lookup('10.1.2.3').candidates).toHaveLength(1);
  });

  it('does not fold mapped addresses into IPv4 by default', () => {
    const t = new PrefixTable<string>();
    t.insert('10.0.0.0/8', 'v4');
    t.insert('::ffff:10.0.0.0/104', 'mapped-v6');
    // The mapped address is an IPv6 lookup and hits the IPv6 route only.
    expect(t.lookup('::ffff:10.1.2.3').match?.value).toBe('mapped-v6');
    expect(t.lookup('10.1.2.3').match?.value).toBe('v4');
    expect(t.lookup('2001:db8::1').match).toBeUndefined();
  });

  it('folds mapped addresses only with the explicit mapped: ipv4 policy', () => {
    const t = new PrefixTable<string>({ mapped: 'ipv4' });
    t.insert('10.0.0.0/8', 'v4');
    expect(t.lookup('::ffff:10.1.2.3').match?.value).toBe('v4');

    // A mapped prefix inserted in IPv6 notation lands in the IPv4 trie:
    // ::ffff:192.0.2.0/120 == 192.0.2.0/24.
    t.insert('::ffff:192.0.2.0/120', 'mapped-net');
    expect(t.lookup('192.0.2.7').match?.value).toBe('mapped-net');
    expect(t.lookup('::ffff:192.0.2.7').match?.value).toBe('mapped-net');
    expect(t.lookup('192.0.3.7').match).toBeUndefined();
  });
});

describe('candidate trace', () => {
  it('returns every matching prefix passed during the descent', () => {
    const t = new PrefixTable<string>();
    t.insert('0.0.0.0/0', 'root');
    t.insert('10.0.0.0/8', 'a');
    t.insert('10.1.0.0/16', 'b');
    // Nothing covers 10.1.2.0/24, so the descent stops after /16.
    const r = t.lookup('10.1.2.3');
    expect(r.candidates.map((c) => c.value)).toEqual(['root', 'a', 'b']);
    expect(r.match?.value).toBe('b');
  });

  it('exposes full prefix metadata on candidates', () => {
    const t = new PrefixTable<string>();
    t.insert('2001:db8::/32', 'x');
    const r = t.lookup('2001:db8::1');
    expect(texts(r)).toEqual(['2001:db8::/32']);
  });
});

describe('exact get / has / overwrite', () => {
  it('get/has match exact prefixes only', () => {
    const t = new PrefixTable<string>();
    t.insert('10.0.0.0/8', 'a');
    expect(t.get('10.0.0.0/8')).toBe('a');
    expect(t.get('10.0.0.0/9')).toBeUndefined();
    expect(t.has('10.1.0.0/16')).toBe(false);
    expect(t.has('10.0.0.0/8')).toBe(true);
  });

  it('overwriting a prefix keeps one entry and updates the value', () => {
    const t = new PrefixTable<string>();
    t.insert('10.0.0.0/8', 'a');
    t.insert('10.0.0.0/8', 'b');
    expect(t.size).toBe(1);
    expect(t.lookup('10.1.2.3').match?.value).toBe('b');
  });
});

describe('delete', () => {
  it('removes a specific route and falls back to shorter routes', () => {
    const t = new PrefixTable<string>();
    t.insert('10.0.0.0/8', 'a');
    t.insert('10.1.0.0/16', 'b');
    t.insert('10.1.2.0/24', 'c');
    expect(lengths(t.lookup('10.1.2.3'))).toEqual([8, 16, 24]);

    expect(t.delete('10.1.0.0/16')).toBe(true);
    expect(lengths(t.lookup('10.1.2.3'))).toEqual([8, 24]);
    expect(t.lookup('10.1.2.3').match?.value).toBe('c');
    expect(t.lookup('10.1.9.9').match?.value).toBe('a');

    expect(t.delete('10.1.2.0/24')).toBe(true);
    expect(t.lookup('10.1.2.3').match?.value).toBe('a');
    expect(t.delete('10.1.2.0/24')).toBe(false); // already gone
    expect(t.delete('10.9.0.0/16')).toBe(false); // never existed
    expect(t.size).toBe(1);
  });

  it('deletes non-byte-aligned routes exactly without harming siblings', () => {
    const t = new PrefixTable<string>();
    t.insert('2001:db8:abcd:1200::/57', 'x');
    t.insert('2001:db8:abcd:1280::/57', 'y');
    t.insert('2001:db8::/32', 'backbone');
    expect(t.delete('2001:db8:abcd:1200::/57')).toBe(true);
    expect(t.lookup('2001:db8:abcd:1200::').match?.value).toBe('backbone');
    expect(t.lookup('2001:db8:abcd:12ff::').match?.value).toBe('y');
  });

  it('collapses branches after deletion but keeps parent and siblings', () => {
    const t = new PrefixTable<string>();
    t.insert('10.0.0.0/24', 'parent');
    t.insert('10.0.0.0/25', 'low');
    t.insert('10.0.0.128/25', 'high');

    t.delete('10.0.0.128/25');
    expect(t.lookup('10.0.0.200').match?.value).toBe('parent');
    expect(t.lookup('10.0.0.1').match?.value).toBe('low');

    t.delete('10.0.0.0/25');
    expect(t.lookup('10.0.0.1').match?.value).toBe('parent');
    expect(t.lookup('10.0.0.200').match?.value).toBe('parent');
    expect(t.size).toBe(1);
  });

  it('can empty the table and accept new routes afterwards', () => {
    const t = new PrefixTable<string>();
    t.insert('0.0.0.0/0', 'd');
    t.insert('10.0.0.0/8', 'a');
    t.delete('10.0.0.0/8');
    t.delete('0.0.0.0/0');
    expect(t.size).toBe(0);
    expect(t.lookup('10.0.0.1').match).toBeUndefined();

    t.insert('192.0.2.0/24', 'n');
    expect(t.lookup('192.0.2.9').match?.value).toBe('n');
  });
});
