// ============================================================================
// keyscreen.mjs —— 绿幕视频 → 透明 VP9-alpha webm（批量，640×360）
// ============================================================================
// 用法：
//   node tools/keyscreen.mjs                        # out/raw/*.mp4|mov|webm → out/webm/*.webm
//   node tools/keyscreen.mjs --in 某目录 --out 某目录
//   node tools/keyscreen.mjs --only 写代码,东张西望   # 只转这两段
//   node tools/keyscreen.mjs --force                # 已存在的输出也重转
//   node tools/keyscreen.mjs --similarity 0.22      # 绿边没抠干净就调大；头发被吃就调小
//   node tools/keyscreen.mjs --mask 820,1980,332,68 # 用绿块盖水印（**原图**像素，可写多次）
//   node tools/keyscreen.mjs --mask-rel 0.64,0.92,0.26,0.05  # 同上，但用 0~1 比例（不同分辨率通用）
//   node tools/keyscreen.mjs --dry                  # 只打印将要做什么，不动文件
//   node tools/keyscreen.mjs --ignore-encoder-check # 明知 ffmpeg 不合格也硬跑（排查用）
//
// 本文件同时充当**共用工具库**：configActionNames() / findFfmpeg() / probe* 被
// gen-api.mjs 与 pipeline.mjs import。import 它不会执行 main()（文件末尾才判 isMain），
// 也不会在顶层找 ffmpeg（都是懒加载），所以可以放心 import。
//
// ⚠ 四个已经踩过的坑，别改：
//   1. 读 webm 的 alpha **必须显式 `-c:v libvpx-vp9`**（走 libvpx 解码器）。
//      用 ffmpeg 默认解码器会**静默丢掉 alpha**，于是你会看到「pix_fmt 里没有 alpha /
//      素材像是没有透明」——素材其实是好的。本脚本所有 webm 探测都带这个参数。
//   2. 编码必须 `-auto-alt-ref 0`：开了 alternate-ref 会把 alpha 吃掉。
//   3. 编码必须显式 `-c:v libvpx-vp9`：**不是所有 ffmpeg 都带这个编码器**
//      （剪映内置版、marscode 的精简版都没有，都在本机实测过）。所以本脚本先做能力体检，
//      不合格就带着「怎么办」报错退出，而不是闷头产出 10 个没有 alpha 的文件；
//      体检不合格时还会去本机兜底候选里找一个真能用的（见 FFMPEG_EXTRA），换之前会大声说明。
//   4. 文件名必须与 assets/config.jsonc 的 animations 段**逐字一致**（中文、连字符都不能差）。
//      差一个字的表现是：右键菜单里有名字，点了没反应（素材 404）。本脚本会对着配置校验并告警。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ------------------------------------------------------------------ 路径常量
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const CONFIG_FILE = path.join(ROOT, 'assets', 'config.jsonc');

/** 插件素材规格：640×360（16:9），必须是这个尺寸，客户端按它摆宠物。 */
export const OUT_WIDTH = 640;
export const OUT_HEIGHT = 360;

const IN_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi']);

/**
 * 已知 ffmpeg 位置（本机 PATH 上没有，所以按顺序硬找；版本号会变，JetBrains 那个用递归找）。
 * 注意：**这三个都不一定能用**。实测（本机）：
 *   · 剪映内置版    —— 有 vp9 解码，但**没有 libvpx-vp9 编码器**（编不出 alpha 的 webm）；
 *   · marscode 版   —— 精简构建，只有 libx264，连 colorkey 滤镜都没有。
 * 所以下面按题目要求「第一个存在的就用」，但选出来之后会做能力体检，
 * 不合格再去 FFMPEG_EXTRA 里找一个真能用的（会大声打印，不会静默换）。
 */
const FFMPEG_KNOWN = [
  'C:\\Users\\ncdyj\\AppData\\Local\\JianyingPro\\Apps\\10.6.0.14057\\ffmpeg.exe',
  'C:\\Users\\ncdyj\\.marscode\\ai-chat\\binary\\1.7.0.0\\modules\\ai-agent\\ffmpeg.exe',
];
const FFMPEG_GLOB_DIRS = [
  'C:\\Users\\ncdyj\\AppData\\Roaming\\JetBrains\\PyCharm2025.3\\plugins\\marscode',
];

/**
 * 【本机实测补充】题面给的三个位置都编不出 VP9-alpha，本脚本在机器上又扫到几个 ffmpeg。
 * 这一个（Loomy 自带的 ffmpeg-static）是 gyan essentials 完整构建，带 libvpx-vp9 编解码
 * + colorkey/despill/alphaextract，唯一真能干活的那个，所以列为**兜底候选**：
 * 只在上面的首选体检不合格时才用，用之前会打印「首选为什么不行 / 改用谁」。
 * 不想让它自动换：--no-ffmpeg-fallback（或直接把 $env:FFMPEG 指向你要的那个，显式指定优先）。
 */
