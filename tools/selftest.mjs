// ============================================================================
// selftest.mjs —— dsh-redpet 本地自测：装插件之前先把配置和素材对齐验一遍
// ============================================================================
// 用法：node tools/selftest.mjs
//
// 它做四件事（全部只读，不改任何文件）：
//   1. 把 assets/config.jsonc 去掉注释后解析成 JSON —— JSONC 语法错会直接在这里暴露
//   2. 按 dsh-pet 宿主那套规则校验 animations / animationWeights / workStatusTexts / pets
//      （规则是从 dsh-pet 0.3.5 的 src/host/config.ts 抄的，见下面每个 check* 的注释）
//   3. 把配置里**引用到的每一个动作名**抽出来，逐个到 assets/webm\ 找同名 .webm
//   4. 报权重账：idle + turn + move + 各分类 weight 必须正好 = 100
//
// 退出码：0 = 全绿；1 = 有硬伤（配置非法 / 有引用不到的素材）
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'assets', 'config.jsonc');
const WEBM_DIR = path.join(ROOT, 'assets', 'webm');

let hardFailures = 0;
let warnings = 0;
const ok = (m) => console.log(`  \u2713 ${m}`);
const bad = (m) => {
  hardFailures++;
  console.log(`  \u2717 ${m}`);
};
const warn = (m) => {
  warnings++;
  console.log(`  ! ${m}`);
};

