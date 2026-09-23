/**
 * IP routing core
 *
 * 地址被解析为“固定地址族”的位串：IPv4 = 32 位 / IPv6 = 128 位。
 * 前缀长度逐位参与 trie 路径比较（不是按完整字节），因此 /57、/73 等
 * 非整字节边界也能正确地按最长前缀匹配（LPM）。
 *
 * 两个地址族分别挂在独立的 trie 上，互不影响。IPv4-mapped IPv6
 * （::ffff:a.b.c.d）是否折叠成 IPv4 由显式策略 MappedPolicy 决定，
 * 默认 isolate（保持 IPv6 身份），可选 map（折叠为 IPv4）。
 */

export type AddressFamily = 4 | 6;

/**
 * - isolate: mapped 地址保持 IPv6，与 IPv4 路由完全隔离（默认，符合 RFC 语义）
 * - map:     mapped 地址折叠为 IPv4，前缀长度 -96（仅对 >= /96 合法）
 */
export type MappedPolicy = 'isolate' | 'map';

export interface ParsedAddress {
  family: AddressFamily;
  bytes: Uint8Array; // 4 或 16 字节，host 位原样保留
}

export interface ParsedPrefix {
  family: AddressFamily;
  bytes: Uint8Array; // 4 或 16 字节，prefix 之外的 host 位已掩码为 0
  prefix: number;
}

export interface Route<V> {
  /** "10.0.0.0/8" / "2001:db8::/32"，或 {family, bytes, prefix} */
  network: string | PrefixLike;
  value: V;
}

export interface PrefixLike {
  family: AddressFamily;
  bytes: Uint8Array;
  prefix: number;
}

export interface AddressLike {
  family: AddressFamily;
  bytes: Uint8Array;
}

export interface ParseOptions {
  mapped?: MappedPolicy;
}

export class PrefixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrefixError';
  }
}

const IPV4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/** 解析单个 IP 地址（不含前缀）。zone id（fe80::1%eth0）被接受并忽略。 */
export function parseAddress(input: string, options: ParseOptions = {}): ParsedAddress {
  const s = input.trim().replace(/%.+$/, '').toLowerCase();
  const literal = s.includes(':') ? parseIPv6(s) : parseIPv4(s);
  return applyPolicy(literal, options.mapped ?? 'isolate');
}

/** 解析 CIDR 前缀，如 "2001:db8::/57"、"0.0.0.0/0"、"::/0"。 */
export function parsePrefix(input: string, options: ParseOptions = {}): ParsedPrefix {
  const s = input.trim();
  const slash = s.lastIndexOf('/');
  if (slash < 0) throw new PrefixError(`missing prefix length: "${input}"`);

  const lenText = s.slice(slash + 1);
  if (!/^\d+$/.test(lenText)) throw new PrefixError(`invalid prefix length: "${input}"`);
  let prefix = Number(lenText);

  // 先按 isolate 解析，map 策略下的 mapped 前缀在这里折叠并同步调整长度
  // （::ffff:a.b.c.d/120 -> a.b.c.d/24；/95 这类短于 96 的转换将被拒绝）
  const isolated = parseAddress(s.slice(0, slash), {mapped: 'isolate'});
  let family = isolated.family;
  let bytes = isolated.bytes;
  if (options.mapped === 'map' && family === 6 && isIPv4Mapped(bytes)) {
    family = 4;
    bytes = bytes.slice(12, 16);
    prefix -= 96;
  }

  const max = family === 4 ? 32 : 128;
  if (prefix < 0 || prefix > max) {
    throw new PrefixError(
      `prefix length ${lenText} is invalid for "${input}" (IPv${family} allows 0..${max}` +
        (family === 4 && options.mapped === 'map' ? ' after mapped conversion' : '') +
        ')',
    );
  }
  return {family, bytes: maskBits(bytes, prefix), prefix};
}

/** 判断是否为 IPv4-mapped IPv6（::ffff:a.b.c.d）。 */
export function isIPv4Mapped(bytes: Uint8Array): boolean {
  if (bytes.length !== 16) return false;
  for (let i = 0; i < 12; i++) if (bytes[i] !== IPV4_MAPPED_PREFIX[i]) return false;
  return true;
}

function applyPolicy(
  addr: ParsedAddress,
  policy: MappedPolicy,
): ParsedAddress {
  if (policy === 'map' && addr.family === 6 && isIPv4Mapped(addr.bytes)) {
    return {family: 4, bytes: addr.bytes.slice(12, 16)};
  }
  return addr;
}