const FFMPEG_EXTRA = [
  'D:\\Program Files\\Loomy\\resources\\ffmpeg-static\\ffmpeg.exe',
  'D:\\tmp\\Trae CN\\resources\\app\\bin\\ffmpeg.exe',
  'D:\\tmp\\TRAE SOLO CN\\resources\\app\\bin\\ffmpeg.exe',
];

/** 是否允许「首选不合格时自动改用兜底候选」（--no-ffmpeg-fallback 关掉）。 */
let allowFallback = true;

// ============================================================================
// 一、共用工具：从 config.jsonc 的 animations 段抽动作名（唯一事实来源）
// ============================================================================
/**
 * 剥掉 JSONC 的注释。必须带字符串状态机——注释里也会出现引号、`[`、名字，
 * 直接正则删注释会把配置内容也删掉。
 */
function stripJsoncComments(text) {
  let out = '';
  let inStr = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } else out += ' '; continue; }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; out += '  '; i++; }
      else out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') { out += n === undefined ? '' : n; i++; }
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; out += '  '; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; out += '  '; i++; continue; }
    out += c;
  }
  return out;
}

/** 从 from（必须是 '{'）开始配对花括号，返回块内文本。 */
function braceBlock(text, from) {
  let depth = 0, inStr = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(from + 1, i); }
  }
  return text.slice(from + 1);
}

/** 收集 block 里所有字符串字面量，并标出它是「键」还是「值」。 */
function stringLiterals(block) {
  const out = [];
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== '"') continue;
    let j = i + 1, val = '';
    while (j < block.length) {
      if (block[j] === '\\') { val += block[j + 1] ?? ''; j += 2; continue; }
      if (block[j] === '"') break;
      val += block[j]; j++;
    }
    let k = j + 1;
    while (k < block.length && /\s/.test(block[k])) k++;
    out.push({ value: val, isKey: block[k] === ':' });
    i = j;
  }
  return out;
}

/**
 * 从 config.jsonc 的 `"animations": { ... }` 段里抽出**所有动作名**（去重，保持出现顺序）。
 *
 * 口径（照着配置的结构来，不真解析 JSONC）：
 *   · 只认「值位置」的字符串 —— 键（后面跟 `:`）不算；
 *   · 再排除紧跟在 `"id"` / `"weight"` 后面的值 —— 那是随机分类的元数据，
 *     比如 { "id": "写码", ... "actions": ["写代码"] } 里的 "写码" 不是素材名；
 *   · 其余就是动作名：idle / turn / drag / clicks / categories[].actions / events.*。
 */
export function configActionNames(configFile = CONFIG_FILE) {
  const raw = fs.readFileSync(configFile, 'utf8');
  const clean = stripJsoncComments(raw);
  const key = clean.indexOf('"animations"');
  if (key < 0) throw new Error(`config.jsonc 里找不到 "animations" 段：${configFile}`);
  const brace = clean.indexOf('{', key);
  if (brace < 0) throw new Error(`"animations" 后面没有对象：${configFile}`);
  const block = braceBlock(clean, brace);

  const names = [];
  const lits = stringLiterals(block);
  for (let i = 0; i < lits.length; i++) {
    const lit = lits[i];
    if (lit.isKey) continue;
    const prev = lits[i - 1];
    if (prev && prev.isKey && (prev.value === 'id' || prev.value === 'weight')) continue; // 分类元数据
    if (/^\d+$/.test(lit.value) || !lit.value) continue;
    if (!names.includes(lit.value)) names.push(lit.value);
  }
  return names;
}

// ============================================================================
// 二、共用工具：ffmpeg 定位 + 能力体检 + 进程封装
// ============================================================================
function findFilesUnder(dir, fileName, maxDepth, depth = 0) {
  if (depth > maxDepth) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const hits = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === fileName.toLowerCase()) hits.push(full);
    else if (e.isDirectory()) hits.push(...findFilesUnder(full, fileName, maxDepth, depth + 1));
  }
  return hits;
}

/** 候选列表（保持优先级：$env:FFMPEG → PATH → 已知位置 → JetBrains 递归找 → 兜底候选）。 */
export function ffmpegCandidates() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const list = [];
  const add = (p) => { if (p && !list.includes(p)) list.push(p); };
  if (process.env.FFMPEG) add(process.env.FFMPEG);
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir.trim()) add(path.join(dir.trim(), exe));
  }
  for (const p of FFMPEG_KNOWN) add(p);
  for (const dir of FFMPEG_GLOB_DIRS) {
    for (const p of findFilesUnder(dir, exe, 8)) add(p);
  }
  for (const p of FFMPEG_EXTRA) add(p);
  return list;
}

let _resolved = null;

function isCapable(file) {
  try { return ffmpegCapabilities(file).ok; } catch { return false; }
}

