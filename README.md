# IP routing core

Longest-prefix-match routing tables for IPv4 and IPv6, built on a
path-compressed binary radix (Patricia) trie.

- Addresses are parsed into fixed-width bit strings (32/128 bits) and prefix
  lengths take part in the comparison bit by bit — non-byte-aligned prefixes
  like `/57` or `/73` are first-class, and a shorter route can never shadow a
  more specific one.
- IPv4 and IPv6 live in separate tries. IPv4-mapped IPv6 addresses
  (`::ffff:a.b.c.d`) stay in the IPv6 family unless you explicitly opt into
  folding with `{ mapped: 'ipv4' }`.
- `lookup` returns the longest match plus every candidate prefix passed
  during the descent.

## Usage

```ts
import { PrefixTable } from 'route-longest-prefix-core';

const table = new PrefixTable<string>();
table.insert('0.0.0.0/0', 'default');
table.insert('10.0.0.0/8', 'corp');
table.insert('2001:db8:abcd:1200::/57', 'site-a');

const { match, candidates } = table.lookup('2001:db8:abcd:1200::1');
// match.value === 'site-a'; candidates lists every covering prefix,
// shortest first.

table.delete('2001:db8:abcd:1200::/57'); // exact (bits, length) removal
```

Parsing helpers (`parseAddress`, `parsePrefix`, `formatPrefix`, …) accept the
same `{ mapped }` policy option as the table constructor.

Run `npm install`, then `npm test` and `npm run build`.
