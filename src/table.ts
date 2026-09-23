import {
  convertMappedAddress,
  convertMappedPrefix,
  normalizeAddress,
  normalizePrefix,
  parseAddress,
  parsePrefix,
} from './ip.js';
import type { Address, Family, MappedOptions, Prefix } from './ip.js';
import { RadixTrie } from './trie.js';
import type { TrieNode } from './trie.js';

export interface MatchedPrefix<V> {
  readonly prefix: Prefix;
  readonly value: V;
}

export interface LookupResult<V> {
  /** Longest-prefix match (`undefined` when nothing matched). */
  readonly match: MatchedPrefix<V> | undefined;
  /**
   * Every matching candidate prefix passed during the descent,
   * shortest first. `match` is its last element.
   */
  readonly candidates: readonly MatchedPrefix<V>[];
}

/**
 * Longest-prefix-match table with one radix trie per address family.
 * IPv4 and IPv6 never interact; IPv4-mapped IPv6 addresses stay in the
 * IPv6 family unless constructed with `{ mapped: 'ipv4' }`.
 */
export class PrefixTable<V> {
  private readonly tries: Record<Family, RadixTrie<V>> = {
    4: new RadixTrie<V>(),
    6: new RadixTrie<V>(),
  };
  private readonly mapped: 'ipv6' | 'ipv4';

  constructor(options: MappedOptions = {}) {
    this.mapped = options.mapped ?? 'ipv6';
  }

  /** Number of prefixes in the table, across both families. */
  get size(): number {
    return this.tries[4].size + this.tries[6].size;
  }

  /** Insert a prefix, overwriting the value if it already exists. */
  insert(prefix: Prefix | string, value: V): void {
    const p = this.toPrefix(prefix);
    this.tries[p.family].insert(p.bytes, p.length, value);
  }

  /** Remove the exact prefix. Returns false if it was not present. */
  delete(prefix: Prefix | string): boolean {
    const p = this.toPrefix(prefix);
    return this.tries[p.family].delete(p.bytes, p.length);
  }

  has(prefix: Prefix | string): boolean {
    return this.get(prefix) !== undefined;
  }

  /** Exact-match lookup (same bits and length), not longest-prefix. */
  get(prefix: Prefix | string): V | undefined {
    const p = this.toPrefix(prefix);
    return this.tries[p.family].get(p.bytes, p.length)?.value;
  }

  /**
   * Longest-prefix match for `address`. The result also lists every
   * candidate prefix the descent passed through, shortest first.
   */
  lookup(address: Address | string): LookupResult<V> {
    const a = this.toAddress(address);
    const { match, candidates } = this.tries[a.family].lookup(a.bytes);
    return {
      match: match === undefined ? undefined : this.toHit(a.family, match),
      candidates: candidates.map((node) => this.toHit(a.family, node)),
    };
  }

  private toHit(family: Family, node: TrieNode<V>): MatchedPrefix<V> {
    return {
      prefix: { family, length: node.length, bytes: node.bytes.slice() },
      value: node.value as V,
    };
  }

  private toPrefix(prefix: Prefix | string): Prefix {
    if (typeof prefix === 'string') return parsePrefix(prefix, { mapped: this.mapped });
    // Fold on the raw bytes first (the mapped marker must be intact), then
    // normalize and mask in the resulting family.
    const folded = this.mapped === 'ipv4' ? convertMappedPrefix(prefix) : prefix;
    return normalizePrefix(folded);
  }

  private toAddress(address: Address | string): Address {
    if (typeof address === 'string') return parseAddress(address, { mapped: this.mapped });
    const folded = this.mapped === 'ipv4' ? convertMappedAddress(address) : address;
    return normalizeAddress(folded);
  }
}