/** 解析一次并缓存：{ file, source }，source 是「凭什么叫它」的中文说明。 */
function resolveFfmpeg() {
  if (_resolved) return _resolved;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

  // ① 用户显式指定：绝对优先，且**不**做任何替换（他想测哪个就测哪个，体检不合格会照样报错）
  if (process.env.FFMPEG && fs.existsSync(process.env.FFMPEG)) {
    _resolved = { file: process.env.FFMPEG, source: '$env:FFMPEG 环境变量（显式指定，不再自动替换）' };
    return _resolved;
  }
  // ② 题目要求的顺序：PATH → 已知位置 → JetBrains 递归找，第一个存在的就用
  const chain = [];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir.trim()) chain.push({ file: path.join(dir.trim(), exe), source: 'PATH' });
  }
  for (const p of FFMPEG_KNOWN) chain.push({ file: p, source: '已知安装位置' });
  for (const dir of FFMPEG_GLOB_DIRS) {
    for (const p of findFilesUnder(dir, exe, 8)) chain.push({ file: p, source: 'JetBrains marscode 插件目录（递归找到）' });
  }
  const first = chain.find((c) => fs.existsSync(c.file));
  if (first) {
    if (isCapable(first.file)) { _resolved = first; return _resolved; }
    // 首选在，但编不出 VP9-alpha —— 去兜底候选里找一个真能用的，并且大声说清楚
    if (allowFallback) {
      const alt = FFMPEG_EXTRA.find((p) => fs.existsSync(p) && isCapable(p));
      if (alt) {
        console.warn(`⚠ 首选 ffmpeg 不能做 VP9-alpha：${first.file}`);
        console.warn('  原因：没有 libvpx-vp9 编码器（剪映/marscode 自带的构建都是这样），跑下去只会产出不透明的 webm。');
        console.warn(`  已自动改用兜底候选：${alt}`);
        console.warn('  想固定用它：$env:FFMPEG = "' + alt + '"；不想自动换：--no-ffmpeg-fallback');
        _resolved = { file: alt, source: '兜底候选（首选不合格，已自动改用）', fallbackFrom: first.file };
        return _resolved;
      }
    }
    _resolved = first; // 没有能用的兜底：保留首选，让体检报错把问题讲清楚
    return _resolved;
  }
  // ③ 一个都没有：报错 + 教怎么设，不自作主张下载
  const how = [
    '找不到 ffmpeg（本机 PATH 上没有，已知位置也都没有）。',
    '本脚本**不会**自动下载，请手工处理其中一种：',
    '  1) 装一个完整版 ffmpeg（必须带 libvpx-vp9，例如 winget install Gyan.FFmpeg）；',
    '  2) 已经有 ffmpeg 的话，直接告诉本脚本它在哪：',
    '       $env:FFMPEG = "C:\\path\\to\\ffmpeg.exe"     # 当前 PowerShell 会话有效',
    '       [Environment]::SetEnvironmentVariable("FFMPEG", "C:\\path\\to\\ffmpeg.exe", "User")  # 永久',
    '  3) 复核：node tools/keyscreen.mjs --dry',
  ].join('\n');
  throw new Error(how);
}

/** 找到的 ffmpeg 可执行文件绝对路径（找不到会抛错，错误里带解决办法）。 */
export function findFfmpeg() {
  return resolveFfmpeg().file;
}

/** 「这个 ffmpeg 是从哪找到的」的中文说明，用来打印。 */
export function findFfmpegSource() {
  return resolveFfmpeg().source;
}

// ------------------------------------------------------------------ 进程封装
// ⚠ 不用管道抓输出：某些受限沙箱里 Node 的 child_process 管道会 EPERM。
//    需要读输出时一律让 ffmpeg 写文件，再读文件。
let logSeq = 0;
export function runFfmpeg(args, { capture = false, quiet = true, ffmpegFile = null } = {}) {
  const exe = ffmpegFile || findFfmpeg();
  const logFile = path.join(os.tmpdir(), `keyscreen-${process.pid}-${logSeq++}.log`);
  const fd = fs.openSync(logFile, 'w');
  let r;
  try {
    r = spawnSync(exe, args, {
      stdio: capture || quiet ? ['ignore', fd, fd] : ['ignore', 'inherit', 'inherit'],
    });
  } finally {
    fs.closeSync(fd);
  }
  let log = '';
  try { log = fs.readFileSync(logFile, 'utf8'); } catch { /* 读不到就算空 */ }
  try { fs.unlinkSync(logFile); } catch { /* 删不掉留着也无害 */ }
  if (r.error) throw r.error;
  return { status: r.status, log };
}

