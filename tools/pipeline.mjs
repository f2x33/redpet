// ============================================================================
// pipeline.mjs —— 红队桌宠素材流水线（增量编排，一步到位，每步都能单独跳过）
// ============================================================================
// 把三件事串成一条链：
//   ① 生成（可选，要 --gen）  调 gen-api.mjs —— 花钱的那一步，**必须再给 --go**
//   ② 抠像                    调 keyscreen.mjs —— 绿幕 → VP9-alpha webm（640×360）
//   ③ 装进插件                把 out/webm/*.webm 拷到
//                             $DSH_HOME\dsh-redteam-pet\main-animation\webm\
//                             （用户素材目录，同名**覆盖**包内 assets/webm 的素材）
//   ④ 体检                    文件名 / 编码 / 尺寸 / alpha / 缺哪段 → 打一张对照表
//
// 用法：
//   node tools/pipeline.mjs                    # 默认：只做本地后处理（②③④），**完全不碰 API**
//   node tools/pipeline.mjs --gen --go         # 先跑 gen-api（--go 透传），再后处理
//   node tools/pipeline.mjs --gen              # 只看 gen-api 的空跑计划（不发请求），再后处理
//   node tools/pipeline.mjs --verify           # 只体检
//   node tools/pipeline.mjs --limit 2 --gen --go   # 只生成 2 段 + 后处理
//   node tools/pipeline.mjs --only 写代码,东张西望 --gen --go
//   node tools/pipeline.mjs --force            # 抠像和装包都强制重做
//   node tools/pipeline.mjs --skip-install     # 只抠像不装包（想先自己看一眼 out/webm）
//
// 设计成**增量**：每步只处理新增/变化的素材，所以可以分几天跑，重跑不会重复劳动，
// 更不会重复花钱（生成那一步靠 gen-api 的 --all/--limit 闸门 + 断点续跑）。
//
// 注意：本脚本**只**往用户素材目录写文件，**不会**改包里的 assets/config.jsonc
//（改配置 = 改这只宠物的出厂设置，那是另一件事，得手工做）。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  configActionNames,
  findFfmpeg,
  findFfmpegSource,
  ffmpegCapabilities,
  probeInfo,
  probeAlphaMode,
  probeAlphaPixels,
  OUT_WIDTH,
  OUT_HEIGHT,
  ROOT,
} from './keyscreen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const OUT_RAW = path.join(ROOT, 'out', 'raw');
const OUT_WEBM = path.join(ROOT, 'out', 'webm');
const PKG_WEBM = path.join(ROOT, 'assets', 'webm');            // 包内素材（只读参考）
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const USER_WEBM = path.join(DSH_HOME, 'dsh-redteam-pet', 'main-animation', 'webm'); // 用户素材目录

const HELP = `pipeline.mjs —— 红队桌宠素材流水线（生成 → 抠像 → 装进插件 → 体检）

用法：
  node tools/pipeline.mjs                 默认：只做本地后处理（抠像 → 装包 → 体检），不碰 API
  node tools/pipeline.mjs --gen --go      先跑 gen-api（--go 透传给 gen-api），再后处理
  node tools/pipeline.mjs --verify        只体检（打对照表），什么都不改

选项：
  --gen               加一步：调 gen-api.mjs 生成素材（**不加 --go 就等于空跑，不发请求**）
  --go                透传给 gen-api：真正发请求（不加就是空跑）
  --limit N           透传：只生成前 N 段
  --only a,b          透传：只处理这几段（名字与 assets/config.jsonc 逐字一致）
  --force             抠像和装包都强制重做（默认增量：已存在且未变的跳过）
  --similarity <0-1>  透传给 keyscreen 的 colorkey 相似度
  --mask x,y,w,h      透传给 keyscreen：用绿块盖水印（原图像素，可写多次）
  --mask-rel x,y,w,h  同上，但用 0~1 比例
  --skip-gen          跳过生成步骤
  --skip-keyscreen    跳过抠像步骤
  --skip-install      跳过装进插件步骤
  --skip-verify       跳过体检步骤
  --help, -h          显示本帮助

装包目标：$DSH_HOME\\dsh-redteam-pet\\main-animation\\webm\\（$DSH_HOME 默认 %USERPROFILE%\\.dsh）
  同名文件覆盖包内 assets/webm 里的素材，所以以后换素材只要重跑本脚本，不用动插件包。
  本脚本**不会**改 assets/config.jsonc。`;

