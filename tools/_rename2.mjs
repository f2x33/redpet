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
const touched = [];

for (const { full, rel } of files) {
  const before = fs.readFileSync(full, 'utf8');
  let after = before;
  const hits = {};
  for (const { from, to } of RULES) {
    const n = after.split(from).length - 1;
    if (n > 0) {
      hits[from] = n;
      totals[from] += n;
      after = after.split(from).join(to);
    }
  }
  if (Object.keys(hits).length === 0) continue;
  touched.push({ rel, hits });
  if (!DRY) fs.writeFileSync(full, after, 'utf8');
}

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

if (DRY) console.log('\n（--dry：没有写任何文件）');