function parseIPv4(s: string): ParsedAddress {
  const parts = s.split('.');
  if (parts.length !== 4) throw new PrefixError(`invalid IPv4 address: "${s}"`);
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i];
    if (p.length === 0 || p.length > 3 || !/^\d+$/.test(p)) {
      throw new PrefixError(`invalid IPv4 address: "${s}"`);
    }
    if (p.length > 1 && p[0] === '0') {
      throw new PrefixError(`leading zeros are not allowed in IPv4: "${s}"`);
    }
    const n = Number(p);
    if (n > 255) throw new PrefixError(`invalid IPv4 address: "${s}"`);
    bytes[i] = n;
  }
  return {family: 4, bytes};
}

/**
 * IPv6 解析，支持：
 *  - 零压缩 "::"（至多一处）
 *  - 尾部内嵌 IPv4（x:x::a.b.c.d）
 *  - 大小写不敏感、可带 zone id（调用前已剥离）
 */
function parseIPv6(s: string): ParsedAddress {
  // 1. 若尾部为内嵌 IPv4，将其换算为两个 16 位组后再按纯 IPv6 规则解析。
  //    字节序保持大端：c0 00 02 01 -> 组 c000、组 0201。
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  let body = s;
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    const g1 = ((v4.bytes[0] << 8) | v4.bytes[1]) & 0xffff;
    const g2 = ((v4.bytes[2] << 8) | v4.bytes[3]) & 0xffff;
    body = s.slice(0, lastColon + 1) + g1.toString(16) + ':' + g2.toString(16);
  }

  // 2. 处理零压缩。前导/尾随 "::" 时对应一侧没有任何组。
  const dc = body.indexOf('::');
  let headGroups: string[] = [];
  let tailGroups: string[] = [];
  if (dc >= 0) {
    if (body.indexOf('::', dc + 1) >= 0) {
      throw new PrefixError(`multiple "::" in IPv6 address: "${s}"`);
    }
    const head = body.slice(0, dc);
    const rest = body.slice(dc + 2);
    headGroups = head.length ? head.split(':') : [];
    tailGroups = rest.length ? rest.split(':') : [];
  } else {
    headGroups = body.split(':');
  }

  // 3. 校验十六进制组
  for (const g of headGroups) if (!isHexGroup(g)) throw new PrefixError(`invalid IPv6 address: "${s}"`);
  for (const g of tailGroups) if (!isHexGroup(g)) throw new PrefixError(`invalid IPv6 address: "${s}"`);

  const have = headGroups.length + tailGroups.length;
  if (dc < 0) {
    if (have !== 8) throw new PrefixError(`invalid IPv6 address: "${s}"`);
  } else if (have > 7) {
    throw new PrefixError(`too many groups in IPv6 address: "${s}"`);
  }

  // 4. head 左对齐、tail 右对齐，中间补零
  const groups = new Array<number>(8).fill(0);
  let k = 0;
  for (const g of headGroups) groups[k++] = parseInt(g, 16);
  k = 8 - tailGroups.length;
  for (const g of tailGroups) groups[k++] = parseInt(g, 16);

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = groups[i] >> 8;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return {family: 6, bytes};
}

function isHexGroup(g: string): boolean {
  return g.length >= 1 && g.length <= 4 && /^[0-9a-f]+$/.test(g);
}

/** 将 prefix 之外的位掩码为 0（逐位，非整字节边界同样正确）。 */
export function maskBits(bytes: Uint8Array, prefix: number): Uint8Array {
  const out = new Uint8Array(bytes.length);
  const full = prefix >> 3;
  for (let i = 0; i < full && i < bytes.length; i++) out[i] = bytes[i];
  if (full < bytes.length && (prefix & 7) !== 0) {
    out[full] = bytes[full] & (0xff << (8 - (prefix & 7)));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 格式化（规范文本形式，便于输出与调试）                                */
/* ------------------------------------------------------------------ */

export function formatAddress(addr: AddressLike | ParsedAddress): string {
  if (addr.family === 4) {
    assertLength(addr.bytes, 4, 'IPv4');
    return addr.bytes.join('.');
  }
  assertLength(addr.bytes, 16, 'IPv6');
  return formatIPv6(addr.bytes);
}

export function formatPrefix(p: PrefixLike | ParsedPrefix): string {
  return `${formatAddress(p)}/${p.prefix}`;
}

function formatIPv6(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 8; i++) groups.push((bytes[i * 2] << 8) | bytes[i * 2 + 1]);

  // RFC 5952：最长零段压缩，等长取第一段
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && groups[i] === 0) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const len = i - runStart;
      if (len > bestLen) {
        bestLen = len;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }

  // 压缩段两侧分别拼成十六进制组，中间用 "::" 连接：
  // 全零 -> "::"，前导 -> "::tail"，尾随 -> "head::"，内部 -> "head::tail"
  const head: string[] = [];
  const tail: string[] = [];
  for (let i = 0; i < bestStart; i++) head.push(groups[i].toString(16));
  for (let i = bestStart + bestLen; i < 8; i++) tail.push(groups[i].toString(16));
  return `${head.join(':')}::${tail.join(':')}`;
}