/** 能力体检：编码器/解码器/滤镜。结果缓存，只探一次。 */
let _cap = null;
export function ffmpegCapabilities(ffmpegFile = null) {
  if (!ffmpegFile && _cap) return _cap;
  const exe = ffmpegFile || findFfmpeg();
  const enc = runFfmpeg(['-hide_banner', '-encoders'], { capture: true, ffmpegFile: exe }).log;
  const dec = runFfmpeg(['-hide_banner', '-decoders'], { capture: true, ffmpegFile: exe }).log;
  const fil = runFfmpeg(['-hide_banner', '-filters'], { capture: true, ffmpegFile: exe }).log;
  const has = (log, name) => new RegExp(`(^|\\s)${name}(\\s|$)`, 'm').test(log);
  const cap = {
    exe,
    encVp9: has(enc, 'libvpx-vp9'),          // 没它 = 编不出带 alpha 的 VP9 webm
    decVp9: has(dec, 'libvpx-vp9'),          // 没它 = 读不到 webm 的 alpha
    filterColorkey: has(fil, 'colorkey'),
    filterDespill: has(fil, 'despill'),
    filterAlphaextract: has(fil, 'alphaextract'),
  };
  cap.ok = cap.encVp9 && cap.filterColorkey && cap.filterAlphaextract;
  if (!ffmpegFile) _cap = cap;
  return cap;
}

/** 体检不合格时的长篇报错：列出每个候选缺什么 + 怎么办。 */
function capabilityReport(primary) {
  const lines = [];
  lines.push('当前 ffmpeg 不能做「绿幕 → VP9-alpha webm」，先别往下跑（跑也是白跑）。');
  lines.push(`用的这个：${primary.exe}`);
  const lack = [];
  if (!primary.encVp9) lack.push('缺编码器 libvpx-vp9（没有它就编不出带 alpha 的 webm）');
  if (!primary.decVp9) lack.push('缺解码器 libvpx-vp9（读 webm 的 alpha 会不准）');
  if (!primary.filterColorkey) lack.push('缺滤镜 colorkey（没法抠绿）');
  if (!primary.filterAlphaextract) lack.push('缺滤镜 alphaextract（没法复检 alpha）');
  if (!primary.filterDespill) lack.push('缺滤镜 despill（边缘会返绿，可接受）');
  for (const l of lack) lines.push(`  · ${l}`);
  lines.push('');
  lines.push('本机所有候选的体检结果：');
  const usable = [];
  for (const p of ffmpegCandidates()) {
    if (!fs.existsSync(p)) continue;
    let c;
    try { c = ffmpegCapabilities(p); } catch (e) { lines.push(`  ${p}\n      × 连启动都不行：${e.message}`); continue; }
    const bad = [];
    if (!c.encVp9) bad.push('无 libvpx-vp9 编码器');
    if (!c.decVp9) bad.push('无 libvpx-vp9 解码器');
    if (!c.filterColorkey) bad.push('无 colorkey');
    if (!c.filterAlphaextract) bad.push('无 alphaextract');
    lines.push(`  ${p}\n      ${bad.length ? '× ' + bad.join(' / ') : '✓ 可用'}`);
    if (!bad.length) usable.push(p);
  }
  lines.push('');
  if (usable.length) {
    lines.push('本机就有能用的，照抄这行即可：');
    lines.push(`  $env:FFMPEG = "${usable[0]}"`);
    lines.push('（然后重跑 node tools/keyscreen.mjs；pipeline.mjs 会继承同一个 $env:FFMPEG）');
  } else {
    lines.push('本机没扫到能用的 ffmpeg，那就得先装一个完整版（见下）。');
  }
  lines.push('');
  lines.push('怎么办（本脚本不会自己下载 ffmpeg）：');
  lines.push('  1) 装一个完整版 ffmpeg（官方 full/essentials 构建、Gyan/BtbN 的 win64-gpl 都带 libvpx）：');
  lines.push('       winget install Gyan.FFmpeg');
  lines.push('  2) 让本脚本用它：');
  lines.push('       $env:FFMPEG = "C:\\path\\to\\ffmpeg.exe"');
  lines.push('  3) 复核：node tools/keyscreen.mjs --dry');
  lines.push('  实在要在没 libvpx 的构建上试（产出的 webm 一定不透明）：--ignore-encoder-check');
  return lines.join('\n');
}

// ============================================================================
// 三、共用工具：webm 探测（alpha / 尺寸 / 时长 / 编码）
// ============================================================================
/** 输入是 webm 时才加 libvpx 解码器；且当前 ffmpeg 真有它才加（否则 ffmpeg 直接报 Unknown decoder）。 */
function decodeArgs(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext !== '.webm') return [];
  if (!ffmpegCapabilities().decVp9) return []; // 没有 libvpx：只能退化为默认解码器，alpha 可能读不到
  return ['-c:v', 'libvpx-vp9'];
}