function parseArgs(argv) {
  const o = {
    gen: false,
    go: false,
    limit: 0,
    only: null,
    force: false,
    verify: false,
    similarity: null,
    masks: [],
    masksRel: [],
    skipGen: false,
    skipKeyscreen: false,
    skipInstall: false,
    skipVerify: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺参数值`);
      return v;
    };
    switch (a) {
      case '--gen': o.gen = true; break;
      case '--go': o.go = true; break;
      case '--limit': o.limit = Number(val()); break;
      case '--only': o.only = val().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--force': o.force = true; break;
      case '--verify': o.verify = true; break;
      case '--similarity': o.similarity = Number(val()); break;
      case '--mask': {
        const [x, y, w, h] = val().split(',').map(Number);
        if ([x, y, w, h].some((n) => !Number.isFinite(n))) throw new Error('--mask 格式：x,y,w,h（原图像素）');
        o.masks.push(`${x},${y},${w},${h}`);
        break;
      }
      case '--mask-rel': {
        const [x, y, w, h] = val().split(',').map(Number);
        if ([x, y, w, h].some((n) => !Number.isFinite(n))) throw new Error('--mask-rel 格式：x,y,w,h（0~1 比例）');
        o.masksRel.push(`${x},${y},${w},${h}`);
        break;
      }
      case '--skip-gen': o.skipGen = true; break;
      case '--skip-keyscreen': o.skipKeyscreen = true; break;
      case '--skip-install': o.skipInstall = true; break;
      case '--skip-verify': o.skipVerify = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`未知参数：${a}`);
    }
  }
  // --verify = 只体检：把其它步骤全关掉
  if (o.verify) { o.skipGen = true; o.skipKeyscreen = true; o.skipInstall = true; o.skipVerify = false; }
  return o;
}

/** 跑一个同目录下的脚本（继承 stdio，保证子脚本的彩色/进度输出原样透出来）。 */
function run(scriptRel, args) {
  console.log(`   $ node tools/${scriptRel} ${args.join(' ')}`.trimEnd());
  const r = spawnSync(process.execPath, [path.join(HERE, scriptRel), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.error) {
    console.error(`   ✗ 起不来：${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

// ============================================================================
// ① 生成（可选）—— 钱都在这一步
// ============================================================================
function stepGen(o) {
  console.log('▶ 步骤 1 · 生成素材（gen-api.mjs）');
  if (!o.go) {
    console.log('   注意：没给 --go，gen-api 只会空跑打印计划与花费估算，**不会发任何请求**。');
    console.log('   真要生成：node tools/pipeline.mjs --gen --go --all');
  }
  const args = [];
  if (o.go) args.push('--go');
  if (o.limit > 0) args.push('--limit', String(o.limit));
  if (o.only) args.push('--only', o.only.join(','));
  if (o.force) args.push('--force');
  const code = run('gen-api.mjs', args);
  if (code !== 0) {
    console.error('\n   ✗ gen-api 返回非零（' + code + '），流水线中止。');
    console.error('     （gen-api 失败时不会自动重发，避免重复扣费；修好原因再重跑本命令即可增量补齐。）');
    return code;
  }
  return 0;
}

// ============================================================================
// ② 抠像
// ============================================================================
function stepKeyscreen(o) {
  console.log('▶ 步骤 2 · 抠像转码（keyscreen.mjs）');
  if (!fs.existsSync(OUT_RAW)) {
    console.log(`   （${path.relative(ROOT, OUT_RAW)} 不存在 —— 没有原始视频可抠，跳过）`);
    return 0;
  }
  const raws = fs.readdirSync(OUT_RAW).filter((f) => /\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(f));
  if (!raws.length) {
    console.log(`   （${path.relative(ROOT, OUT_RAW)} 里没有视频 —— 跳过。先：node tools/gen-api.mjs --limit 2 --go）`);
    return 0;
  }
  const args = ['--in', OUT_RAW, '--out', OUT_WEBM];
  if (o.force) args.push('--force');
  if (o.only) args.push('--only', o.only.join(','));
  if (o.similarity !== null) args.push('--similarity', String(o.similarity));
  for (const m of o.masks) args.push('--mask', m);
  for (const m of o.masksRel) args.push('--mask-rel', m);
  const code = run('keyscreen.mjs', args);
  if (code !== 0) {
    console.error('\n   ✗ keyscreen 返回非零（' + code + '），后续步骤跳过。');
    console.error('     （最常见原因：ffmpeg 没有 libvpx-vp9；它会在上面把候选体检表打出来。）');
    return code;
  }
  return 0;
}

// ============================================================================
// ③ 装进插件（拷到用户素材目录，同名覆盖包内素材）
// ============================================================================
function stepInstall(o) {
  console.log('▶ 步骤 3 · 装进插件（拷到用户素材目录）');
  console.log(`   目标：${USER_WEBM}`);
  if (!fs.existsSync(OUT_WEBM)) {
    console.log(`   （${path.relative(ROOT, OUT_WEBM)} 不存在 —— 没有 webm 可装，跳过）`);
    return 0;
  }
  const files = fs.readdirSync(OUT_WEBM).filter((f) => f.toLowerCase().endsWith('.webm'));
  if (!files.length) {
    console.log('   （out/webm 里没有 .webm —— 跳过）');
    return 0;
  }
  fs.mkdirSync(USER_WEBM, { recursive: true });
  const known = new Set(configActionNames());

  let copied = 0, unchanged = 0;
  for (const f of files.sort()) {
    const src = path.join(OUT_WEBM, f);
    const dst = path.join(USER_WEBM, f);
    const name = f.slice(0, -5);
    const s = fs.statSync(src);
    if (fs.existsSync(dst) && !o.force) {
      const d = fs.statSync(dst);
      if (d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 2000) {
        unchanged++;
        console.log(`   = ${f}：没变化，跳过`);
        continue;
      }
    }
    fs.copyFileSync(src, dst);
    fs.utimesSync(dst, s.atime, s.mtime); // 让 mtime 跟着源走，下次判「没变化」才准
    copied++;
    const overwrite = fs.existsSync(path.join(PKG_WEBM, f)) ? '（覆盖同名包内素材）' : '（包内没有，纯新增）';
    const warn = known.has(name) ? '' : '   ⚠ 名字不在 config.jsonc 的 animations 段里，装了也不会被播放';
    console.log(`   → ${f}（${(s.size / 1024).toFixed(0)} KB）${overwrite}${warn}`);
  }
  console.log(`   装包完成：复制/覆盖 ${copied} 个，未变化跳过 ${unchanged} 个，共 ${files.length} 个。`);
  console.log('   （只写用户素材目录，没动插件包里的 assets/）');
  return 0;
}

// ============================================================================
// ④ 体检
// ============================================================================
/** 中文算 2 列宽，不然表格会错位。 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return w;
}
function padEndDisp(s, width) {
  const pad = width - dispWidth(s);
  return String(s) + ' '.repeat(pad > 0 ? pad : 0);
}

function listWebmNames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.webm')).map((f) => f.slice(0, -5)).sort();
}

function stepVerify() {
  console.log('▶ 步骤 4 · 体检');
  const known = configActionNames();
  const outNames = listWebmNames(OUT_WEBM);
  const userNames = listWebmNames(USER_WEBM);
  const pkgNames = listWebmNames(PKG_WEBM);

  console.log(`   配置里的合法动作名：${known.length} 个（来自 assets/config.jsonc 的 animations 段）`);
  console.log(`   ${path.relative(ROOT, OUT_WEBM)}：${outNames.length} 个`);
  console.log(`   用户目录 ${USER_WEBM}：${userNames.length} 个`);
  console.log(`   包内 assets/webm：${pkgNames.length} 个`);

  // —— 名字闸门：不在配置里的文件名 = 装了也不会被播放 ——
  const illegal = [...new Set([...outNames, ...userNames])].filter((n) => !known.includes(n));
  if (illegal.length) {
    console.log('');
    console.log('   ⚠ 这些文件名不在配置的 10 个名字里（差一个字 = 客户端 404，右键点了没反应）：');
    for (const n of illegal) console.log(`      · ${n}`);
    console.log('      （要么改名，要么把它们加进 config.jsonc 对应的池子里 —— 本脚本不会替你改配置。）');
  }

  // —— 逐个检查：优先看用户目录（它覆盖包内），没有再退回包内 ——
  let ffOk = true;
  let ffNote = '';
  try {
    const ff = findFfmpeg();
    const cap = ffmpegCapabilities();
    console.log(`   ffmpeg：${ff}（${findFfmpegSource()}）`);
    if (!cap.decVp9) {
      ffOk = false;
      ffNote = '当前 ffmpeg 没有 libvpx-vp9 解码器，读 webm 的 alpha 可能不准（结果仅供参考）';
    }
  } catch (e) {
    ffOk = false;
    ffNote = `找不到 ffmpeg，只能做「文件在不在」的检查，编码/尺寸/alpha 一律跳过（${e.message.split('\n')[0]}）`;
  }
  if (!ffOk) console.log(`   ⚠ ${ffNote}`);
  console.log('');

  const rows = [];
  let badMedia = 0, missing = 0;
  console.log('   体检中（每个 webm 解一帧看 alpha，稍等）…');
  for (const name of known) {
    const inOut = outNames.includes(name);
    const inUser = userNames.includes(name);
    const inPkg = pkgNames.includes(name);
    const effective = inUser ? path.join(USER_WEBM, `${name}.webm`) : inPkg ? path.join(PKG_WEBM, `${name}.webm`) : null;
    const source = inUser ? '用户目录' : inPkg ? '包内' : '**缺失**';
    const row = {
      name,
      inOut: inOut ? '✓' : '·',
      inUser: inUser ? '✓' : '·',
      inPkg: inPkg ? '✓' : '·',
      source,
      dims: '-',
      alpha: '-',
      note: '',
    };
    if (!effective) {
      missing++;
      row.note = '两边都没有 → 这个名字播出时会拿不到素材';
      rows.push(row);
      continue;
    }
    if (!ffOk) {
      row.note = '未做媒体检查';
      rows.push(row);
      continue;
    }
    try {
      const info = probeInfo(effective);
      const mode = probeAlphaMode(effective);
      const px = probeAlphaPixels(effective);
      row.dims = info.w && info.h ? `${info.w}×${info.h}` : '?';
      row.alpha = px ? `${px.has0 ? '0' : '×'}${px.has255 ? '/255' : '/×'}${mode === 1 ? ' mode=1' : ''}` : '?';
      const problems = [];
      if (info.codec !== 'vp9') problems.push(`编码是 ${info.codec || '?'}，不是 VP9`);
      if (info.w !== OUT_WIDTH || info.h !== OUT_HEIGHT) problems.push(`尺寸是 ${row.dims}，不是 ${OUT_WIDTH}×${OUT_HEIGHT}`);
      const alphaOk = mode === 1 || (px && px.max > 0 && px.min < 250);
      if (!alphaOk) problems.push('没检测到 alpha');
      if (px && !(px.has0 && px.has255)) problems.push(`alpha 里没有同时出现 0 和 255（min=${px.min} max=${px.max}）`);
      if (problems.length) {
        badMedia++;
        row.note = `${source === '包内' ? '包内素材也有问题：' : ''}${problems.join('；')}`;
      } else {
        row.note = source === '包内' ? '（用户目录还没有，先用包内素材顶上）' : 'OK';
      }
    } catch (e) {
      badMedia++;
      row.note = `探测失败：${e.message}`;
    }
    rows.push(row);
  }

  // —— 对照表 ——
  console.log('');
  const wName = Math.max(12, ...known.map((n) => dispWidth(n))) + 2;
  console.log(
    '   ' + padEndDisp('动作名', wName) + padEndDisp('out/webm', 10) + padEndDisp('用户目录', 10) +
    padEndDisp('包内', 6) + padEndDisp('生效', 10) + padEndDisp('尺寸', 10) + padEndDisp('alpha', 14) + '说明',
  );
  console.log('   ' + '─'.repeat(wName + 10 + 10 + 6 + 10 + 10 + 14 + 20));
  for (const r of rows) {
    console.log(
      '   ' + padEndDisp(r.name, wName) + padEndDisp(r.inOut, 10) + padEndDisp(r.inUser, 10) +
      padEndDisp(r.inPkg, 6) + padEndDisp(r.source, 10) + padEndDisp(r.dims, 10) + padEndDisp(r.alpha, 14) + r.note,
    );
  }
  console.log('');
  console.log(`   合计：配置 ${known.length} 个 · 用户目录已有 ${userNames.filter((n) => known.includes(n)).length} 个 · ` +
    `缺失 ${missing} 个 · 媒体检查有问题 ${badMedia} 个` + (illegal.length ? ` · 名字不合法 ${illegal.length} 个` : ''));
  if (missing) {
    console.log(`   缺的：${rows.filter((r) => r.source === '**缺失**').map((r) => r.name).join(' / ')}`);
    console.log('   （补齐：node tools/gen-api.mjs --all --go → node tools/pipeline.mjs）');
  }
  const overrideOk = userNames.filter((n) => known.includes(n)).length;
  if (overrideOk) console.log(`   用户目录里 ${overrideOk} 个素材会覆盖包内同名素材——这就是「换素材不用改包」。`);

  return missing || badMedia || illegal.length ? 1 : 0;
}

// ============================================================================
// 主流程
// ============================================================================
function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }

  console.log('════════ 红队桌宠素材流水线 ════════');
  console.log(`包目录   : ${ROOT}`);
  console.log(`用户目录 : ${USER_WEBM}（$DSH_HOME=${DSH_HOME}）`);
  console.log(`本次步骤 : ` + [
    o.skipGen ? null : o.gen ? '生成' : '生成(未请求)',
    o.skipKeyscreen ? null : '抠像',
    o.skipInstall ? null : '装包',
    o.skipVerify ? null : '体检',
  ].filter(Boolean).join(' → '));
  if (o.verify) console.log('模式     : --verify（只体检，什么都不改）');
  if (o.gen && o.go) console.log('⚠ 注意：--gen --go 会真的调用方舟 API 并产生费用（gen-api 自己的 --all/--limit 闸门仍然生效）。');
  console.log('');

  let n = 0;
  if (!o.skipGen) {
    n++;
    if (!o.gen) {
      console.log('▶ 步骤 1 · 生成素材（gen-api.mjs）');
      console.log('   跳过：没给 --gen（默认只做本地后处理，不碰 API）。');
      console.log('   要生成：node tools/pipeline.mjs --gen --go --all');
      console.log('');
    } else {
      const code = stepGen(o);
      console.log('');
      if (code !== 0) { process.exitCode = code; return; }
    }
  }
  if (!o.skipKeyscreen) {
    n++;
    const code = stepKeyscreen(o);
    console.log('');
    if (code !== 0) { process.exitCode = code; return; }
  }
  if (!o.skipInstall) {
    n++;
    const code = stepInstall(o);
    console.log('');
    if (code !== 0) { process.exitCode = code; return; }
  }
  if (!o.skipVerify) {
    n++;
    const code = stepVerify();
    console.log('');
    process.exitCode = code;
  }

  console.log('════════ 流水线完成 ════════');
  if (!o.skipInstall) {
    console.log('下一步：刷新 DSH 页面（Ctrl+F5），右键宠物看菜单验收。');
    console.log('某段要返工：删掉 out/raw/对应.mp4（想省钱）或直接加 --force 重跑本脚本。');
  }
  if (process.exitCode) {
    console.log('本次有检查项没过（见上面的对照表），退出码非 0。');
  }
}

const isMain =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try { main(); } catch (e) { console.error(`\n✗ ${e.message}`); process.exitCode = 1; }
}