/* ------------------------------------------------------------------ */
/* 逐位二进制 trie                                                     */
/* ------------------------------------------------------------------ */

interface TrieNode<V> {
  child: (TrieNode<V> | null)[]; // [0 分支, 1 分支]
  value: V | undefined;          // 该节点恰为某条前缀的终点时有值
  hasRoute: boolean;
}

function newNode<V>(): TrieNode<V> {
  return {child: [null, null], value: undefined, hasRoute: false};
}

class BitTrie<V> {
  readonly root: TrieNode<V> = newNode();

  constructor(readonly depth: number) {}

  /** 插入/覆盖；返回 true 表示新增，false 表示覆盖已有值。 */
  insert(bytes: Uint8Array, prefix: number, value: V): boolean {
    let node = this.root;
    for (let bit = 0; bit < prefix; bit++) {
      const b = (bytes[bit >> 3] >> (7 - (bit & 7))) & 1;
      let next = node.child[b];
      if (!next) {
        next = newNode();
        node.child[b] = next;
      }
      node = next;
    }
    const created = !node.hasRoute;
    node.hasRoute = true;
    node.value = value;
    return created;
  }

  /** 删除精确前缀；返回是否命中。删除后回收无路由、无子节点的悬挂分支。 */
  remove(bytes: Uint8Array, prefix: number): boolean {
    const stack: TrieNode<V>[] = [this.root];
    const branches: number[] = [];
    let node = this.root;
    for (let bit = 0; bit < prefix; bit++) {
      const b = (bytes[bit >> 3] >> (7 - (bit & 7))) & 1;
      const next = node.child[b];
      if (!next) return false;
      branches.push(b);
      stack.push(next);
      node = next;
    }
    if (!node.hasRoute) return false;
    node.hasRoute = false;
    node.value = undefined;

    // 自底向上剪枝
    for (let i = stack.length - 1; i > 0; i--) {
      const cur = stack[i];
      if (cur.hasRoute || cur.child[0] || cur.child[1]) break;
      stack[i - 1].child[branches[i - 1]] = null;
    }
    return true;
  }

  /**
   * 沿位路径下行。
   * @returns best      最长匹配前缀上的值（无匹配为 undefined）
   *          bestPrefix/bestBytes 最长匹配前缀本身
   *          candidates 路径上经过的全部候选前缀（按前缀长度递增，含最长匹配）
   */
  search(bytes: Uint8Array): {
    best: V | undefined;
    bestPrefix: number;
    candidates: {bytes: Uint8Array; prefix: number; value: V}[];
  } {
    const candidates: {bytes: Uint8Array; prefix: number; value: V}[] = [];
    let best: V | undefined;
    let bestPrefix = -1;
    let node = this.root;

    if (node.hasRoute) {
      candidates.push({bytes: maskBits(bytes, 0), prefix: 0, value: node.value as V});
      best = node.value;
      bestPrefix = 0;
    }

    for (let bit = 0; bit < this.depth; bit++) {
      const b = (bytes[bit >> 3] >> (7 - (bit & 7))) & 1;
      const next = node.child[b];
      if (!next) break;
      node = next;
      if (node.hasRoute) {
        const prefix = bit + 1;
        candidates.push({
          bytes: maskBits(bytes, prefix),
          prefix,
          value: node.value as V,
        });
        best = node.value;
        bestPrefix = prefix;
      }
    }

    return {best, bestPrefix, candidates};
  }
}

/* ------------------------------------------------------------------ */
/* 路由表                                                              */
/* ------------------------------------------------------------------ */

export interface LookupHit<V> {
  value: V;
  prefix: number;
  bytes: Uint8Array;
}

