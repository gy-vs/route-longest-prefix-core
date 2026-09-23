import {describe, expect, it} from 'vitest';
import {
  formatAddress,
  formatPrefix,
  isIPv4Mapped,
  maskBits,
  parseAddress,
  parsePrefix,
  PrefixError,
  RouteTable,
  type PrefixLike,
} from '../src/index.js';

/* ------------------------------------------------------------------ */
/* 解析与格式化                                                         */
/* ------------------------------------------------------------------ */

describe('parseAddress', () => {
  it('IPv4', () => {
    const a = parseAddress('10.20.30.40');
    expect(a.family).toBe(4);
    expect([...a.bytes]).toEqual([10, 20, 30, 40]);
  });

  it('IPv6 完整形式与压缩形式', () => {
    const full = parseAddress('2001:0db8:0000:0000:0000:0000:0000:0001');
    const compact = parseAddress('2001:db8::1');
    expect(full.family).toBe(6);
    expect([...full.bytes]).toEqual([...compact.bytes]);
    expect([...compact.bytes]).toEqual([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });

  it(':: 单独出现、前后压缩、尾部内嵌 IPv4', () => {
    expect([...parseAddress('::').bytes]).toEqual(new Array(16).fill(0));
    expect(formatAddress(parseAddress('::1'))).toBe('::1');
    expect(formatAddress(parseAddress('1::'))).toBe('1::');
    expect(formatAddress(parseAddress('fe80::1:2:3:4'))).toBe('fe80::1:2:3:4');
    expect(formatAddress(parseAddress('2001:db8::192.0.2.1'))).toBe(
      '2001:db8::c000:201',
    );
  });

  it('zone id 被剥离', () => {
    expect(formatAddress(parseAddress('fe80::1%eth0'))).toBe('fe80::1');
  });

  it('识别 mapped 地址', () => {
    expect(isIPv4Mapped(parseAddress('::ffff:192.0.2.1').bytes)).toBe(true);
    expect(isIPv4Mapped(parseAddress('::192.0.2.1').bytes)).toBe(false);
  });

  it('mapped 策略默认隔离，显式 map 才折叠', () => {
    expect(parseAddress('::ffff:1.2.3.4').family).toBe(6);
    const mapped = parseAddress('::ffff:1.2.3.4', {mapped: 'map'});
    expect(mapped.family).toBe(4);
    expect([...mapped.bytes]).toEqual([1, 2, 3, 4]);
  });

  it('拒绝非法输入', () => {
    expect(() => parseAddress('256.0.0.1')).toThrow(PrefixError);
    expect(() => parseAddress('10.0.0')).toThrow(PrefixError);
    expect(() => parseAddress('10.0.0.01')).toThrow(PrefixError);
    expect(() => parseAddress('2001::db8::1')).toThrow(PrefixError);
    expect(() => parseAddress('2001:db8:::1')).toThrow(PrefixError);
    expect(() => parseAddress('1:2:3:4:5:6:7:8:9')).toThrow(PrefixError);
    expect(() => parseAddress('gggg::1')).toThrow(PrefixError);
  });
});

describe('parsePrefix', () => {
  it('/0 与 /32、/128', () => {
    expect(parsePrefix('0.0.0.0/0')).toMatchObject({family: 4, prefix: 0});
    expect(parsePrefix('::/0')).toMatchObject({family: 6, prefix: 0});
    expect([...parsePrefix('10.0.0.0/32').bytes]).toEqual([10, 0, 0, 0]);
    expect(parsePrefix('::1/128').prefix).toBe(128);
  });

  it('非整字节前缀把 host 位清零', () => {
    // byte7 = 0xff，掩到 /57（保留该字节最高位）后变 0x80
    const p = parsePrefix('2001:db8:1:ff::/57');
    expect(p.bytes[7]).toBe(0x80);
    expect(formatPrefix(p)).toBe('2001:db8:1:80::/57');
  });

  it('mapped 前缀在 map 策略下折叠且长度 -96', () => {
    const p = parsePrefix('::ffff:10.0.0.0/104', {mapped: 'map'});
    expect(p.family).toBe(4);
    expect(p.prefix).toBe(8);
    expect([...p.bytes]).toEqual([10, 0, 0, 0]);
  });

  it('短于 /96 的 mapped 转换报错；默认策略保持 v6', () => {
    expect(() => parsePrefix('::ffff:0:0/95', {mapped: 'map'})).toThrow(PrefixError);
    const isolated = parsePrefix('::ffff:10.0.0.0/104');
    expect(isolated.family).toBe(6);
    expect(isolated.prefix).toBe(104);
  });

  it('拒绝越界与畸形长度', () => {
    expect(() => parsePrefix('0.0.0.0/33')).toThrow(PrefixError);
    expect(() => parsePrefix('::/129')).toThrow(PrefixError);
    expect(() => parsePrefix('10.0.0.0/-1')).toThrow(PrefixError);
    expect(() => parsePrefix('10.0.0.0')).toThrow(PrefixError);
    expect(() => parsePrefix('10.0.0.0/8/9')).toThrow(PrefixError);
  });
});

/* ------------------------------------------------------------------ */
/* trie 行为：边界长度                                                   */
/* ------------------------------------------------------------------ */

describe('LPM 边界前缀', () => {
  it('IPv4 /0、/32 与分层最长匹配', () => {
    const t = new RouteTable<string>();
    t.add('0.0.0.0/0', 'default');
    t.add('10.0.0.0/8', 'ten');
    t.add('10.1.0.0/16', 'ten-one');
    t.add('10.1.2.3/32', 'host');

    let r = t.lookup('10.1.2.3');
    expect(r.match?.value).toBe('host');
    expect(r.candidates.map(c => c.prefix)).toEqual([0, 8, 16, 32]);

    r = t.lookup('10.1.9.9');
    expect(r.match?.value).toBe('ten-one');
    expect(r.candidates.map(c => c.prefix)).toEqual([0, 8, 16]);

    r = t.lookup('10.2.3.4');
    expect(r.match?.value).toBe('ten');

    r = t.lookup('192.0.2.1');
    expect(r.match?.value).toBe('default');
    expect(r.candidates.map(c => c.prefix)).toEqual([0]);

    r = t.lookup('8.8.8.8');
    expect(r.match?.value).toBe('default');
  });

  it('IPv6 /0、/128 与分层最长匹配', () => {
    const t = new RouteTable<string>();
    t.add('::/0', 'default6');
    t.add('2001:db8::/32', 'doc');
    t.add('2001:db8::/57', '57a');
    t.add('2001:db8::1/128', 'host');

    expect(t.lookup('2001:db8::1').match?.value).toBe('host');
    expect(t.lookup('2001:db8::1').candidates.map(c => c.prefix)).toEqual([
      0, 32, 57, 128,
    ]);
    expect(t.lookup('2001:db8::2').match?.value).toBe('57a');
    expect(t.lookup('2001:db8:0:100::1').match?.value).toBe('doc');
    expect(t.lookup('2001:4860:4860::8888').match?.value).toBe('default6');
  });

  it('完全未命中返回 null 与空候选', () => {
    const t = new RouteTable<string>();
    t.add('10.0.0.0/8', 'ten');
    const r = t.lookup('192.0.2.1');
    expect(r.match).toBeNull();
    expect(r.candidates).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 非整字节：/57、/73 等（本次修复核心）                                  */
/* ------------------------------------------------------------------ */

describe('非整字节前缀逐位区分', () => {
  it('回归：/57、/73 插入后，更短路由不能覆盖更具体路由', () => {
    // 这是修复前的故障模式：仅按整字节比较会让更短前缀“吃掉”同字节内的邻居
    const t = new RouteTable<string>();
    t.add('2001:db8:1::/48', 'short-48');
    t.add('2001:db8:1:80::/57', 'specific-57');
    expect(t.lookup('2001:db8:1:ff::1').match?.value).toBe('specific-57');
    expect(t.lookup('2001:db8:1:0:1::1').match?.value).toBe('short-48');

    const t2 = new RouteTable<string>();
    t2.add('2001:db8::/64', 'short-64');
    t2.add('2001:0db8:0000:0000:0080:0000:0000:0000/73', 'specific-73');
    expect(
      t2.lookup('2001:0db8:0000:0000:00ff:ffff:ffff:ffff').match?.value,
    ).toBe('specific-73');
    expect(t2.lookup('2001:0db8:0000:0000:0000:0000:0000:0001').match?.value).toBe(
      'short-64',
    );
  });

  it('/57 两个相邻子空间不能互相覆盖', () => {
    const t = new RouteTable<string>();
    t.add('2001:db8::/57', 'A'); // bit57 = 0
    t.add('2001:db8:0:80::/57', 'B'); // bit57 = 1
    t.add('2001:db8::/32', 'parent');

    // 旧实现按整字节比较，这两个地址会落错；这里逐位验证
    expect(t.lookup('2001:db8::1').match?.value).toBe('A');
    expect(t.lookup('2001:db8::7f:ffff:ffff:ffff:ffff').match?.value).toBe('A');
    expect(t.lookup('2001:db8:0:80::1').match?.value).toBe('B');
    expect(t.lookup('2001:db8:0:ff:ffff:ffff:ffff:ffff').match?.value).toBe('B');

    // 落在 /57 划分之外但仍在 /32 内
    expect(t.lookup('2001:db8:1::1').match?.value).toBe('parent');
    expect(t.lookup('2001:db8:0:100::1').match?.value).toBe('parent');
  });

  it('/73 与 /74：更具体的 /74 不会被 /73 覆盖', () => {
    const t = new RouteTable<string>();
    t.add('2001:db8::/64', '64');
    // /73 边界位 = byte9 的最高位（第 5 个 16 位组 g4 的低位字节）
    t.add('2001:0db8:0000:0000:0000:0000:0000:0000/73', '73-lo'); // byte9 = 0x00
    t.add('2001:0db8:0000:0000:0080:0000:0000:0000/73', '73-hi'); // byte9 = 0x80
    t.add('2001:0db8:0000:0000:00c0:0000:0000:0000/74', '74'); // bit74 也为 1

    expect(
      t.lookup('2001:0db8:0000:0000:007f:ffff:ffff:ffff').match?.value,
    ).toBe('73-lo');
    expect(t.lookup('2001:0db8:0000:0000:0080:0000:0000:0001').match?.value).toBe(
      '73-hi',
    );

    const hit = t.lookup('2001:0db8:0000:0000:00c0:1111:2222:3333');
    expect(hit.match?.value).toBe('74');
    expect(hit.candidates.map(c => c.prefix)).toEqual([64, 73, 74]);

    // /74 另半边（bit74=0）只能到 /73
    expect(
      t.lookup('2001:0db8:0000:0000:00bf:ffff:ffff:ffff').match?.value,
    ).toBe('73-hi');
    // 边界位翻转到不相邻的分支，只能回到 /64
    expect(t.lookup('2001:0db8:0000:0000:0100:0000:0000:0001').match?.value).toBe(
      '64',
    );
  });

  it('各种非整字节前缀在同一字节内逐位独立', () => {
    // L 侧构成嵌套链 2001:db8::/33 ⊃ /34 ⊃ ... ⊃ /39；
    // H 侧是每个边界翻转后的对端 /n。
    const t = new RouteTable<string>();
    const cases: [number, string, string][] = [
      [33, '2001:db8::/33', '2001:db8:8000::/33'],
      [34, '2001:db8::/34', '2001:db8:4000::/34'],
      [35, '2001:db8::/35', '2001:db8:2000::/35'],
      [36, '2001:db8::/36', '2001:db8:1000::/36'],
      [37, '2001:db8::/37', '2001:db8:0800::/37'],
      [38, '2001:db8::/38', '2001:db8:0400::/38'],
      [39, '2001:db8::/39', '2001:db8:0200::/39'],
    ];
    for (const [n, lo, hi] of cases) {
      t.add(lo, `L${n}`);
      t.add(hi, `H${n}`);
    }
    // g2=0x0001：在所有 L 侧链上，最深命中 /39
    const deep = t.lookup('2001:db8:0:1::');
    expect(deep.match?.value).toBe('L39');
    expect(deep.candidates.map(c => c.prefix)).toEqual([33, 34, 35, 36, 37, 38, 39]);

    // 各 H 网络的起点只命中自己那一层 H（同前缀的 L 侧不在路径上）
    expect(t.lookup('2001:db8:8000::').match?.value).toBe('H33');
    expect(t.lookup('2001:db8:4000::').match?.value).toBe('H34');
    expect(t.lookup('2001:db8:2000::').match?.value).toBe('H35');
    expect(t.lookup('2001:db8:1000::').match?.value).toBe('H36');
    expect(t.lookup('2001:db8:0800::').match?.value).toBe('H37');
    expect(t.lookup('2001:db8:0400::').match?.value).toBe('H38');
    expect(t.lookup('2001:db8:0200::').match?.value).toBe('H39');

    // 翻转点前一刻仍属于当前最深的 H：0x0fff 内最深匹配是 /37
    expect(t.lookup('2001:db8:0fff::').match?.value).toBe('H37');
    expect(t.lookup('2001:db8:7fff::').match?.value).toBe('H34');
    expect(t.lookup('2001:db8:03ff::').match?.value).toBe('H39');
    expect(t.lookup('2001:db8:0:ffff::').match?.value).toBe('L39');
  });

  it('IPv4 非整字节 /3、/17、/31', () => {
    const t = new RouteTable<string>();
    t.add('0.0.0.0/0', 'd');
    t.add('32.0.0.0/3', 'a'); // 001...
    t.add('64.0.0.0/3', 'b'); // 010...
    t.add('128.0.0.0/1', 'hi'); // 1...
    t.add('10.0.0.0/31', 'p2p');

    expect(t.lookup('31.255.255.255').match?.value).toBe('d');
    expect(t.lookup('32.0.0.1').match?.value).toBe('a');
    expect(t.lookup('63.255.255.255').match?.value).toBe('a');
    expect(t.lookup('64.0.0.1').match?.value).toBe('b');
    expect(t.lookup('95.255.255.255').match?.value).toBe('b');
    expect(t.lookup('128.1.1.1').match?.value).toBe('hi');
    expect(t.lookup('10.0.0.0').match?.value).toBe('p2p');
    expect(t.lookup('10.0.0.1').match?.value).toBe('p2p');
    // 10 = 00001010 落在 0/3（未配置），且 .2 在 /31 之外 → 只命中 default
    expect(t.lookup('10.0.0.2').match?.value).toBe('d');
  });
});

/* ------------------------------------------------------------------ */
/* 相邻前缀                                                             */
/* ------------------------------------------------------------------ */

describe('相邻前缀', () => {
  it('IPv4 两条 /24 紧邻，查询边界地址', () => {
    const t = new RouteTable<string>();
    t.add('192.0.2.0/24', 'n1');
    t.add('192.0.3.0/24', 'n2');
    t.add('192.0.0.0/16', 'agg');
    expect(t.lookup('192.0.2.255').match?.value).toBe('n1');
    expect(t.lookup('192.0.3.0').match?.value).toBe('n2');
    expect(t.lookup('192.0.4.0').match?.value).toBe('agg');
  });

  it('0/1 与 128/1 两个半边覆盖整个空间', () => {
    const t = new RouteTable<string>();
    t.add('0.0.0.0/1', 'lo');
    t.add('128.0.0.0/1', 'hi');
    expect(t.lookup('127.255.255.255').match?.value).toBe('lo');
    expect(t.lookup('128.0.0.0').match?.value).toBe('hi');
    expect(t.lookup('255.255.255.255').match?.value).toBe('hi');
  });
});

/* ------------------------------------------------------------------ */
/* 地址族隔离 + mapped 策略                                              */
/* ------------------------------------------------------------------ */

describe('地址族隔离与 mapped 策略', () => {
  it('默认 isolate：IPv4 与 IPv6 完全隔离', () => {
    const t = new RouteTable<string>();
    t.add('10.0.0.0/8', 'v4-ten');
    t.add('::/0', 'v6-default');
    t.add('::ffff:0:0/96', 'mapped-space'); // 作为普通 v6 前缀

    expect(t.lookup('10.1.2.3').family).toBe(4);
    expect(t.lookup('10.1.2.3').match?.value).toBe('v4-ten');

    const m = t.lookup('::ffff:10.1.2.3');
    expect(m.family).toBe(6);
    expect(m.match?.value).toBe('mapped-space'); // 不会命中 v4-ten
    expect(m.candidates.map(c => c.prefix)).toEqual([0, 96]);

    // 非 mapped 的 v6 只命中默认
    expect(t.lookup('2001:db8::1').match?.value).toBe('v6-default');
  });

  it('map 策略：mapped 查询折叠到 IPv4 trie', () => {
    const t = new RouteTable<string>({mapped: 'map'});
    t.add('10.0.0.0/8', 'v4-ten');
    t.add('::ffff:10.1.0.0/112', 'v6-mapped-more-specific'); // /112 -> v4 /16

    const m = t.lookup('::ffff:10.1.2.3');
    expect(m.family).toBe(4);
    expect(m.match?.value).toBe('v6-mapped-more-specific');
    expect(m.candidates.map(c => c.prefix)).toEqual([8, 16]);

    // 普通 v6 不受影响
    expect(t.lookup('2001:db8::1').match).toBeNull();
    // 用文本 v4 直接查同一张表也能命中
    expect(t.lookup('10.1.2.3').match?.value).toBe('v6-mapped-more-specific');
  });

  it('::ffff:0:0/96 这类“非具体” mapped 段在 isolate 下只作 v6', () => {
    const t = new RouteTable<string>();
    t.add('::ffff:0:0/96', 'block');
    expect(t.lookup('::ffff:1.2.3.4').match?.value).toBe('block');
    expect(t.lookup('1.2.3.4').match).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 删除                                                                 */
/* ------------------------------------------------------------------ */

describe('delete', () => {
  it('删除具体 /128 后回退到父前缀', () => {
    const t = new RouteTable<string>();
    t.add('2001:db8::/32', 'agg');
    t.add('2001:db8:1::/48', 'site');
    t.add('2001:db8:1:2::/64', 'subnet');
    t.add('2001:db8:1:2::3/128', 'host');

    expect(t.lookup('2001:db8:1:2::3').match?.value).toBe('host');
    expect(t.delete('2001:db8:1:2::3/128')).toBe(true);
    const r = t.lookup('2001:db8:1:2::3');
    expect(r.match?.value).toBe('subnet');
    expect(r.candidates.map(c => c.prefix)).toEqual([32, 48, 64]);
  });

  it('删除 /0 后未命中', () => {
    const t = new RouteTable<string>();
    t.add('0.0.0.0/0', 'd');
    t.add('10.0.0.0/8', 'ten');
    expect(t.delete('0.0.0.0/0')).toBe(true);
    expect(t.lookup('8.8.8.8').match).toBeNull();
    expect(t.lookup('10.0.0.1').match?.value).toBe('ten');
  });

  it('删除不存在的前缀返回 false 且不影响其它路由', () => {
    const t = new RouteTable<string>();
    t.add('10.0.0.0/8', 'ten');
    expect(t.delete('10.0.0.0/16')).toBe(false);
    expect(t.delete('2001:db8::/32')).toBe(false);
    expect(t.lookup('10.1.2.3').match?.value).toBe('ten');
  });

  it('删除后 trie 分支被剪枝，可以在原路径重新插入', () => {
    const t = new RouteTable<string>();
    t.add('2001:db8::/57', 'A');
    t.add('2001:db8:0:80::/57', 'B');
    expect(t.delete('2001:db8:0:80::/57')).toBe(true);
    expect(t.lookup('2001:db8:0:80::1').match).toBeNull();
    expect(t.lookup('2001:db8::1').match?.value).toBe('A');
    t.add('2001:db8:0:80::/57', 'B2');
    expect(t.lookup('2001:db8:0:80::1').match?.value).toBe('B2');
  });

  it('删除父前缀不连带删除子前缀；同前缀重复添加是覆盖', () => {
    const t = new RouteTable<string>();
    t.add('10.0.0.0/8', 'ten');
    t.add('10.1.0.0/16', 'old');
    t.add('10.1.0.0/16', 'new');
    expect(t.lookup('10.1.0.1').match?.value).toBe('new');
    t.delete('10.0.0.0/8');
    expect(t.lookup('10.1.0.1').match?.value).toBe('new');
    expect(t.lookup('10.2.0.1').match).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 候选前缀语义 + 字节形式输入                                            */
/* ------------------------------------------------------------------ */

describe('candidates 与字节形式', () => {
  it('候选按前缀长度升序，命中字节为主机位清零的网络地址', () => {
    const t = new RouteTable<string>();
    t.add('10.0.0.0/8', 'a');
    t.add('10.1.0.0/16', 'b');
    const r = t.lookup('10.1.2.3');
    expect(r.candidates.map(c => c.value)).toEqual(['a', 'b']);
    expect([...r.candidates[1].bytes]).toEqual([10, 1, 0, 0]);
    expect(r.match && [...r.match.bytes]).toEqual([10, 1, 0, 0]);
  });

  it('接受 {family, bytes, prefix} 对象形式', () => {
    const t = new RouteTable<string>();
    const p: PrefixLike = {
      family: 4,
      bytes: Uint8Array.from([10, 0, 0, 0]),
      prefix: 8,
    };
    t.add(p, 'ten');
    expect(
      t.lookup({family: 4, bytes: Uint8Array.from([10, 9, 9, 9])}).match?.value,
    ).toBe('ten');
    expect(t.delete(p)).toBe(true);
    expect(
      t.lookup({family: 4, bytes: Uint8Array.from([10, 9, 9, 9])}).match,
    ).toBeNull();
  });

  it('接受 {network, value} 的 Route 对象形式（文本与二进制）', () => {
    const t = new RouteTable<string>();
    t.add({network: '10.0.0.0/8', value: 'text'});
    t.add({
      network: {family: 4, bytes: Uint8Array.from([192, 168, 0, 0]), prefix: 16},
      value: 'bin',
    });
    expect(t.lookup('10.1.2.3').match?.value).toBe('text');
    expect(t.lookup('192.168.1.1').match?.value).toBe('bin');
    // 同前缀再插即覆盖，返回 false
    expect(t.add({network: '10.0.0.0/8', value: 'text2'})).toBe(false);
    expect(t.lookup('10.9.9.9').match?.value).toBe('text2');
  });

  it('字节长度与地址族不符时报错', () => {
    const t = new RouteTable<string>();
    expect(() =>
      t.add({family: 4, bytes: new Uint8Array(16), prefix: 8}, 'x'),
    ).toThrow(PrefixError);
    expect(() =>
      t.lookup({family: 6, bytes: new Uint8Array(4)}),
    ).toThrow(PrefixError);
  });
});

/* ------------------------------------------------------------------ */
/* 随机朴素差分（fuzz）                                                  */
/* ------------------------------------------------------------------ */

/** 可复现的确定性 PRNG（mulberry32） */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface NaiveRoute {
  family: 4 | 6;
  bytes: Uint8Array;
  prefix: number;
  value: number;
}

/** 朴素实现：线性表 + 逐位匹配（不做族折叠，族天然隔离）。 */
class NaiveTable {
  routes: NaiveRoute[] = [];

  add(family: 4 | 6, raw: Uint8Array, prefix: number, value: number): boolean {
    const bytes = maskBits(raw, prefix);
    const i = this.routes.findIndex(
      r =>
        r.family === family &&
        r.prefix === prefix &&
        r.bytes.every((b, j) => b === bytes[j]),
    );
    if (i >= 0) {
      this.routes[i].value = value;
      return false;
    }
    this.routes.push({family, bytes: bytes.slice(), prefix, value});
    return true;
  }

  delete(family: 4 | 6, raw: Uint8Array, prefix: number): boolean {
    const bytes = maskBits(raw, prefix);
    const i = this.routes.findIndex(
      r =>
        r.family === family &&
        r.prefix === prefix &&
        r.bytes.every((b, j) => b === bytes[j]),
    );
    if (i < 0) return false;
    this.routes.splice(i, 1);
    return true;
  }

  lookup(family: 4 | 6, bytes: Uint8Array) {
    const hits = this.routes
      .filter(r => r.family === family && bitMatch(r.bytes, bytes, r.prefix))
      .sort((a, b) => a.prefix - b.prefix);
    return {
      best: hits.length ? hits[hits.length - 1].value : null,
      prefixes: hits.map(h => h.prefix),
    };
  }
}

function bitMatch(a: Uint8Array, b: Uint8Array, prefix: number): boolean {
  for (let bit = 0; bit < prefix; bit++) {
    const m = 0x80 >> (bit & 7);
    if ((a[bit >> 3] & m) !== (b[bit >> 3] & m)) return false;
  }
  return true;
}

function randomBytes(rand: () => number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

function fuzzFamily(family: 4 | 6, seed: number): void {
  const rand = rng(seed);
  const bits = family === 4 ? 32 : 128;
  const len = family === 4 ? 4 : 16;
  const trie = new RouteTable<number>();
  const naive = new NaiveTable();
  const pool: NaiveRoute[] = []; // 已插入路由的池，便于产生复用/删除

  const ROUNDS = 4000;
  for (let round = 0; round < ROUNDS; round++) {
    const roll = rand();
    if (roll < 0.55 || pool.length === 0) {
      // 插入：70% 复用已有前缀（制造覆盖/共享路径），30% 全新随机
      let bytes: Uint8Array;
      let prefix: number;
      if (pool.length && rand() < 0.7) {
        const r = pool[Math.floor(rand() * pool.length)];
        bytes = r.bytes;
        prefix = r.prefix;
      } else {
        prefix = Math.floor(rand() * (bits + 1));
        bytes = maskBits(randomBytes(rand, len), prefix);
      }
      const value = Math.floor(rand() * 1_000_000);
      const trieCreated = trie.add({family, bytes, prefix}, value);
      const naiveCreated = naive.add(family, bytes, prefix, value);
      expect(trieCreated).toBe(naiveCreated);
      if (naiveCreated) {
        pool.push({family, bytes: bytes.slice(), prefix, value});
      }
    } else if (roll < 0.75) {
      // 删除池中的随机路由
      const idx = Math.floor(rand() * pool.length);
      const r = pool[idx];
      expect(trie.delete({family, bytes: r.bytes, prefix: r.prefix})).toBe(
        naive.delete(family, r.bytes, r.prefix),
      );
      pool.splice(idx, 1);
    } else {
      // 查询随机地址，比较 LPM 值、前缀长度和候选列表
      const q = randomBytes(rand, len);
      const got = trie.lookup({family, bytes: q});
      const want = naive.lookup(family, q);
      expect(got.match ? got.match.value : null).toBe(want.best);
      expect(got.candidates.map(c => c.prefix)).toEqual(want.prefixes);
    }
  }

  // 收尾：对池中所有路由自身地址查询，必须命中自己
  for (const r of naive.routes) {
    const got = trie.lookup({family, bytes: r.bytes});
    expect(got.match?.prefix).toBe(r.prefix);
    expect(got.match?.value).toBe(r.value);
  }
}

describe('随机朴素差分', () => {
  it('IPv4：4000 轮增删查与朴素实现一致（多个种子）', () => {
    for (const seed of [1, 42, 777, 20260923]) fuzzFamily(4, seed);
  });

  it('IPv6：4000 轮增删查与朴素实现一致（偏非整字节前缀）', () => {
    for (const seed of [2, 43, 888, 20260924]) fuzzFamily(6, seed);
  });

  it('族隔离差分：两族插入相同字节模式也互不干扰', () => {
    const t = new RouteTable<number>();
    const b4 = Uint8Array.from([0, 0, 0, 0]);
    const b6 = new Uint8Array(16);
    t.add({family: 4, bytes: b4, prefix: 0}, 4);
    t.add({family: 6, bytes: b6, prefix: 0}, 6);
    expect(t.lookup({family: 4, bytes: b4}).match?.value).toBe(4);
    expect(t.lookup({family: 6, bytes: b6}).match?.value).toBe(6);
    t.delete({family: 4, bytes: b4, prefix: 0});
    expect(t.lookup({family: 4, bytes: b4}).match).toBeNull();
    expect(t.lookup({family: 6, bytes: b6}).match?.value).toBe(6);
  });

  it('mapped map 策略差分：文本 mapped 输入等价于在 v4 trie 上操作', () => {
    const rand = rng(99);
    const mapped = new RouteTable<number>({mapped: 'map'});
    const v4 = new RouteTable<number>();
    // 文本 ::ffff:a.b.c.d(/n+96)；插入时策略折叠到 v4，前缀 -96
    const v4Text = (b: Uint8Array) => `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
    const mappedText = (b: Uint8Array) => `::ffff:${v4Text(b)}`;
    for (let i = 0; i < 3000; i++) {
      const b4 = randomBytes(rand, 4);
      const p4 = Math.floor(rand() * 33);
      const roll = rand();
      if (roll < 0.6) {
        const v = Math.floor(rand() * 1e6);
        // 先在 v4 表掩码，保证两侧网络地址相同
        const net = maskBits(b4, p4);
        mapped.add(`${mappedText(net)}/${p4 + 96}`, v);
        v4.add(`${v4Text(net)}/${p4}`, v);
      } else {
        const q4 = randomBytes(rand, 4);
        const a = mapped.lookup(mappedText(q4));
        const b = v4.lookup(v4Text(q4));
        expect(a.family).toBe(4);
        expect(a.match?.value ?? null).toBe(b.match?.value ?? null);
        expect(a.candidates.map(c => c.prefix)).toEqual(
          b.candidates.map(c => c.prefix),
        );
      }
    }
  });
});
