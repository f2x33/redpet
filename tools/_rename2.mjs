// ============================================================================
// _rename2.mjs —— 第二轮改名：dsh-redteam-pet → dsh-redpet（统一用 redpet 这个短标识）
// ============================================================================
// 背景：上一轮 tools/_rename.mjs 把 dsh-pet 的构建产物改成了 dsh-redteam-pet。
//       实测发现 `redteam-pet` 这个名字体系仍在和 dsh-pet 抢命名空间（命令名等），
//       本轮的方针是：**所有标识符统一收敛到 `redpet`**，一次性切断与 dsh-pet 的耦合。
//
// 三组替换（顺序不能变，原因见下）：
//   ① redteam-pet → redpet   把 dsh-redteam-pet 变成 dsh-redpet，同时吃掉裸 redteam-pet
//   ② rpet        → redpet   命令名 /rpet、/rpet-balance，以及气泡 CSS 命名空间 rpet-bub-*
//   ③ rchat       → redchat  命令名 /rchat
//
// 顺序为什么不能变：
//   · `redpet` 里**不含** `rpet`（r-e-d-p-e-t vs r-p-e-t），所以①做完再做②不会二次替换。
//   · 先做②也不冲突，但先做①能让 ② 的命中数如实反映"命令名/类名"这一类，便于核对。
//
// 覆盖面（实测：redteam 从不单独出现，全部包含在 redteam-pet 里）：
//   · 宿主半侧 lib/index.js：日志前缀 [<ID>]、HTTP 路由 /<ID>-7340/、effect 标签、错误体
//   · 浏览器半侧 lib/client.js：模块 id、dataset.plugin、CSS 类名 <ID>-cfg__*、CSS 变量
//     --<ID>-size、fetch 路由 /<ID>-7340/config
//   · assets/config.jsonc：注释里的 $DSH_HOME\<ID>\ 路径说明
//   · cordis.patch.yml：entry 的 id / name
//   · package.json：包名
//   · runtime/electron-helper/*：桌面（Electron）模式的同一套标识
//
// 不动的文件：
//   · tools/_rename.mjs        上一轮的历史脚本，改了就看不出当时改了什么
//   · tools.bak-*/             上一轮的备份
//   · out/                     生成物（图片/视频）
//   · node_modules/ .git/      依赖与版本库
//
// 用法：
//   node tools/_rename2.mjs --dry     # 只报告会改多少处，不落盘
//   node tools/_rename2.mjs           # 真正改名
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');

/** 只处理文本文件；二进制（webm/png/ttf）直接跳过 */
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.jsonc', '.yml', '.yaml',
  '.md', '.html', '.css', '.ps1', '.cmd', '.bat', '.txt',
  '.gitignore', '.gitattributes',
]);

/** 相对路径排除表（前缀匹配） */
const SKIP = [
  'node_modules',
  '.git',
  'out',
  'tools/_rename.mjs', // 上一轮的历史记录
  'tools/_rename2.mjs', // 本文件自身
];
const SKIP_PREFIXES = ['tools.bak-'];

const RULES = [
  { from: 'redteam-pet', to: 'redpet' },
  { from: 'rpet', to: 'redpet' },
  { from: 'rchat', to: 'redchat' },
];

// ============================================================================
// PROTECT —— 绝不能跟着改的「外部标识」保护表
// ============================================================================
// 【为什么必须有这张表】
//   2026-10-05 这次改名把 tools/gh-publish.mjs 里的**发布目标仓库名**也一起改了：
//       const REPO = process.env.GH_REPO || 'f2x33/redteam-pet';   // 原样
//    →  const REPO = process.env.GH_REPO || 'f2x33/redpet';         // 仓库不存在！
//   于是发布工具指向一个 404 的仓库，整条发布链路废掉。
//
// 【最关键的教训】
//   改完之后我做过"残留扫描"（搜还有没有 redteam），**它是干净的** ——
//   因为问题不是"改漏了"，而是"改多了"。**残留扫描在原理上抓不出过度替换。**
//   所以要防这类错，唯一有效的办法是**在替换前就把不能碰的字符串摘出来**。
//
// 【实现】替换前先把这些字面量换成 NUL 占位符，规则跑完再还原。
//   占位符含 \u0000，不可能出现在源码里，也不可能被 FROM 命中。
//   按长度**降序**处理，避免短串先替换破坏长串（如 f2x33/redteam-pet 是
//   f2x33/redteam-pet-desktop 的前缀）。
//
// 【新增外部标识时】往这里加一条，别指望残留扫描能发现。
// ============================================================================
const PROTECT = [
  'f2x33/redteam-pet-desktop', // 姊妹项目 redteam-pet-desktop 的 GitHub 仓库
  'f2x33/redpet',              // 本包当前的 GitHub 仓库（发布目标，2026-10-05 创建）
  'f2x33/redteam-pet',         // 本包**旧**仓库名（历史记录里会提到，保住原样别被改）
  'PC2005-cloud/dsh-pet',      // 上游 dsh-pet 仓库署名
].sort((a, b) => b.length - a.length);

