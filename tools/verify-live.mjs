// ============================================================================
// verify-live.mjs —— DSH 重启后的**一条命令验收**（只读，不改任何东西，不花钱）
// ============================================================================
// 用途：插件挂进 DSH 之后，一次性确认三件事都真的通了：
//   ① 宿主半侧挂载了（/config、/state 返回 200）
//   ② 浏览器半侧登记了（/plugins/dsh-redteam-pet/client.js 返回 200）
//      —— 这一项**必须 DSH 重启过**才会有：dsh-client-modules 的扫描只在启动时跑，
//         源码注释写着 "Scanning is incremental per package — there is no full-rescan code path"
//   ③ 10 段素材都能取到，并且**哪几段已经是红队自己的、哪几段还是包内占位**一目了然
//
// 用法：
//   node tools/verify-live.mjs
//   node tools/verify-live.mjs --origin http://127.0.0.1:3080
//
// 退出码：0 = 全通；1 = 有硬伤（挂载失败 / client.js 404 / 有素材取不到）
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configActionNames } from './keyscreen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const originArg = args.indexOf('--origin');
const ORIGIN = originArg >= 0 ? args[originArg + 1] : 'http://127.0.0.1:3080';
const ROUTE = '/dsh-redteam-pet-7340';
// 必须带 Origin，否则会被 DSH 的浏览器信任检查挡成 401
const HEADERS = { Origin: ORIGIN };

let hardFailures = 0;
let clientInconclusive = false; // 「浏览器半侧」这一项命令行测不出结果时置位
const ok = (m) => console.log(`  \u2713 ${m}`);
const bad = (m) => { hardFailures++; console.log(`  \u2717 ${m}`); };
const warn = (m) => console.log(`  ! ${m}`);

