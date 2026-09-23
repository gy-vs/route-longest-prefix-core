# IP routing core

TypeScript longest-prefix-match (LPM) routing table for IPv4 and IPv6.

- 地址解析为**固定地址族位串**（IPv4 = 32 位、IPv6 = 128 位），前缀长度
  **逐位**进入二进制 trie 路径比较——`/57`、`/73`、`/31` 等非整字节边界
  不会按整字节忽略剩余位，更短路由不会覆盖更具体路由。
- IPv4 与 IPv6 使用**相互隔离的两棵 trie**。
- IPv4-mapped IPv6（`::ffff:a.b.c.d`）**默认不折叠**（`isolate`），
  是否折叠由构造时的显式策略 `{ mapped: 'map' }` 决定；折叠时前缀长度同步 `-96`。
- 查询返回最长匹配，以及沿途经过的全部候选前缀（按前缀长度升序）。

Run `npm install`, then `npm test` and `npm run build`.

## 用法

```ts
import {RouteTable} from './src/index.js';

const t = new RouteTable<string>();          // mapped 默认 isolate
t.add('2001:db8::/32', 'doc');
t.add('2001:db8:1:80::/57', 'specific');     // 非整字节前缀

const r = t.lookup('2001:db8:1:ff::1');
r.match?.value;            // 'specific'（最长匹配）
r.candidates.map(c => c.prefix); // [32, 57]（经过的候选前缀）
r.match?.bytes;            // 主机位清零后的网络地址 Uint8Array

t.delete('2001:db8:1:80::/57');

// 显式折叠 mapped 地址到 IPv4
const t2 = new RouteTable<string>({mapped: 'map'});
t2.add('10.0.0.0/8', 'v4');
t2.lookup('::ffff:10.1.2.3').match?.value;   // 'v4'，family === 4

// 也接受二进制形式 {family, bytes, prefix} / {family, bytes}
t.add({family: 4, bytes: Uint8Array.from([10, 0, 0, 0]), prefix: 8}, 'ten');
```

文本解析工具（`parseAddress` / `parsePrefix` / `formatAddress` /
`formatPrefix` / `maskBits` / `isIPv4Mapped`）也独立导出。非法输入抛出
`PrefixError`。