const slot = (i) => `\u0000PROTECT${String(i)}\u0000`;
const protectAll = (text) => {
  let out = text;
  PROTECT.forEach((lit, i) => { out = out.split(lit).join(slot(i)); });
  return out;
};
const restoreAll = (text) => {
  let out = text;
  PROTECT.forEach((lit, i) => { out = out.split(slot(i)).join(lit); });
  return out;
};
const countAll = (text) => PROTECT.map((lit) => text.split(lit).length - 1);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (SKIP.some((s) => rel === s || rel.startsWith(s + '/'))) continue;
    if (SKIP_PREFIXES.some((p) => rel.startsWith(p))) continue;
    if (e.isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(path.extname(e.name).toLowerCase()) || e.name.startsWith('.git')) out.push({ full, rel });
  }
  return out;
}

const files = walk(ROOT);
const totals = Object.fromEntries(RULES.map((r) => [r.from, 0]));
const protectTotals = PROTECT.map(() => 0);
const touched = [];
const pending = [];

for (const { full, rel } of files) {
  const before = fs.readFileSync(full, 'utf8');
  const beforeProtect = countAll(before);
  beforeProtect.forEach((n, i) => { protectTotals[i] += n; });

  // ① 先把受保护的字符串摘出来，② 再跑替换规则，③ 最后原样还原
  let after = protectAll(before);
  const hits = {};
  for (const { from, to } of RULES) {
    const n = after.split(from).length - 1;
    if (n > 0) {
      hits[from] = n;
      totals[from] += n;
      after = after.split(from).join(to);
    }
  }
  after = restoreAll(after);

  // ④ 守门：受保护字符串的数量必须一字不差
  const afterProtect = countAll(after);
  const drift = PROTECT.map((lit, i) => ({ lit, was: beforeProtect[i], now: afterProtect[i] })).filter((d) => d.was !== d.now);

  if (Object.keys(hits).length === 0 && drift.length === 0) continue;
  if (drift.length > 0) {
    console.error(`❌ ${rel}: 受保护字符串数量变了！（保护表失效，已中止，未写入任何文件）`);
    for (const d of drift) console.error(`     ${d.lit}: ${d.was} → ${d.now}`);
    process.exit(1);
  }
  touched.push({ rel, hits });
  pending.push({ full, after });
}

// 全部校验通过后才落盘
if (!DRY) for (const { full, after } of pending) fs.writeFileSync(full, after, 'utf8');

touched.sort((a, b) => {
  const sa = Object.values(a.hits).reduce((x, y) => x + y, 0);
  const sb = Object.values(b.hits).reduce((x, y) => x + y, 0);
  return sb - sa;
});

console.log(DRY ? '== 试运行（未落盘）==' : '== 已改名 ==');
for (const { rel, hits } of touched) {
  const desc = Object.entries(hits).map(([k, v]) => `${k}×${v}`).join('  ');
  console.log(`  ${String(Object.values(hits).reduce((x, y) => x + y, 0)).padStart(4)} 处  ${rel.padEnd(44)} ${desc}`);
}
console.log('\n合计：');
for (const { from, to } of RULES) console.log(`  ${from} → ${to}：${totals[from]} 处`);
console.log(`  涉及文件：${touched.length} 个`);

console.log('\n外部标识保护表（这些一处都没动）：');
PROTECT.forEach((lit, i) => console.log(`  ${protectTotals[i] > 0 ? '✅' : '·'} ${lit.padEnd(30)} 共 ${protectTotals[i]} 处`));

if (DRY) console.log('\n（--dry：没有写任何文件）');