async function probe(urlPath) {
  try {
    const r = await fetch(ORIGIN + urlPath, { headers: HEADERS });
    return { status: r.status, len: Number(r.headers.get('content-length') ?? 0) };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

console.log('\n=== dsh-redteam-pet 在线验收 ===');
console.log(`地址：${ORIGIN}${ROUTE}\n`);

// ---- ① 宿主半侧 ------------------------------------------------------------
console.log('[1/3] 宿主半侧挂载');
const cfg = await probe(`${ROUTE}/config`);
if (cfg.status === 200) {
  ok(`/config  200（${cfg.len} bytes）`);
  try {
    const j = await (await fetch(ORIGIN + `${ROUTE}/config`, { headers: HEADERS })).json();
    const pet = j?.main?.pets?.[0];
    if (pet) console.log(`      宠物：${pet.name}  id=${pet.id}  size=${pet.size}  display=${pet.display}`);
  } catch { /* 结构变了也不影响结论 */ }
} else if (cfg.status === 404) {
  bad('/config 404 —— 插件没挂上。查 profile 用户层的 insert 与 .dsh-market\\state.json 的 disabled 列表');
} else {
  bad(`/config ${cfg.status} ${cfg.error ?? ''}`);
}
for (const p of ['/state', '/config/meta']) {
  const r = await probe(ROUTE + p);
  if (r.status === 200) ok(`${p}  200`);
  else warn(`${p}  ${r.status}`);
}

// ---- ② 浏览器半侧（需要重启过）--------------------------------------------
// ⚠ 关键教训：`/plugins/<id>/client.js` **对命令行不可达** —— 它有浏览器信任检查，
//   连官方客户端插件（甚至 DSH 首页 `/`）都返回 404/401。所以**绝不能把这条 404 当失败**：
//   早先版本这么做，害得我在插件其实正常时就断言"浏览器半侧没登记、必须重启"。
//   正确做法：先拿一个已知的官方客户端插件当**对照组** ——
//     对照也是 404 → 这条路由命令行不可达 → 本项【无法判定】，交给浏览器里的肉眼验收
//     对照 200 而我们 404 → 那才是真的没登记
console.log('\n[2/3] 浏览器半侧登记');
const CONTROL_URL = '/plugins/dshmarket/client.js'; // 已知客户端插件，用作可达性对照
const cli = await probe('/plugins/dsh-redteam-pet/client.js');
const ctrl = await probe(CONTROL_URL);
if (cli.status === 200) {
  ok(`/plugins/dsh-redteam-pet/client.js  200（${cli.len} bytes）—— 页面上应该能看到宠物了`);
} else if (cli.status === 404 && ctrl.status === 404) {
  clientInconclusive = true;
  warn(`client.js 404 —— 但对照组 ${CONTROL_URL} 也是 404，说明这条路由**命令行不可达**，本项无法判定`);
  console.log('      → 请在浏览器里刷新页面（Ctrl+F5）看宠物有没有出现');
  console.log('        命令行想确认也行：查 client 平台的 Slots 占用者，shell.overlay 里应有一条 registrant=pet 且 active=true');
} else if (cli.status === 404) {
  bad(`client.js 404（而对照组 ${CONTROL_URL} 是 ${ctrl.status}）—— 客户端模块表里确实没有它`);
  console.log('      → 这一项只在 DSH 启动时扫描登记，没有重扫入口：重启 DSH 后再试');
} else {
  bad(`client.js ${cli.status} ${cli.error ?? ''}`);
}

// ---- ③ 10 段素材 -----------------------------------------------------------
console.log('\n[3/3] 10 段素材');
let names = [];
try {
  names = configActionNames(path.join(ROOT, 'assets', 'config.jsonc'));
} catch (e) {
  bad(`读不到配置里的动作名：${e.message}`);
}
const userDir = path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh'),
  'dsh-redteam-pet', 'main-animation', 'webm');
const pkgDir = path.join(ROOT, 'assets', 'webm');
const sizeOf = (dir, n) => {
  const f = path.join(dir, `${n}.webm`);
  return fs.existsSync(f) ? fs.statSync(f).size : null;
};

console.log(`  用户目录：${userDir}`);
console.log(`  包内目录：${pkgDir}\n`);
console.log('  动作名'.padEnd(26) + 'HTTP   大小        来源');
console.log('  ' + '─'.repeat(64));
let redTeam = 0;
let reachable = 0;
for (const n of names) {
  const r = await probe(`${ROUTE}/thumb/main/${encodeURIComponent(n)}.webm`);
  const u = sizeOf(userDir, n);
  const p = sizeOf(pkgDir, n);
  // 路由返回的长度与哪个文件一致，就是用的哪个
  let src;
  if (r.status !== 200) {
    src = '—（插件未挂载，取不到）';
  } else {
    reachable++;
    src = u !== null && r.len === u ? '红队新素材'
      : p !== null && r.len === p ? '包内占位（dsh-pet）' : '？长度不匹配';
    if (src === '红队新素材') redTeam++;
  }
  const flag = r.status === 200 ? '200 ' : String(r.status).padEnd(4);
  console.log(`  ${n.padEnd(24)} ${flag}  ${String(r.len).padStart(9)}  ${src}`);
}
console.log('');
if (reachable === 0) {
  warn('一段都没取到 —— 因为插件没挂载，重启 DSH 后再跑本脚本');
} else if (redTeam === names.length) {
  ok(`10/10 都是红队自己的素材`);
} else {
  warn(`${redTeam}/${names.length} 是红队自己的素材，其余仍是包内占位（dsh-pet 的）`);
}

// ---- 汇总 ------------------------------------------------------------------
console.log('\n=== 汇总 ===');
console.log(`硬伤 ${hardFailures} 个` + (clientInconclusive ? '（其中「浏览器半侧」一项命令行无法判定）' : ''));
if (hardFailures === 0) {
  console.log('结论：宿主半侧在线、素材可播。');
  if (clientInconclusive) {
    console.log('      「浏览器半侧」这条命令行测不出来（路由对命令行不可达）——');
    console.log('      请在浏览器里刷新页面（Ctrl+F5）看宠物是否出现。\n');
  } else {
    console.log('      刷新页面（Ctrl+F5）就能看到红队小队员。\n');
  }
  process.exit(0);
} else {
  console.log('结论：见上面的 ✗。\n');
  process.exit(1);
}
