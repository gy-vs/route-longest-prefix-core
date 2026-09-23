import { bitAt, commonBits, maskHostBits } from './bits.js';

/**
 * A node in a path-compressed binary radix (Patricia) trie.
 *
 * Each node carries a prefix of `length` bits. A node is either a branch
 * (exactly two children, no value) or keyed (carries a value; any number of
 * children). Branch nodes sit at the exact bit position where their two
 * subtrees diverge, so positions like 57 or 73 are represented directly —
 * there is no byte granularity anywhere in the structure.
 *
 * Invariant: a child's `length` is always greater than its parent's.
 */
export class TrieNode<V> {
  hasValue = false;
  value: V | undefined = undefined;
  readonly child: [TrieNode<V> | null, TrieNode<V> | null] = [null, null];

  constructor(
    /** Significant bits of this node's prefix. */
    readonly length: number,
    /** Prefix bits; only the first `length` bits are meaningful. */
    readonly bytes: Uint8Array,
  ) {}

  static keyed<V>(length: number, bytes: Uint8Array, value: V): TrieNode<V> {
    const node = new TrieNode<V>(length, bytes);
    node.hasValue = true;
    node.value = value;
    return node;
  }
}

export interface TrieLookup<V> {
  /** Deepest keyed node whose prefix covers the address, if any. */
  readonly match: TrieNode<V> | undefined;
  /** Every keyed node matched on the descent, shortest prefix first. */
  readonly candidates: readonly TrieNode<V>[];
}

/**
 * Path-compressed radix trie over prefix keys of one address family.
 * Keys are bit strings of up to the family's width; `key` arguments must
 * already be masked past their `length`.
 */
export class RadixTrie<V> {
  private root: TrieNode<V> | null = null;
  /** Number of keyed prefixes. */
  size = 0;

  /** Insert `key`/`length`, overwriting the value if the prefix exists. */
  insert(key: Uint8Array, length: number, value: V): void {
    if (this.root === null) {
      this.root = TrieNode.keyed(length, key, value);
      this.size = 1;
      return;
    }
    let parent: TrieNode<V> | null = null;
    let parentBit = 0;
    let node: TrieNode<V> = this.root;
    for (;;) {
      const limit = Math.min(length, node.length);
      const common = commonBits(key, node.bytes, limit);
      if (common < limit) {
        // The keys diverge at bit `common`: splice a branch node above `node`.
        const branch = new TrieNode<V>(common, maskHostBits(key, common));
        branch.child[bitAt(key, common)] = TrieNode.keyed(length, key, value);
        branch.child[bitAt(node.bytes, common)] = node;
        this.replace(parent, parentBit, branch);
        this.size += 1;
        return;
      }
      if (node.length === length) {
        // Same prefix: (re)key the node in place.
        if (!node.hasValue) this.size += 1;
        node.hasValue = true;
        node.value = value;
        return;
      }
      if (length < node.length) {
        // The new key is a prefix of `node`: hoist a keyed node above it.
        const up = TrieNode.keyed(length, key, value);
        up.child[bitAt(node.bytes, length)] = node;
        this.replace(parent, parentBit, up);
        this.size += 1;
        return;
      }
      // `node` is a proper prefix of the new key: descend.
      const bit = bitAt(key, node.length);
      const next = node.child[bit];
      if (next === null) {
        node.child[bit] = TrieNode.keyed(length, key, value);
        this.size += 1;
        return;
      }
      parent = node;
      parentBit = bit;
      node = next;
    }
  }

  /**
   * Longest-prefix match for a full-width address. Every descendant of a
   * node shares the node's prefix, so the first mismatched node ends the
   * descent; the keyed nodes met along the way are exactly the candidates.
   */
  lookup(key: Uint8Array): TrieLookup<V> {
    const candidates: TrieNode<V>[] = [];
    const keyBits = key.length * 8;
    let node = this.root;
    while (node !== null) {
      if (commonBits(key, node.bytes, node.length) < node.length) break;
      if (node.hasValue) candidates.push(node);
      if (node.length === keyBits) break;
      node = node.child[bitAt(key, node.length)];
    }
    const match = candidates.length === 0 ? undefined : candidates[candidates.length - 1];
    return { match, candidates };
  }

  /** Exact match on (bits, length); ignores longer/shorter prefixes. */
  get(key: Uint8Array, length: number): TrieNode<V> | undefined {
    let node = this.root;
    while (node !== null) {
      const limit = Math.min(length, node.length);
      if (commonBits(key, node.bytes, limit) < limit) return undefined;
      if (node.length === length) return node.hasValue ? node : undefined;
      if (node.length > length) return undefined;
      node = node.child[bitAt(key, node.length)];
    }
    return undefined;
  }

  /** Remove the keyed prefix `key`/`length`. Returns false if absent. */
  delete(key: Uint8Array, length: number): boolean {
    const path: { node: TrieNode<V>; bit: number }[] = [];
    let node = this.root;
    for (;;) {
      if (node === null) return false;
      const limit = Math.min(length, node.length);
      if (commonBits(key, node.bytes, limit) < limit) return false;
      if (node.length === length) break;
      if (node.length > length) return false;
      const bit = bitAt(key, node.length);
      path.push({ node, bit });
      node = node.child[bit];
    }
    if (!node.hasValue) return false;
    node.hasValue = false;
    node.value = undefined;
    this.size -= 1;

    const parent = path.length === 0 ? null : path[path.length - 1].node;
    const parentBit = path.length === 0 ? 0 : path[path.length - 1].bit;
    const [c0, c1] = node.child;
    if (c0 === null && c1 === null) {
      // Leaf: detach it. An unkeyed parent left with a single child no
      // longer branches on anything, so collapse it into that child.
      this.replace(parent, parentBit, null);
      if (parent !== null && !parent.hasValue) {
        const survivor = parent.child[0] ?? parent.child[1];
        const grand = path.length < 2 ? null : path[path.length - 2];
        this.replace(grand === null ? null : grand.node, grand === null ? 0 : grand.bit, survivor);
      }
    } else if (c0 === null || c1 === null) {
      // The unkeyed node now has a single child: bypass it.
      this.replace(parent, parentBit, c0 ?? c1);
    }
    // Two children: the node stays as an unkeyed branch.
    return true;
  }

  private replace(parent: TrieNode<V> | null, bit: number, node: TrieNode<V> | null): void {
    if (parent === null) this.root = node;
    else parent.child[bit] = node;
  }
}