/**
 * 读 webm 的 alpha 标记：1（有）/ 0（明确写了 0）/ null（没读到）。
 * 两个细节：
 *   1. 大写 ALPHA_MODE 来自 Matroska Track 层（官方素材就是这种），
 *      小写 alpha_mode 来自 libvpx 解码器层 —— **大小写都要认**，否则会把好文件判成没 alpha。
 *   2. 没有 libvpx 解码器时这里读不到，返回 null（判据交给 probeAlphaPixels 兜底）。
 */
export function probeAlphaMode(file) {
  const { log } = runFfmpeg(['-hide_banner', ...decodeArgs(file), '-i', file], { capture: true });
  const m = log.match(/alpha_mode\s*:\s*(\d+)/i);
  if (m) return Number(m[1]);
  return /yuva|rgba|argb|bgra/.test(log) ? 1 : null;
}

/**
 * 实测一帧 alpha：返回 { min, max, has0, has255, bytes }。
 * 复检判据就是题目要求的「解一帧看 alpha 是否真的有 0 和 255」：
 * 真的抠干净了，一定同时出现全透明（0）和全不透明（255）。
 */
export function probeAlphaPixels(file) {
  const raw = path.join(os.tmpdir(), `keyscreen-alpha-${process.pid}-${logSeq++}.raw`);
  try {
    runFfmpeg(
      ['-hide_banner', '-y', ...decodeArgs(file), '-i', file, '-frames:v', '1',
        '-vf', 'alphaextract', '-f', 'rawvideo', '-pix_fmt', 'gray', raw],
      { capture: true },
    );
    if (!fs.existsSync(raw)) return null;
    const b = fs.readFileSync(raw);
    if (!b.length) return null;
    let min = 255, max = 0, has0 = false, has255 = false;
    for (const v of b) {
      if (v < min) min = v;
      if (v > max) max = v;
      if (v === 0) has0 = true;
      else if (v === 255) has255 = true;
    }
    return { min, max, has0, has255, bytes: b.length };
  } finally {
    if (fs.existsSync(raw)) fs.unlinkSync(raw);
  }
}

/** 视频基本信息：编码、宽高、时长、是否 yuva。不依赖 ffprobe（本机没有 ffprobe）。 */
export function probeInfo(file) {
  const { log } = runFfmpeg(['-hide_banner', ...decodeArgs(file), '-i', file], { capture: true });
  const v = log.match(/Video:\s*([A-Za-z0-9_]+).*?(\d{2,5})x(\d{2,5})/);
  const d = log.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  const pixLine = log.split('\n').find((l) => /Video:/.test(l)) || '';
  return {
    codec: v ? v[1] : null,
    w: v ? Number(v[2]) : null,
    h: v ? Number(v[3]) : null,
    sec: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    yuvAlpha: /yuva|rgba|argb|bgra/.test(pixLine),
  };
}

/**
 * 绿边残留检测：数「不透明、但颜色仍然很绿」的像素。
 * 抠像最常见的翻车是人物边缘留一圈绿 —— 小尺寸下人眼看不出来，放到页面上像发绿光。
 * 判据：alpha>32（算前景）且 g-r>40 且 g-b>40。
 */
export function probeFringe(file) {
  const raw = path.join(os.tmpdir(), `keyscreen-fringe-${process.pid}-${logSeq++}.raw`);
  try {
    runFfmpeg(
      ['-hide_banner', '-y', ...decodeArgs(file), '-i', file, '-frames:v', '1',
        '-f', 'rawvideo', '-pix_fmt', 'rgba', raw],
      { capture: true },
    );
    if (!fs.existsSync(raw)) return null;
    const b = fs.readFileSync(raw);
    let opaque = 0, fringe = 0;
    for (let i = 0; i < b.length; i += 4) {
      if (b[i + 3] <= 32) continue;
      opaque++;
      if (b[i + 1] - b[i] > 40 && b[i + 1] - b[i + 2] > 40) fringe++;
    }
    return { opaque, fringe, ratio: opaque ? fringe / opaque : 0 };
  } finally {
    if (fs.existsSync(raw)) fs.unlinkSync(raw);
  }
}