// ---------------------------------------------------------------------------
// JSONC → JSON（自己写，避免依赖：逐字符扫描，字符串内的 // 和 /* 不当注释）
// ---------------------------------------------------------------------------
function stripJsonc(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 从 config.jsonc 的**文本**里抽动作名（用于和 docs/02 对照；不依赖解析）
// ---------------------------------------------------------------------------
function collectReferencedNames(anims) {
  const names = new Set();
  for (const key of ['idle', 'turn', 'drag', 'clicks']) {
    for (const n of anims[key] ?? []) names.add(n);
  }
  for (const a of anims.moves?.actions ?? []) names.add(a.name);
  for (const cat of anims.categories ?? []) for (const n of cat.actions ?? []) names.add(n);
  for (const pool of Object.values(anims.events ?? {})) {
    for (const slot of pool) {
      if (typeof slot === 'string') names.add(slot);
      else if (Array.isArray(slot)) for (const n of slot) names.add(n);
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
console.log('\n=== dsh-redpet 自测 ===');
console.log(`包目录：${ROOT}\n`);

// --- 1. 配置能解析 ---------------------------------------------------------
console.log('[1/5] 解析 assets/config.jsonc');
let cfg;
try {
  cfg = JSON.parse(stripJsonc(fs.readFileSync(CONFIG, 'utf8')));
  ok('JSONC 解析通过');
} catch (e) {
  bad(`JSONC 解析失败：${e.message}`);
  process.exit(1);
}

// --- 2. animations 段（对应 dsh-pet config.ts 的 animationsValid） ----------
console.log('\n[2/5] 校验 animations 段结构');
const anims = cfg.animations;
if (!anims || typeof anims !== 'object') bad('animations 缺失或不是对象');
for (const key of ['idle', 'turn', 'drag', 'clicks']) {
  if (!Array.isArray(anims?.[key])) bad(`animations.${key} 必须是数组`);
  else if (anims[key].length === 0) warn(`animations.${key} 是空数组（合法，但这类触发会没动画可播）`);
  else ok(`animations.${key} = [${anims[key].join(', ')}]`);
}
const moves = anims?.moves;
if (!moves || typeof moves.default !== 'object' || moves.default === null || !Array.isArray(moves.actions)) {
  bad('animations.moves 必须是 { default: {...}, actions: [...] }');
} else {
  ok(`animations.moves.actions 长度 ${moves.actions.length}（空数组合法：消费端会回落到随机小动作）`);
}
if (!Array.isArray(anims?.categories)) bad('animations.categories 必须是数组');
else ok(`animations.categories = ${anims.categories.length} 类，共 ${anims.categories.reduce((s, c) => s + (c.actions?.length ?? 0), 0)} 个动作`);
if (!anims?.events || typeof anims.events !== 'object' || Array.isArray(anims.events)) {
  bad('animations.events 必须是对象');
} else {
  for (const [key, pool] of Object.entries(anims.events)) {
    if (!Array.isArray(pool) || pool.length === 0) {
      bad(`animations.events.${key} 必须是非空数组`);
      continue;
    }
    let slotBad = false;
    for (const slot of pool) {
      if (typeof slot === 'string') {
        if (slot.length === 0) slotBad = true;
      } else if (Array.isArray(slot)) {
        if (slot.length === 0 || slot.some((n) => typeof n !== 'string' || n.length === 0)) slotBad = true;
      } else slotBad = true;
    }
    if (slotBad) bad(`animations.events.${key} 有非法档位（空串/空数组/非字符串）`);
    else ok(`animations.events.${key} = ${pool.length} 档`);
  }
  if (!Array.isArray(anims.events.balance) || anims.events.balance.length === 0) {
    bad('animations.events.balance 必须存在且非空（宿主硬要求）');
  }
  const ws = anims.events.workStatus;
  if (Array.isArray(ws) && ws.length !== 6) {
    warn(`animations.events.workStatus 有 ${ws.length} 档，宿主按 6 档取（0..5）；不足的档会取不到动画`);
  }
}

// --- 3. 权重账（对应 weightsValid + 分类合计 = 100 - idle - turn - move） ---
console.log('\n[3/5] 校验动画权重');
const w = cfg.animationWeights;
let weightsOk = true;
for (const key of ['idle', 'turn', 'move']) {
  const v = Number(w?.[key]);
  if (!Number.isFinite(v) || v < 0) {
    bad(`animationWeights.${key} 必须是非负数字`);
    weightsOk = false;
  }
}
if (weightsOk) {
  const top = ['idle', 'turn', 'move'].reduce((s, k) => s + Number(w[k]), 0);
  const catSum = (anims.categories ?? []).reduce((s, c) => s + Number(c.weight ?? 0), 0);
  const total = top + catSum;
  const line = `idle ${w.idle} + turn ${w.turn} + move ${w.move} + 分类 ${catSum} = ${total}`;
  if (total === 100) ok(`权重账平：${line}`);
  else bad(`权重账不平（应为 100）：${line}`);
}

// --- 4. workStatusTexts / pets（对应 workStatusTextsValid + pets 必填字段） -
console.log('\n[4/5] 校验 workStatusTexts 与 pets');
const wst = cfg.workStatusTexts;
if (!Array.isArray(wst) || wst.length === 0) bad('workStatusTexts 必须是二维非空数组');
else {
  let tBad = false;
  for (const group of wst) {
    if (!Array.isArray(group) || group.length === 0) tBad = true;
    else if (group.some((t) => typeof t !== 'string' || t.length === 0)) tBad = true;
  }
  if (tBad) bad('workStatusTexts 有空的档位组或空句子');
  else if (wst.length !== 6) warn(`workStatusTexts 有 ${wst.length} 档（宿主按 6 档取，多的用不上、少的该档不弹文案）`);
  else ok('workStatusTexts = 6 档，每档非空');
}
const pets = cfg.pets;
if (!Array.isArray(pets) || pets.length === 0) bad('pets 必须是非空数组');
else {
  const ids = new Set();
  for (const p of pets) {
    const where = `pets[${p.id ?? '?'}]`;
    if (typeof p.id !== 'string' || p.id.length === 0) bad(`${where} 缺 id`);
    else if (ids.has(p.id)) bad(`宠物 id 重复：${p.id}`);
    else ids.add(p.id);
    if (typeof p.size !== 'number' || p.size <= 0) bad(`${where} size 必须是正数`);
    if (typeof p.balanceEnabled !== 'boolean') bad(`${where} balanceEnabled 必须是布尔（宿主必填）`);
    if (!['web', 'desktop', 'both', 'none'].includes(p.display)) bad(`${where} display 必须是 web/desktop/both/none 之一`);
    if (p.display === 'desktop' || p.display === 'both') {
      warn(`${where} display=${p.display} 会启用 Electron 桌面窗（本版建议 web，省一个后台进程、避开下载 Electron）`);
    }
    if (!p.position || typeof p.position.corner !== 'string') warn(`${where} 没写 position.corner，会走默认`);
    ok(`${where} name=${p.name ?? '(缺，按 id)'} size=${p.size} display=${p.display} balance=${p.balanceEnabled} fixed=${p.fixedEnabled}`);
  }
  const four = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  for (const p of pets) if (p.position && !four.includes(p.position.corner)) bad(`position.corner 非法：${p.position.corner}`);
}

// --- 5. 素材对齐：配置引用的每个名字都要有同名 .webm ------------------------
console.log('\n[5/5] 校验素材对齐（配置引用 ↔ assets/webm）');
let onDisk = [];
try {
  onDisk = fs
    .readdirSync(WEBM_DIR)
    .filter((f) => f.toLowerCase().endsWith('.webm'))
    .map((f) => f.replace(/\.webm$/i, ''));
} catch {
  bad(`素材目录读不到：${WEBM_DIR}`);
}
const onDiskSet = new Set(onDisk);
const referenced = collectReferencedNames(anims ?? {});
const missing = referenced.filter((n) => !onDiskSet.has(n));
const unused = onDisk.filter((n) => !referenced.includes(n));

console.log(`  配置引用 ${referenced.length} 个不同动作名；磁盘上 ${onDisk.length} 个 .webm`);
for (const n of referenced) {
  if (onDiskSet.has(n)) console.log(`    \u2713 ${n}`);
  else console.log(`    \u2717 ${n}   ← 配置里有、素材里没有（症状：菜单有名字，点了 404）`);
}
if (missing.length) bad(`缺 ${missing.length} 个素材：${missing.join(' / ')}`);
else ok('配置引用的每一个动作名都能在 assets/webm 找到');
if (unused.length) warn(`磁盘上有 ${unused.length} 个素材没被任何池子引用（纯浪费，可删）：${unused.join(' / ')}`);

// --- 汇总 ------------------------------------------------------------------
console.log('\n=== 汇总 ===');
console.log(`硬伤 ${hardFailures} 个，告警 ${warnings} 个`);
if (hardFailures === 0) {
  console.log('结论：配置合法、素材对齐 —— 可以装插件了。\n');
  process.exit(0);
} else {
  console.log('结论：先修上面的硬伤，别急着装。\n');
  process.exit(1);
}