export interface LookupResult<V> {
  /** 最长匹配（LPM）；完全未命中时为 null */
  match: LookupHit<V> | null;
  /** 查询路径上经过的全部候选前缀，按前缀长度递增（最后一项即最长匹配） */
  candidates: LookupHit<V>[];
  family: AddressFamily;
}

export class RouteTable<V> {
  #v4 = new BitTrie<V>(32);
  #v6 = new BitTrie<V>(128);
  readonly mapped: MappedPolicy;

  constructor(options: {mapped?: MappedPolicy} = {}) {
    this.mapped = options.mapped ?? 'isolate';
  }

  /** 新增路由；同一前缀重复添加时覆盖 value。返回 true 表示新增。 */
  add(network: string, value: V): boolean;
  add(route: Route<V> | PrefixLike, value?: V): boolean;
  add(
    network: string | Route<V> | PrefixLike,
    value?: V,
  ): boolean {
    const p =
      typeof network === 'string'
        ? parsePrefix(network, {mapped: this.mapped})
        : 'network' in network
          ? this.#fromRoute(network as Route<V>)
          : this.#fromPrefixLike(network as PrefixLike);
    const v =
      typeof network === 'string'
        ? (value as V)
        : 'value' in network
          ? (network as Route<V>).value
          : (value as V);
    if (v === undefined) throw new PrefixError('route value is required');
    const trie = p.family === 4 ? this.#v4 : this.#v6;
    return trie.insert(p.bytes, p.prefix, v);
  }

  /** 删除精确匹配的路由前缀（非级联删除）。返回是否命中并删除。 */
  delete(network: string): boolean;
  delete(prefix: PrefixLike): boolean;
  delete(network: string | PrefixLike): boolean {
    const p =
      typeof network === 'string'
        ? parsePrefix(network, {mapped: this.mapped})
        : this.#fromPrefixLike(network);
    const trie = p.family === 4 ? this.#v4 : this.#v6;
    return trie.remove(p.bytes, p.prefix);
  }

  /**
   * 最长前缀匹配查询。
   * @param address 文本地址（"1.2.3.4"、"2001:db8::1"、"::ffff:1.2.3.4"）
   *                或 {family, bytes}
   */
  lookup(address: string | AddressLike): LookupResult<V> {
    const a =
      typeof address === 'string'
        ? parseAddress(address, {mapped: this.mapped})
        : this.#fromAddressLike(address);
    const trie = a.family === 4 ? this.#v4 : this.#v6;
    const r = trie.search(a.bytes);
    return {
      match:
        r.bestPrefix >= 0
          ? {value: r.best as V, prefix: r.bestPrefix, bytes: maskBits(a.bytes, r.bestPrefix)}
          : null,
      candidates: r.candidates.map(c => ({
        value: c.value,
        prefix: c.prefix,
        bytes: c.bytes,
      })),
      family: a.family,
    };
  }

  #fromRoute(route: Route<V>): ParsedPrefix {
    if (typeof route.network === 'string') {
      return parsePrefix(route.network, {mapped: this.mapped});
    }
    return this.#fromPrefixLike(route.network);
  }

  #fromPrefixLike(p: PrefixLike): ParsedPrefix {
    if (p.family !== 4 && p.family !== 6) {
      throw new PrefixError(`unknown address family: ${String(p.family)}`);
    }
    const maxPrefix = p.family === 4 ? 32 : 128;
    const byteLen = p.family === 4 ? 4 : 16;
    assertLength(p.bytes, byteLen, `IPv${p.family}`);
    if (p.prefix < 0 || p.prefix > maxPrefix || !Number.isInteger(p.prefix)) {
      throw new PrefixError(`invalid prefix length /${p.prefix} for IPv${p.family}`);
    }
    return {family: p.family, bytes: maskBits(p.bytes, p.prefix), prefix: p.prefix};
  }

  #fromAddressLike(a: AddressLike): ParsedAddress {
    if (a.family !== 4 && a.family !== 6) {
      throw new PrefixError(`unknown address family: ${String(a.family)}`);
    }
    const byteLen = a.family === 4 ? 4 : 16;
    assertLength(a.bytes, byteLen, `IPv${a.family}`);
    return {family: a.family, bytes: a.bytes};
  }
}

function assertLength(bytes: Uint8Array, len: number, label: string): void {
  if (bytes.length !== len) {
    throw new PrefixError(`${label} requires ${len} bytes, got ${bytes.length}`);
  }
}