// ============================================================================
// 四、命令行
// ============================================================================
function parseArgs(argv) {
  const o = {
    in: path.join(ROOT, 'out', 'raw'),
    out: path.join(ROOT, 'out', 'webm'),
    key: '0x00FF00',
    similarity: 0.3,
    blend: 0.1,
    width: OUT_WIDTH,
    height: OUT_HEIGHT,
    crf: 10,
    cpuUsed: 4,
    noKey: false,
    despill: true,
    force: false,
    dry: false,
    only: null,
    masks: [],
    masksRel: [],
    ignoreEncoderCheck: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺参数值`);
      return v;
    };
    switch (a) {
      case '--in': o.in = path.resolve(val()); break;
      case '--out': o.out = path.resolve(val()); break;
      case '--key': o.key = val(); break;
      case '--similarity': {
        o.similarity = Number(val());
        if (!Number.isFinite(o.similarity) || o.similarity < 0 || o.similarity > 1) throw new Error('--similarity 必须是 0~1 的数字');
        break;
      }
      case '--blend': o.blend = Number(val()); break;
      case '--width': o.width = Number(val()); break;
      case '--height': o.height = Number(val()); break;
      case '--crf': o.crf = Number(val()); break;
      case '--cpu-used': o.cpuUsed = Number(val()); break;
      case '--only': o.only = val().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--mask': {
        const [x, y, w, h] = val().split(',').map(Number);
        if ([x, y, w, h].some((n) => !Number.isFinite(n))) throw new Error('--mask 格式：x,y,w,h（原图像素）');
        o.masks.push({ x, y, w, h });
        break;
      }
      case '--mask-rel': {
        const [x, y, w, h] = val().split(',').map(Number);
        if ([x, y, w, h].some((n) => !Number.isFinite(n))) throw new Error('--mask-rel 格式：x,y,w,h（0~1 比例，相对于缩放后的画布）');
        o.masksRel.push({ x, y, w, h });
        break;
      }
      case '--no-key': o.noKey = true; break;
      case '--no-despill': o.despill = false; break;
      case '--force': o.force = true; break;
      case '--dry': o.dry = true; break;
      case '--ignore-encoder-check': o.ignoreEncoderCheck = true; break;
      case '--no-ffmpeg-fallback': o.noFfmpegFallback = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`未知参数：${a}`);
    }
  }
  return o;
}

const HELP = `keyscreen.mjs —— 绿幕视频 → 透明 VP9-alpha webm（640×360）

用法：
  node tools/keyscreen.mjs [选项]

选项：
  --in <目录>          输入目录（默认 out/raw；也接受单个文件所在目录）
  --out <目录>         输出目录（默认 out/webm）
  --only a,b           只处理这几个动作名（与 config.jsonc 逐字一致）
  --force              已存在的 webm 也重转
  --dry                只打印将要做什么，不动文件
  --similarity <0-1>   colorkey 相似度（默认 0.3；调大抠得更狠，会吃头发）
  --blend <0-1>        边缘羽化（默认 0.1）
  --key <颜色>         绿幕色值（默认 0x00FF00）
  --mask x,y,w,h       用绿块盖掉一块**原图**区域（水印；可写多次）
  --mask-rel x,y,w,h   同上，但用 0~1 比例（相对于缩放后的画布）
  --no-key             输入本身已带 alpha，只做转码
  --no-despill         关掉去绿边（默认开）
  --width/--height     输出尺寸（默认 640×360，插件素材规格，别乱改）
  --ignore-encoder-check  明知 ffmpeg 没有 libvpx-vp9 也硬跑（只会得到不透明的 webm）
  --no-ffmpeg-fallback    首选 ffmpeg 编不出 VP9-alpha 时不要自动改用兜底候选
  --help, -h           显示本帮助

说明：编码参数固定为 -c:v libvpx-vp9 -pix_fmt yuva420p -crf 10 -b:v 0
      -auto-alt-ref 0 -row-mt 1 -deadline good -cpu-used 4 -an（-auto-alt-ref 0 不能省，
      开了会把 alpha 吃掉）。转完会对每个文件解一帧做 alpha 复检：alpha 里必须同时出现 0 和 255。
ffmpeg 定位顺序：$env:FFMPEG → PATH → 已知位置 →（首选体检不合格时）本机兜底候选。`;

// ============================================================================
// 五、主流程
// ============================================================================
function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }
  allowFallback = !o.noFfmpegFallback;

  const ffmpeg = findFfmpeg();
  console.log(`ffmpeg : ${ffmpeg}（${findFfmpegSource()}）`);

  // —— 能力体检：不合格就别浪费时间，直接给解决办法 ——
  const cap = ffmpegCapabilities();
  if (!cap.ok && !o.ignoreEncoderCheck) {
    console.error('\n' + capabilityReport(cap));
    process.exitCode = 1;
    return;
  }
  if (!cap.encVp9) {
    console.warn('⚠ 当前 ffmpeg 没有 libvpx-vp9 编码器，产出的 webm 不会有 alpha（--ignore-encoder-check 已生效）');
  }
  if (!cap.decVp9) {
    console.warn('⚠ 当前 ffmpeg 没有 libvpx-vp9 解码器：webm 的 alpha 探测可能不准（会退化成默认解码器）');
  }

  const inDir = path.resolve(o.in);
  const outDir = path.resolve(o.out);
  if (!fs.existsSync(inDir)) throw new Error(`输入目录不存在：${inDir}\n（先跑 node tools/gen-api.mjs --all --go 生成 out/raw，或把素材拷进去）`);
  fs.mkdirSync(outDir, { recursive: true });

  const known = configActionNames();
  const knownSet = new Set(known);

  let files = fs.readdirSync(inDir)
    .filter((f) => IN_EXT.has(path.extname(f).toLowerCase()))
    .map((f) => path.join(inDir, f))
    .sort();
  if (o.only) {
    const want = new Set(o.only);
    const before = files.length;
    files = files.filter((f) => want.has(path.basename(f, path.extname(f))));
    for (const n of o.only) {
      if (!files.some((f) => path.basename(f, path.extname(f)) === n)) console.warn(`⚠ --only 里的「${n}」在输入目录里没有对应文件`);
    }
    if (!files.length && before) console.warn('（--only 之后一个都不剩）');
  }

  if (!files.length) {
    console.log(`\n没有可处理的视频。把绿幕视频（.mp4/.mov/.webm）放进：${inDir}`);
    console.log('支持扩展名：' + [...IN_EXT].join(' / '));
    return;
  }

  // —— 名字闸门（只告警不阻断）：对不上 = 装了也不会被播放 ——
  const badNames = files.map((f) => path.basename(f, path.extname(f))).filter((n) => !knownSet.has(n));
  if (badNames.length) {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║ ⚠ 这些文件名不在 assets/config.jsonc 的 animations 段里（逐字比对）： ║');
    for (const n of badNames) console.log(`║   · ${n}`);
    console.log('║   转出来也**不会被播放**（客户端按配置名找文件，差一个字就是 404）。 ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝');
    console.log('配置里的合法名字：' + known.join(' / '));
    console.log('');
  }

  console.log(`输入   : ${inDir}（${files.length} 个）`);
  console.log(`输出   : ${outDir}  ${o.width}×${o.height}`);
  console.log(`抠像   : ${o.noKey ? '关闭（输入已带 alpha）' : `colorkey ${o.key} sim=${o.similarity} blend=${o.blend}${o.despill ? ' + despill' : ''}`}`);
  if (o.masks.length) console.log(`盖水印 : ${o.masks.map((m) => `${m.w}x${m.h}@${m.x},${m.y}`).join('  ')}`);
  if (o.masksRel.length) console.log(`盖水印 : ${o.masksRel.map((m) => `${m.w}x${m.h}@${m.x},${m.y}（比例）`).join('  ')}`);
  console.log('');

  const results = [];
  for (const file of files) {
    const name = path.basename(file, path.extname(file));
    const target = path.join(outDir, `${name}.webm`);
    const row = { name, status: '', note: '' };

    if (fs.existsSync(target) && !o.force) {
      row.status = 'skip';
      row.note = '已存在（--force 可重转）';
      results.push(row);
      console.log(`- ${name}：已存在，跳过（--force 可重做）`);
      continue;
    }

    // 输入本来就带 alpha 就别再抠一次（否则会把透明区当绿幕，越抠越糟）
    const srcAlpha = probeAlphaMode(file);
    const alreadyAlpha = srcAlpha === 1;
    const doKey = !o.noKey && !alreadyAlpha;

    const vf = [];
    // 盖水印必须在缩放之前：--mask 的坐标是**原图**像素
    for (const m of o.masks) vf.push(`drawbox=x=${m.x}:y=${m.y}:w=${m.w}:h=${m.h}:color=0x00FF00@1:t=fill`);
    // 统一成插件素材规格：640×360。用 pad（补绿边）而不是 crop：裁会把人物裁掉，
    // 补出来的绿边等下正好被抠成透明。
    vf.push(`scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease:flags=lanczos`);
    vf.push(`pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2:color=0x00FF00`);
    // 比例水印：坐标相对于已经补好的画布
    for (const m of o.masksRel) {
      vf.push(`drawbox=x=${Math.round(m.x * o.width)}:y=${Math.round(m.y * o.height)}:w=${Math.round(m.w * o.width)}:h=${Math.round(m.h * o.height)}:color=0x00FF00@1:t=fill`);
    }
    if (doKey) {
      vf.push(`colorkey=${o.key}:${o.similarity}:${o.blend}`);
      if (o.despill) vf.push('despill=type=green');
    }
    vf.push('format=yuva420p');

    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    // 输入是 webm 时显式指定 libvpx 解码器，否则 alpha 会被静默丢掉
    args.push(...decodeArgs(file));
    args.push('-i', file);
    args.push(
      '-vf', vf.join(','),
      '-c:v', 'libvpx-vp9',
      '-pix_fmt', 'yuva420p',
      '-crf', String(o.crf),
      '-b:v', '0',
      '-auto-alt-ref', '0',   // 必须 0：开 alt-ref 会把 alpha 吃掉
      '-row-mt', '1',
      '-deadline', 'good',
      '-cpu-used', String(o.cpuUsed),
      '-an',
      target,
    );

    if (o.dry) {
      row.status = 'dry';
      row.note = '（--dry，未执行）';
      results.push(row);
      console.log(`- ${name}：将转码 → ${target}`);
      console.log(`    vf: ${vf.join(',')}`);
      continue;
    }

    process.stdout.write(`- ${name}：转码中… `);
    let enc;
    try {
      enc = runFfmpeg(args, { quiet: true });
    } catch (e) {
      row.status = 'FAIL';
      row.note = `ffmpeg 启动失败：${e.message}`;
      results.push(row);
      console.log('失败');
      continue;
    }
    if (enc.status !== 0 || !fs.existsSync(target)) {
      row.status = 'FAIL';
      const tail = enc.log.split('\n').filter(Boolean).slice(-3).join(' | ');
      row.note = `ffmpeg 退出码 ${enc.status}：${tail}`;
      results.push(row);
      console.log('失败');
      console.log('    ' + enc.log.split('\n').filter(Boolean).slice(-4).join('\n    '));
      continue;
    }

    // —— 转完立刻复检：尺寸/编码/alpha 元数据 + 实测一帧的 alpha（必须有 0 和 255） ——
    const info = probeInfo(target);
    const mode = probeAlphaMode(target);
    const px = probeAlphaPixels(target);
    const fr = probeFringe(target);
    const sizeOk = info.w === o.width && info.h === o.height;
    const alphaOk = Boolean(px && px.has0 && px.has255);
    const ok = sizeOk && (mode === 1 || alphaOk);

    row.status = ok ? 'ok' : (!sizeOk ? 'BAD-SIZE' : 'NO-ALPHA');
    const alphaTxt = px
      ? `alpha min=${px.min} max=${px.max}（含 0：${px.has0 ? '是' : '否'}；含 255：${px.has255 ? '是' : '否'}）`
      : 'alpha 解帧失败（--ignore-encoder-check 的构建通常如此）';
    let detail = `${info.codec || '?'} ${info.w}x${info.h} ${info.sec ? info.sec.toFixed(1) + 's' : ''} ALPHA_MODE=${mode ?? '未读到'} ${alphaTxt}`;
    if (fr) {
      const pct = (fr.ratio * 100).toFixed(2);
      detail += ` 绿边${pct}%`;
      if (fr.ratio > 0.005) { row.fringe = true; detail += '（偏高）'; }
    }
    row.note = detail;
    row.dims = `${info.w}x${info.h}`;
    row.alpha = alphaOk;
    results.push(row);
    console.log(ok ? `完成（${detail}）` : `完成但复检没过（${detail}）`);
  }

  // ------------------------------------------------------------- 汇总
  const ok = results.filter((r) => r.status === 'ok').length;
  const bad = results.filter((r) => ['FAIL', 'NO-ALPHA', 'BAD-SIZE'].includes(r.status)).length;
  const skip = results.filter((r) => r.status === 'skip').length;
  const fringe = results.filter((r) => r.fringe).length;
  console.log(`\n汇总：成功 ${ok} · 跳过 ${skip} · 有问题 ${bad} · 共 ${results.length}`);
  if (fringe) {
    console.log(`\n⚠ ${fringe} 个文件绿边偏高（人物边缘发绿）。把 --similarity 从 0.30 调到 0.22 左右重转，或加 --blend 0.15。`);
    for (const r of results.filter((x) => x.fringe)) console.log(`  ${r.name}`);
  }
  if (bad) {
    console.log('\n有问题的：');
    for (const r of results.filter((x) => ['FAIL', 'NO-ALPHA', 'BAD-SIZE'].includes(x.status))) {
      console.log(`  [${r.status}] ${r.name} —— ${r.note}`);
    }
    if (results.some((r) => r.status === 'NO-ALPHA') && !cap.decVp9) {
      console.log('  注意：当前 ffmpeg 没有 libvpx-vp9 解码器，alpha 复检结果本身可能不可信 —— 先换一个完整版 ffmpeg。');
    }
  }

  // 对着配置里的 10 个名字报缺口，省得自己数
  const have = new Set(
    fs.readdirSync(outDir).filter((f) => f.endsWith('.webm')).map((f) => f.slice(0, -5)),
  );
  const missing = known.filter((n) => !have.has(n));
  console.log(`\n进度：${known.filter((n) => have.has(n)).length} / ${known.length}${missing.length ? `（还差 ${missing.length} 段）` : '（齐了）'}`);
  if (missing.length && missing.length <= 12) console.log('还差：' + missing.join(' / '));
  console.log('\n转完装包：node tools/pipeline.mjs       （或只跑后处理：node tools/pipeline.mjs --verify 先看现状）');

  process.exitCode = bad ? 1 : 0;
}

// 直接跑才执行 main()；被 import（gen-api.mjs / pipeline.mjs 复用工具函数）时不执行
const isMain =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try { main(); } catch (e) { console.error(`✗ ${e.message}`); process.exitCode = 1; }
}
