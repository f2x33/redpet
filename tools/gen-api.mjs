// [audit-fix v2 · 2026-10-05] 补丁状态 —— 诚实清单（**别只看这一行就以为全修了**）
//   已落盘（代码层真的生效）：
//     · CONCURRENCY 默认值 3 → 1
//     · parseArgs：分辨率白名单 / --help 预扫描 / --limit 正整数校验 / --schema 记录显式指定 /
//       --force-still / 并发兜底值改 1
//     · arkFetch：所有 fetch 带 AbortSignal.timeout（幂等 60s / 非幂等 300s）；错误对象带 status
//     · arkError：错误对象带 status（P1 靠它判「确定 4xx」还是「状态不明确」）
//     · download：素材下载带 300s 超时（超时无状态码 → 不自动重发）
//     · HARD_ABORT + hardAborted()：两个花钱 POST 之前各查一次硬失败标记（P3）
//     · pool：硬失败置位 HARD_ABORT；失败日志改成诚实措辞（只挡派发新段，在飞的会跑完）
//     · planFor：--force 只管视频产物，--force-still 重出静帧并连带重建该段视频（P5）
//     · runProbe：试序尊重 probe 结论（P6）；catch 只对「确定 4xx」回退，
//       网络错误/5xx/401/403/429 一律不再试另一种写法（P1 —— 重发可能重复扣费）
//     · main：--limit ≥ 全部段数时提醒（P7）；probe 空跑补最坏情况估算（P4）
//   只改了 HELP / 注释、代码层**本来就已落盘**、本次无需再动：
//     · 头部【花钱安全】各条（含 ⑤ 并发默认 1 的理由、⑧ 超时理由）
//     · HELP 文本里的 --force-still / --resolution 白名单 / --limit / --concurrency 默认 1
//   ⚠ 本次改动**未能运行 `node --check`**（会话 shell 不可用），语法靠逐块 read 复核：
//     请下一个人拿到文件后先跑一次 `node --check tools/gen-api.mjs` 再执行。
// ============================================================================
// gen-api.mjs —— 用火山方舟(Ark) Bearer API 生成 10 段绿幕视频（红队桌宠素材）
// ============================================================================
// 一条命令把 docs/02 的 10 段提示词变成 out/raw/<动作名>.mp4：
//   每段 = 1 张绿幕静帧（out/_stills/<动作名>.png，图生图）+ 1 段视频（图生视频）。
// 后面接 pipeline.mjs（抠像 → 装进插件 → 体检）。
//
// 【零基础设施】定妆图和静帧都以 base64 data URI 内联传给 API，不需要图床/对象存储。
//   只有一个前置：ARK_API_KEY（图和视频共用同一个 key，Bearer 认证，不需要 HMAC 签名）。
//
// 前置：
//   $env:ARK_API_KEY = "你的key"      # 火山方舟控制台 → API Key
// 依赖：Node 22+（含全局 fetch）。**不需要 npm install 任何东西**。
//
// ---------------------------------------------------------------------------
// 【第一次用务必按这个顺序，别直接跑 10 段】
//   1) node tools/gen-api.mjs                     # 空跑（dry-run）：只打印计划 + 预估花费，不发任何请求
//   2) node tools/gen-api.mjs --probe --go        # 花几分钱验明正身：1 张图 + 1 段 5 秒视频，
//                                                 #   把**原始请求/响应**打出来，结论写进 out/_probe/
//   3) node tools/gen-api.mjs --limit 2 --go      # 真跑 2 段，肉眼验收姿势/绿幕/水印
//   4) node tools/pipeline.mjs                    # 抠像 → 装包 → 体检
//   5) node tools/gen-api.mjs --all --go          # 全量 10 段。**必须显式加 --all**
//
// ---------------------------------------------------------------------------
// 【花钱安全 —— 这一节是本脚本的核心，改动请先读完整段】
//   ① 没有 --go 绝对不发任何 HTTP 请求（--probe 也一样要 --go）。dry-run 只打印计划。
//   ② --all 是硬门槛：没给 --all 又没给 --limit/--only 时只空跑，并打印「要真跑请加 --all 或 --limit N」。
//   ③ 单价是脚本顶部两个显式常量（PRICE_IMAGE_YUAN / PRICE_VIDEO_YUAN_PER_SEC），
//      **占位价，按你自己账号的实际单价改**。dry-run 与每次真跑前都打印：
//        「本次预计 ¥X（图片 N 张 × ¥a + 视频 M 段 × D 秒 × ¥b/秒）」
//      这是**估算、不是账单承诺**：真实计费口径（视频常按 token 计费）以方舟控制台账单为准。
//   ④ 失败绝不自动重发。只有 HTTP 429 / 5xx / 网络错误才做**网络层**重试（上限 HTTP_RETRIES）。
//      模型返回 error、任务状态 failed、内容被审核拒绝 —— 一律立刻停下、打印原始响应、退出码非 0。
//      更严的一点（有意为之）：建任务的 POST 只在 429 上重试。5xx 和网络错误对 POST **不重试**，
//      因为无法区分「服务端没收下」和「收下并计费了、只是回包失败」—— 重发就可能重复扣费。
//      幂等的 GET（轮询）和视频下载正常重试。
//      ⚠ 不换模型重试、不自动重发，理由就一句：**重发 = 重复扣费**。
//   ⑤ 并发默认 1（CONCURRENCY 可调高）。**为什么默认 1**：一段硬失败后，「已经在飞」的段会照常
//      把出图/建任务这两个花钱的 POST 发出去（钱照花）。并发越高，失败瞬间多花的钱越多；
//      默认 1 时最多再多花 0 段。并且每段在**发任何花钱的 POST 之前**都会再查一次硬失败标记，
//      已置位就直接跳过、不发请求。每段开始时打印 [i/N] 动作名 … 阶段。
//      ⚠ 诚实说明：中止只挡得住「派发新段」，已在执行的段会跑完（请求发出去就收不回来了）。
//   ⑥ 断点续跑：产物已存在且没加 --force/--force-still 就跳过（打印「已存在，跳过（--force 可重做）」），
//      静帧在的话还会直接复用（省一次图片调用）。中断后重跑不会重复花钱。
//      --force 只重做**视频**产物（静帧照旧复用）；连静帧一起重买要用 --force-still。
//   ⑦ --probe 把结论写进 out/_probe/probe.json，并写 out/_probe/models.json 供后续使用。
//   ⑧ 所有 fetch 都带超时（AbortSignal.timeout）：轮询/下载等幂等请求 60 秒，两个 POST
//      （出图 / 建视频任务）300 秒。**为什么必须加**：没有超时的话 POST 挂住就会无限等，
//      用户只好 Ctrl-C 重跑 —— 而那次 POST 可能已经被服务端受理并计费，重跑 = 第二笔钱。
//      超时抛出的错没有状态码，走的正是「非幂等 → 不自动重发」那条路径。
//
// ---------------------------------------------------------------------------
// 【模型 ID —— 最容易踩的坑】
//   模型 ID 随官方更新变化，且各账号可见的 ID 不一定相同。脚本里的默认值只是**占位提示**，
//   不保证在你的账号下存在。优先级：环境变量 MODEL_IMAGE/MODEL_VIDEO > out/_probe/models.json
//   > 占位默认。probe 报 model not found / 未开通时，去方舟控制台「开通管理」复制确切 ID：
//     $env:MODEL_IMAGE = "doubao-seedream-XXXX-XXXXXXXX"
//     $env:MODEL_VIDEO = "doubao-seedance-XXXX-XXXXXXXX"
//
// 【视频参数写法（VIDEO_SCHEMA / --schema）—— 两代 schema 的差异集中在一处】
//     flags  ：参数写进**提示词文本**尾部，如 "... --resolution 720p --duration 10 --ratio 16:9
//              --watermark false --camerafixed true"（Seedance 1.x 文档如此）
//     fields ：参数作为**顶层字段**，如 { ratio, duration, resolution, watermark }（较新 schema）
//   优先级：--schema > $env:VIDEO_SCHEMA > out/_probe/models.json 里的结论 > flags。
//   probe 两种都会试（先用首选；被拒了才试另一种，所以通常只花 1 段视频的钱）。
//
// 【接口】
//   图片：POST {ARK_BASE}/images/generations                     （同步返回 b64_json）
//   视频：POST {ARK_BASE}/contents/generations/tasks              （异步，返回 id）
//         GET  {ARK_BASE}/contents/generations/tasks/{id}         （轮询到 succeeded，取 video_url 下载）
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configActionNames } from './keyscreen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ============================================================================
// 【单价】占位价，按你自己账号的实际单价改（方舟控制台 → 计费说明/账单）
// ----------------------------------------------------------------------------
// 这两个数只用来在动手前打印一个量级，**不是账单承诺**：真实计费口径（视频常按 token 计费，
// 与分辨率/时长/帧率都有关）以控制台账单为准。宁可估高，别估低。
// 参考量级：图片约 0.2 元/张；视频按秒计约 0.x 元/秒（10 秒一段 = 数元）。
// ============================================================================
const PRICE_IMAGE_YUAN = 0.20;        // 占位价，按你自己账号的实际单价改
const PRICE_VIDEO_YUAN_PER_SEC = 0.30; // 占位价，按你自己账号的实际单价改

// ----------------------------------------------------------------- 参数 / 配置
const ARK_BASE = process.env.ARK_BASE || 'https://ark.cn-beijing.volces.com/api/v3';
const API_KEY = process.env.ARK_API_KEY || '';
// 默认并发 1：一段硬失败时，已在飞的段还是会照常发花钱的 POST，并发越高失败瞬间越多花钱。
// 想让 10 段跑快点可以用 $env:CONCURRENCY=3 覆盖，但请先看过上面【花钱安全】⑤ 的说明。
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 1) || 1);
/** 视频任务轮询上限。单段通常 1~5 分钟；超过就是卡住了，不该傻等。 */
const VIDEO_TIMEOUT_MS = Number(process.env.VIDEO_TIMEOUT_MS || 20 * 60 * 1000);
/** HTTP 重试次数（只用于 429 / 5xx / 幂等请求的网络错误） */
const HTTP_RETRIES = Math.max(1, Number(process.env.HTTP_RETRIES || 3) || 3);
/** 出图尺寸（图生图接口的 size 字段）。 */
const IMAGE_SIZE = process.env.IMAGE_SIZE || '2K';
/** 视频画幅。固定 16:9：keyscreen.mjs 会把素材统一成 640×360（16:9），别改。 */
const RATIO = '16:9';

/**
 * 硬失败标记（P3）。第一段硬失败时置位，之后**每一段在发任何花钱的 POST 之前**都要查它。
 * 为什么不直接用 pool 里的 abort：那个只有 pool 内部看得见，而花钱的地方在 worker 里。
 */
let HARD_ABORT = null;

const DOCS_FILE = path.join(ROOT, 'docs', '02-10段动作提示词.md');
const CONFIG_FILE = path.join(ROOT, 'assets', 'config.jsonc');
const REF_IMAGE = process.env.REF_IMAGE || path.join(ROOT, 'out', '定妆图.png');
const OUT_RAW = path.join(ROOT, 'out', 'raw');
const OUT_STILLS = path.join(ROOT, 'out', '_stills');
const PROBE_DIR = path.join(ROOT, 'out', '_probe');
const MODELS_JSON = path.join(PROBE_DIR, 'models.json');
const PROBE_JSON = path.join(PROBE_DIR, 'probe.json');

/** 模型 ID：环境变量 > out/_probe/models.json > 占位默认（未验证）。 */
function loadModels() {
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(MODELS_JSON, 'utf8'));
  } catch {
    /* 没有就算了 */
  }
  const viaEnv = Boolean(process.env.MODEL_IMAGE || process.env.MODEL_VIDEO);
  return {
    image: process.env.MODEL_IMAGE || fromFile.image || 'doubao-seedream-4-0-250828',
    video: process.env.MODEL_VIDEO || fromFile.video || 'doubao-seedance-1-0-pro-250528',
    schema: fromFile.schema || null,
    source: viaEnv
      ? '环境变量 MODEL_IMAGE / MODEL_VIDEO'
      : (fromFile.image || fromFile.video)
        ? 'out/_probe/models.json（probe 的结论）'
        : '脚本内占位默认（**未验证**，probe 会替你确认）',
  };
}

const HELP = `gen-api.mjs —— 用火山方舟(Ark) API 把 docs/02 的 10 段提示词生成 out/raw/<动作名>.mp4

【默认是空跑】不加 --go 一个请求都不发，只打印计划和预估花费。

用法：
  node tools/gen-api.mjs                        空跑：看计划 + 花费估算
  node tools/gen-api.mjs --probe --go           只发 1 张图 + 1 段 5 秒视频，打印原始请求/响应
  node tools/gen-api.mjs --limit 2 --go         只做前 2 段
  node tools/gen-api.mjs --only 写代码,东张西望 --go
  node tools/gen-api.mjs --all --go             全量 10 段（**必须显式加 --all**）
  node tools/gen-api.mjs --skip-image --go      跳过图生图，直接用定妆图当每段视频首帧（省 10 次图片调用）
  node tools/gen-api.mjs --duration 5 --go      覆盖视频时长（省钱）
  node tools/gen-api.mjs --force --go           已存在的**视频**也重做（静帧照旧复用）
  node tools/gen-api.mjs --force-still --go     静帧也重做（重新出图；该段视频随之重建）

选项：
  --go                 真正开始发请求（不加永远不发）
  --probe              只验通路：模型 ID / 两种 schema / base64 首帧，结论写 out/_probe/
  --limit N            只做前 N 段（必须是正整数；N 等于全部段数时等价于 --all，会有提醒）
  --only a,b           只做这几段（名字必须与 assets/config.jsonc 逐字一致）
  --all                全量。没给 --all 又没给 --limit/--only 时只空跑
  --skip-image         跳过图生图，用定妆图当每段首帧
  --duration N         视频时长秒数（默认 $env:VIDEO_DURATION 或 10）
  --resolution R       视频分辨率，只能是 480p / 720p / 1080p（默认 $env:VIDEO_RESOLUTION 或 720p）
  --schema flags|fields  视频参数写法（默认 $env:VIDEO_SCHEMA 或 probe 结论或 flags）
  --concurrency N      并发（默认 $env:CONCURRENCY 或 1；**调高会在失败时多花钱**，慎用）
  --image-size S       出图尺寸（默认 $env:IMAGE_SIZE 或 2K）
  --ref <文件>         定妆图（默认 out/定妆图.png，或 $env:REF_IMAGE）
  --docs <文件>        提示词包（默认 docs/02-10段动作提示词.md）
  --stills <目录>      静帧输出目录（默认 out/_stills）
  --out-raw <目录>     视频输出目录（默认 out/raw）
  --force              已存在的**视频**产物也重做（不再牵连静帧）
  --force-still        已存在的静帧也重做（重新出图；因为视频要用新静帧当首帧，该段视频也会重建）
  --skip-name-gate     名字对不上（docs vs config.jsonc）也照跑（不建议）
  --help, -h           显示本帮助

环境变量：ARK_API_KEY(必需) ARK_BASE MODEL_IMAGE MODEL_VIDEO VIDEO_SCHEMA
          CONCURRENCY VIDEO_TIMEOUT_MS HTTP_RETRIES VIDEO_DURATION VIDEO_RESOLUTION REF_IMAGE`;

function parseArgs(argv) {
  // --help 必须在任何未知参数抛错之前处理：否则 `--help --typo` 会先被 default 分支 throw 掉，
  // 用户想看帮助反而只拿到一句「未知参数」。返回的这个最小对象 main 只读 o.help，够用。
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const RESOLUTIONS = ['480p', '720p', '1080p']; // 视频分辨率白名单，见函数末尾校验
  const o = {
    docs: DOCS_FILE,
    ref: REF_IMAGE,
    outRaw: OUT_RAW,
    stills: OUT_STILLS,
    limit: 0,
    only: null,
    force: false,
    forceStill: false,
    schemaExplicit: Boolean(process.env.VIDEO_SCHEMA), // 用户是否**显式**指定了写法（含环境变量）
    go: false,
    probe: false,
    all: false,
    skipImage: false,
    skipNameGate: false,
    schema: process.env.VIDEO_SCHEMA || null, // null = 还没定，后面按 probe 结论/默认补
    duration: Number(process.env.VIDEO_DURATION || 10),
    resolution: process.env.VIDEO_RESOLUTION || '720p',
    imageSize: IMAGE_SIZE,
    concurrency: CONCURRENCY,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺参数值`);
      return v;
    };
    switch (a) {
      case '--docs': o.docs = path.resolve(val()); break;
      case '--ref': o.ref = path.resolve(val()); break;
      case '--out-raw': o.outRaw = path.resolve(val()); break;
      case '--stills': o.stills = path.resolve(val()); break;
      case '--limit': { // 块级 case：break 放在块内，别漏（漏了就落进下一个 case）
        const raw = val();
        const n = Number(raw);
        // 以前直接 Number(val())：拿到 "abc" 是 NaN，NaN > 0 为假 → 被静默当成「没给 scope」，
        // 于是 --limit abc 会退化成「拒绝跑全量」，用户完全看不出是自己参数写错了。
        if (!Number.isInteger(n) || n <= 0) throw new Error('--limit 必须是正整数，收到 ' + raw);
        o.limit = n;
        break;
      }
      case '--only': o.only = val().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--schema': o.schema = val(); o.schemaExplicit = true; break; // 显式指定 → probe 试序听用户的
      case '--duration': o.duration = Number(val()); break;
      case '--resolution': o.resolution = val(); break;
      case '--image-size': o.imageSize = val(); break;
      case '--concurrency': o.concurrency = Number(val()); break;
      case '--go': o.go = true; break;
      case '--force': o.force = true; break;
      case '--force-still': o.forceStill = true; break;
      case '--probe': o.probe = true; break;
      case '--all': o.all = true; break;
      case '--skip-image': o.skipImage = true; break;
      case '--skip-name-gate': o.skipNameGate = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`未知参数：${a}`);
    }
  }
  if (o.schema && !['flags', 'fields'].includes(o.schema)) throw new Error(`--schema 只能是 flags 或 fields，收到 ${o.schema}`);
  if (!Number.isFinite(o.duration) || o.duration <= 0) throw new Error(`--duration 必须是正数，收到 ${o.duration}`);
  // 兜底值必须是 1（不是 3）：一段硬失败时已在飞的段照样把两个花钱 POST 发出去，并发越高越费钱。
  o.concurrency = Math.max(1, Number(o.concurrency) || 1);
  // 两个来源都要挡：--resolution xyz 和 $env:VIDEO_RESOLUTION=xyz（写错分辨率 = 要么被拒、要么出废片）
  if (!RESOLUTIONS.includes(o.resolution)) throw new Error('--resolution 只能是 ' + RESOLUTIONS.join(' / ') + '，收到 ' + o.resolution);
  return o;
}

// ----------------------------------------------------------------- 解析 docs/02
// 段头是 `#### NNN. \`动作名\``，每段两个 ```text 代码块：
//   第 1 块 = 图生图提示词（含【这一帧的姿势】），第 2 块 = 图生视频提示词。
function parseDocs(text) {
  const parts = text.split(/^####\s*(\d+)\.\s*`([^`]+)`/m);
  const segs = [];
  for (let i = 1; i + 2 < parts.length; i += 3) {
    const no = parts[i];
    const name = parts[i + 1];
    const body = parts[i + 2];
    const blocks = [...body.matchAll(/```text\s*([\s\S]*?)```/g)].map((m) => m[1].trim());
    if (blocks.length < 2) {
      console.warn(`⚠ 段 ${no} ${name} 没找到两段 \`\`\`text 提示词（只找到 ${blocks.length} 段），跳过`);
      continue;
    }
    segs.push({ no, name, img: blocks[0], vid: blocks[1] });
  }
  return segs;
}

// ----------------------------------------------------------------- 工具函数
function dataUri(file) {
  const b = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${b.toString('base64')}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 打印用：把超长的 base64 data URI 折叠掉，免得把原始响应刷爆。 */
function redact(v) {
  if (typeof v === 'string') {
    return v.startsWith('data:') && v.length > 120 ? `${v.slice(0, 48)}…<base64 省略 ${v.length} 字符>` : v;
  }
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]));
  return v;
}

const brief = (s, n = 80) => {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
};

/**
 * 带退避的 fetch + JSON 解析。
 *
 * 【什么该重试，什么绝对不重试】—— 这一段直接关系到会不会重复扣费：
 *   · 429（限流）：服务端明确没收下 → 重试安全，POST/GET 都重试。
 *   · 5xx / 网络错误：对幂等的 GET（轮询、下载）重试；对建任务的 POST **不重试** ——
 *     因为可能「服务端已经收下并开始计费了，只是回包路上断了」，重发就是第二笔钱。
 *   · 4xx / 模型返回 error / 任务 failed / 审核拒绝：一律不重试，直接抛，交给上层停下并退出非 0。
 *
 * @param {boolean} idempotent 该请求是否幂等（GET/下载 = true；建任务/出图 = false）
 */
async function arkFetch(url, init = {}, { label = '请求', retries = HTTP_RETRIES, idempotent = false } = {}) {
  const method = (init.method || 'GET').toUpperCase();
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    let res;
    let text;
    try {
      // 【为什么每个 fetch 都必须带超时】没有超时的 POST 一旦挂住就是无限等，用户只能 Ctrl-C 重跑；
      // 而那次 POST 服务端**可能已经收下并计费**了，重跑 = 第二笔钱。超时只是让脚本更快把
      // 「去控制台核实这次到底成功没有」这句话说出来。超时抛的错没有状态码，走的正是下面
      // 「非幂等 → 不自动重发」那条路径（幂等 GET 给 60 秒，两个花钱 POST 给 300 秒）。
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(idempotent ? 60_000 : 300_000) });
      text = await res.text();
    } catch (e) {
      lastErr = new Error(`${label}：网络错误 —— ${e.message}`);
      lastErr.status = 0; // 0 = 状态不明确（网络错误/超时）：上层据此判定「不能换写法重发」
      if (!idempotent) {
        throw new Error(
          `${lastErr.message}\n` +
            `      ⚠ 这是 ${method}（非幂等）：**不自动重发**。服务端可能已经收下并计费，重发 = 重复扣费。\n` +
            `      请先到方舟控制台看这次到底有没有建成功（任务列表/用量），确认后再手工重跑本命令。`,
        );
      }
      if (attempt < retries) {
        const wait = 1500 * 2 ** (attempt - 1);
        console.warn(`  ⏳ ${label} 网络错误，${wait}ms 后重试（${attempt}/${retries}）`);
        await sleep(wait);
        continue;
      }
      throw lastErr;
    }

    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { _raw: text.slice(0, 800) };
    }

    if (res.status === 429) {
      lastErr = new Error(`${label}：HTTP 429（限流）—— ${text.slice(0, 300)}`);
      lastErr.status = 429; // 带上状态码：probe 靠它认出「不是确定 4xx」，别换写法重发
      if (attempt < retries) {
        const wait = 1500 * 2 ** (attempt - 1);
        console.warn(`  ⏳ ${label} HTTP 429 限流，${wait}ms 后重试（${attempt}/${retries}）`);
        await sleep(wait);
        continue;
      }
      throw lastErr;
    }

    if (res.status >= 500) {
      lastErr = new Error(`${label}：HTTP ${res.status} —— ${text.slice(0, 300)}`);
      lastErr.status = res.status; // 5xx 同样是「状态不明确」：服务端可能已收下并计费
      if (!idempotent) {
        throw new Error(
          `${lastErr.message}\n` +
            `      ⚠ 这是 ${method}（非幂等）：**不自动重发** —— 5xx 也可能是服务端已收下但回包失败，重发 = 重复扣费。\n` +
            `      请先到方舟控制台核实这次任务/用量，再决定是否手工重跑。`,
        );
      }
      if (attempt < retries) {
        const wait = 1500 * 2 ** (attempt - 1);
        console.warn(`  ⏳ ${label} HTTP ${res.status}，${wait}ms 后重试（${attempt}/${retries}）`);
        await sleep(wait);
        continue;
      }
      throw lastErr;
    }

    return { status: res.status, json, text };
  }
  throw lastErr;
}

/** 把 Ark 的错误响应拼成一条可读错误（连带原始正文）。 */
function arkError(label, r) {
  const msg = r.json?.error?.message || r.json?.message || r.json?._raw || r.text?.slice(0, 400) || '(无正文)';
  const code = r.json?.error?.code ? `（code=${r.json.error.code}）` : '';
  const e = new Error(`${label}：HTTP ${r.status}${code} —— ${msg}`);
  e.status = r.status; // P1 靠这个字段判「确定 4xx」还是「状态不明确」；比从 message 里正则抠可靠
  e.raw = r.text?.slice(0, 1200) || '';
  return e;
}

/** 判断失败原因是不是「内容被审核拒绝」——只是为了让提示更准，行为一样是立刻停。 */
function looksLikeModeration(msg) {
  return /sensitive|moderation|risk|content.?policy|审核|违规|安全|blocked/i.test(String(msg));
}

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` };
}

// ----------------------------------------------------------------- ① 图生图
async function genImage(refUri, prompt, { model, size }) {
  const body = {
    model,
    prompt,
    image: [refUri],            // 图生图：定妆图作参考（base64 data URI 内联）
    response_format: 'b64_json', // 直接拿字节，绕开有有效期的 URL
    size,
    watermark: false,
  };
  const r = await arkFetch(
    `${ARK_BASE}/images/generations`,
    { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) },
    { label: '图生图', idempotent: false },
  );
  if (r.json?.error) throw arkError('图生图', r);
  if (r.status >= 400) throw arkError('图生图', r);
  const b64 = r.json?.data?.[0]?.b64_json;
  if (!b64) {
    const e = new Error(`图生图返回里没有 b64_json：${r.text.slice(0, 400)}`);
    e.raw = r.text.slice(0, 1200);
    throw e;
  }
  return { buf: Buffer.from(b64, 'base64'), raw: r.json };
}

// ----------------------------------------------------------------- ② 图生视频
/** 按 schema 组装请求体 —— 两代写法差异的唯一集中点。 */
function buildVideoBody({ model, stillUri, prompt, schema, duration, ratio = RATIO, resolution }) {
  const content = [{ type: 'image_url', image_url: { url: stillUri } }];
  if (schema === 'flags') {
    const flags = ` --resolution ${resolution} --duration ${duration} --ratio ${ratio} --watermark false --camerafixed true`;
    content.unshift({ type: 'text', text: prompt + flags });
    return { model, content };
  }
  content.unshift({ type: 'text', text: prompt });
  return { model, content, ratio, duration, resolution, watermark: false, camera_fixed: true, generate_audio: false };
}

async function createVideo(stillUri, prompt, opts) {
  const body = buildVideoBody({ ...opts, stillUri, prompt });
  const r = await arkFetch(
    `${ARK_BASE}/contents/generations/tasks`,
    { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) },
    { label: '建视频任务', idempotent: false },
  );
  if (r.json?.error || r.status >= 400) {
    const e = arkError('建视频任务', r);
    e.message += `\n     用的写法：--schema ${opts.schema}；请求体要点：${JSON.stringify(redact(body)).slice(0, 300)}`;
    e.schema = opts.schema;
    throw e;
  }
  const id = r.json?.id || r.json?.data?.id;
  if (!id) {
    const e = new Error(`建视频任务成功但拿不到 task id：${r.text.slice(0, 400)}`);
    e.raw = r.text.slice(0, 1200);
    throw e;
  }
  return { id, body, raw: r.text };
}

async function pollVideo(id) {
  const started = Date.now();
  let last = '';
  for (;;) {
    await sleep(8000);
    const r = await arkFetch(
      `${ARK_BASE}/contents/generations/tasks/${id}`,
      { headers: authHeaders() },
      { label: '轮询视频', retries: 2, idempotent: true },
    );
    const j = r.json || {};
    const status = j.status;
    if (status === 'succeeded') {
      const url = j.content?.video_url || j.data?.video_url || j.video_url;
      if (!url) {
        const e = new Error(`视频任务 succeeded 但响应里没有 video_url：${r.text.slice(0, 400)}`);
        e.raw = r.text.slice(0, 1200);
        throw e;
      }
      return url;
    }
    if (status === 'failed' || status === 'cancelled') {
      const detail = JSON.stringify(j.error || j).slice(0, 500);
      const e = new Error(
        `视频任务 ${status}（**不重发、不换模型** —— 重发 = 重复扣费）：${detail}` +
          (looksLikeModeration(detail) ? '\n     → 看着像内容审核拒绝：改提示词/首帧后再重跑，别原样重发。' : ''),
      );
      e.raw = r.text.slice(0, 1200);
      throw e;
    }
    last = status || JSON.stringify(j).slice(0, 120);
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    process.stdout.write(`\r    任务 ${id} 状态=${last} 已等 ${mins} 分钟   `);
    if (Date.now() - started > VIDEO_TIMEOUT_MS) {
      throw new Error(
        `视频轮询超时（${(VIDEO_TIMEOUT_MS / 60000).toFixed(0)} 分钟，最后状态 ${last}）。\n` +
          `     任务 id=${id}（任务可能还在跑，别重复提交），可手工查：\n` +
          `     GET ${ARK_BASE}/contents/generations/tasks/${id}`,
      );
    }
  }
}

/** 下载成片。GET，幂等，允许重试；失败时把 URL 打出来让人工兜底。 */
async function download(url, outPath) {
  let lastErr;
  for (let attempt = 1; attempt <= HTTP_RETRIES; attempt++) {
    try {
      // 素材可能几十 MB，给 300 秒长超时。超时错没有状态码 → 落到下面「不自动重发」的提示路径。
      const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (r.ok) {
        fs.writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
        return;
      }
      lastErr = new Error(`下载视频 HTTP ${r.status}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) {
      lastErr = e;
    }
    if (attempt < HTTP_RETRIES) await sleep(1000 * attempt);
  }
  const e = new Error(
    `下载视频失败：${lastErr?.message}（任务已经生成并计费了，**别重跑整段**）\n` +
      `     请手工把这个 URL 存成 ${outPath}：\n     ${url}`,
  );
  e.videoUrl = url;
  throw e;
}

// ----------------------------------------------------------------- 并发池
async function pool(items, n, fn) {
  let cursor = 0;
  const failures = [];
  let abort = null; // 第一个硬失败：立刻停止派发新任务（不再花钱），已在飞的让它自然结束
  const total = items.length;
  async function worker() {
    for (;;) {
      if (abort) return;
      const i = cursor++;
      if (i >= total) return;
      const item = items[i];
      try {
        await fn(item, i, total);
      } catch (e) {
        const f = { name: item.name, message: e.message, raw: e.raw };
        failures.push(f);
        if (!abort) abort = f;
        console.error(`\n✗ [${i + 1}/${total}] ${item.name} 失败 —— **已停止派发新任务**（不自动重发，避免重复扣费）：`);
        console.error(`   ${e.message}`);
        if (e.raw) console.error(`   原始响应：${e.raw.replace(/\n/g, '\n   ')}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, total)) }, worker));
  return { failures, abort };
}

// ----------------------------------------------------------------- 名字闸门
// 花钱之前先确保提示词包里的名字和 assets/config.jsonc 里的 10 个名字**逐字一致**。
// 差一个字 = 生成出来的素材永远找不到 = 白花钱。
function gateNames(docsFile) {
  const cfg = configActionNames(CONFIG_FILE);
  const doc = parseDocs(fs.readFileSync(docsFile, 'utf8')).map((s) => s.name);
  const cfgSet = new Set(cfg);
  const docSet = new Set(doc);
  const missInDoc = cfg.filter((n) => !docSet.has(n));
  const extraInDoc = doc.filter((n) => !cfgSet.has(n));
  if (missInDoc.length || extraInDoc.length) {
    console.error('\n✗ 名字对不上，先别生成（错一个名字 = 白生成一段）：');
    if (missInDoc.length) console.error(`  config.jsonc 有、提示词包没有（${missInDoc.length}）：${missInDoc.join('、')}`);
    if (extraInDoc.length) console.error(`  提示词包有、config.jsonc 没有（${extraInDoc.length}）：${extraInDoc.join('、')}`);
    console.error('  （config.jsonc 是唯一事实来源。确实要硬跑：--skip-name-gate）');
    return false;
  }
  return true;
}

// ----------------------------------------------------------------- 计划 / 花费
/** 这一段现在会发什么请求（用于 dry-run 打印和花费估算）。 */
function planFor(seg, o) {
  const mp4 = path.join(o.outRaw, `${seg.name}.mp4`);
  const still = path.join(o.stills, `${seg.name}.png`);
  const needVideo = o.force || !fs.existsSync(mp4);
  const reuseStill = !o.skipImage && !o.force && fs.existsSync(still);
  const needImage = needVideo && !o.skipImage && !reuseStill;
  return { name: seg.name, mp4, still, needVideo, needImage, reuseStill, skipImage: o.skipImage };
}

function estimate(plans, o) {
  const img = plans.filter((p) => p.needVideo && p.needImage).length;
  const vid = plans.filter((p) => p.needVideo).length;
  const yuan = img * PRICE_IMAGE_YUAN + vid * o.duration * PRICE_VIDEO_YUAN_PER_SEC;
  return { img, vid, yuan };
}

function printCost(plans, o, { title = '本次预计' } = {}) {
  const est = estimate(plans, o);
  console.log(
    `${title} ¥${est.yuan.toFixed(2)}（图片 ${est.img} 张 × ¥${PRICE_IMAGE_YUAN} + 视频 ${est.vid} 段 × ${o.duration} 秒 × ¥${PRICE_VIDEO_YUAN_PER_SEC}/秒）`,
  );
  console.log('  ⚠ 这是**估算，不是账单承诺**（视频真实计费常按 token 计，以方舟控制台账单为准）。');
  console.log('    单价就在脚本顶部 PRICE_IMAGE_YUAN / PRICE_VIDEO_YUAN_PER_SEC，按你自己账号改。');
  return est;
}

function printPlan(segs, plans, o, models, schema) {
  console.log(`Ark base : ${ARK_BASE}`);
  console.log(`图模型   : ${models.image}   （来源：${models.source}）`);
  console.log(`视频模型 : ${models.video}`);
  console.log(`视频写法 : --schema ${schema}`);
  console.log(`并发     : ${o.concurrency}   轮询上限 ${(VIDEO_TIMEOUT_MS / 60000).toFixed(0)} 分钟/段   重试上限 ${HTTP_RETRIES}`);
  console.log(`待生成   : ${plans.length} 段（提示词包共 ${segs.length} 段）`);
  console.log(`每段     : 视频 ${o.resolution} / ${o.duration}s / ${RATIO}${o.skipImage ? '；跳过图生图，用定妆图当首帧' : '；先图生图再图生视频'}`);
  console.log('');
  const total = plans.length;
  plans.forEach((p, i) => {
    const seg = segs.find((s) => s.name === p.name);
    const tag = !p.needVideo
      ? '视频已存在，跳过（--force 可重做）'
      : [
          p.needImage ? `发图 ${models.image} @ ${o.imageSize}` : p.reuseStill ? '复用已有静帧（省一次图片调用）' : '跳过图生图（--skip-image）',
          `→ 视频 ${models.video} ${schema} ${o.resolution} ${o.duration}s`,
        ].join(' ');
    console.log(`[${i + 1}/${total}] ${p.name}`);
    console.log(`        ${tag}`);
    console.log(`        视频提示词前 80 字：${brief(seg?.vid ?? '', 80)}`);
  });
  console.log('');
}

// ----------------------------------------------------------------- probe
// 只花几分钱把三件不确定的事定下来：模型 ID 对不对、视频参数该用哪种写法、base64 首帧收不收。
// 关键设计：**把原始请求/响应打出来**，而不是替用户猜。
// 省钱设计：先用首选 schema 建任务；**只有被拒了**才试另一种，所以通常只花 1 段 5 秒视频的钱。
async function runProbe(o, models, refUri, sample) {
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const probeDuration = Math.min(5, o.duration);
  const result = {
    at: new Date().toISOString(),
    base: ARK_BASE,
    models: { image: models.image, video: models.video, source: models.source },
    requested: { duration: probeDuration, resolution: o.resolution, ratio: RATIO, schemaPrimary: o.schema },
    notes: [],
  };

  console.log('════════ probe：先用几分钱验明正身 ════════\n');
  console.log(`基址     : ${ARK_BASE}`);
  console.log(`图模型   : ${models.image}`);
  console.log(`视频模型 : ${models.video}`);
  console.log(`模型来源 : ${models.source}`);
  console.log(`样本段   : ${sample.name}（${sample.no}）`);
  console.log('本次预计 ¥' + (PRICE_IMAGE_YUAN + probeDuration * PRICE_VIDEO_YUAN_PER_SEC).toFixed(2) +
    `（图片 1 张 × ¥${PRICE_IMAGE_YUAN} + 视频 1 段 × ${probeDuration} 秒 × ¥${PRICE_VIDEO_YUAN_PER_SEC}/秒）`);
  console.log('  ⚠ 估算，不是账单承诺；首选写法被拒时会再用另一种写法建一次任务（最多多 1 段 5 秒）。\n');

  // —— ① 图生图 ——
  console.log(`① 图生图（1 张，样本：${sample.name}）`);
  console.log(`   请求：POST ${ARK_BASE}/images/generations`);
  console.log(`   请求体：${JSON.stringify({ model: models.image, size: o.imageSize, response_format: 'b64_json', watermark: false, image: '[定妆图 base64 data URI]', prompt: brief(sample.img, 60) })}`);
  let stillUri;
  try {
    const { buf, raw } = await genImage(refUri, sample.img, { model: models.image, size: o.imageSize });
    const p = path.join(PROBE_DIR, 'probe-still.png');
    fs.writeFileSync(p, buf);
    stillUri = `data:image/png;base64,${buf.toString('base64')}`;
    console.log(`   ✓ 成功，${(buf.length / 1024).toFixed(0)} KB → ${p}`);
    console.log(`   响应 data[0] 字段：${Object.keys(raw.data?.[0] ?? {}).join(', ') || '(空)'}`);
    console.log(`   响应（去掉 base64 后）：${JSON.stringify(redact(raw)).slice(0, 400)}`);
    result.image = 'ok';
    result.imageResponseKeys = Object.keys(raw.data?.[0] ?? {});
  } catch (e) {
    console.log(`   ✗ 失败：${e.message}`);
    if (e.raw) console.log(`   原始响应：${e.raw}`);
    console.log('   → 若报 model not found / 未开通：去方舟控制台「开通管理」复制确切模型 ID，');
    console.log('     用 $env:MODEL_IMAGE 覆盖，或写进 out/_probe/models.json：');
    console.log(`     { "image": "<确切ID>", "video": "${models.video}" }`);
    result.image = `fail: ${e.message}`;
    result.conclusion = '图模型不可用：先修好 MODEL_IMAGE 再跑正式生成。';
    fs.writeFileSync(PROBE_JSON, JSON.stringify(result, null, 2), 'utf8');
    console.log('\n结论写进 out/_probe/probe.json');
    process.exitCode = 1;
    return;
  }

  // —— ② 图生视频：先用首选 schema，被拒才试另一种 ——
  const order = o.schema === 'flags' ? ['flags', 'fields'] : ['fields', 'flags'];
  console.log(`\n② 图生视频（首帧用 base64 data URI 内联；先试 --schema ${order[0]}，被拒才试 ${order[1]}；${probeDuration} 秒省钱）`);
  result.schemasTried = [];
  let winner = null;
  for (const schema of order) {
    const bodyPreview = JSON.stringify(redact(buildVideoBody({
      model: models.video, stillUri: '[静帧 base64 data URI]', prompt: brief(sample.vid, 60),
      schema, duration: probeDuration, resolution: o.resolution,
    })));
    console.log(`   → 试 --schema ${schema}：POST ${ARK_BASE}/contents/generations/tasks`);
    console.log(`     请求体：${bodyPreview.slice(0, 400)}`);
    try {
      const { id, raw } = await createVideo(stillUri, sample.vid, {
        model: models.video, schema, duration: probeDuration, resolution: o.resolution,
      });
      console.log(`   ✓ --schema ${schema} 被接受，task id=${id}`);
      console.log(`     原始响应：${String(raw).slice(0, 300)}`);
      result.schemasTried.push({ schema, accepted: true, taskId: id });
      winner = { schema, id };
      break;
    } catch (e) {
      console.log(`   ✗ --schema ${schema} 被拒：${e.message}`);
      if (e.raw) console.log(`     原始响应：${e.raw}`);
      result.schemasTried.push({ schema, accepted: false, error: e.message });
      if (/model|not found|未开通|invalid|permission|forbidden|401|403/i.test(e.message)) {
        console.log('   （看着像模型 ID / 权限问题，换写法也救不了 —— 两种写法都试一遍确认。）');
      }
    }
  }

  if (!winner) {
    console.log('\n   ✗ 两种写法都被拒。把上面的原始报错发出来，或先去控制台确认：');
    console.log('     1) 视频模型 ID 是否已开通（$env:MODEL_VIDEO）');
    console.log('     2) 该模型是否支持「图生视频（首帧）」');
    result.video = 'both-schemas-rejected';
    result.conclusion = '视频接口两种写法都建不了任务：先解决模型 ID / 权限，再跑正式生成。';
    fs.writeFileSync(PROBE_JSON, JSON.stringify(result, null, 2), 'utf8');
    console.log('\n结论写进 out/_probe/probe.json');
    process.exitCode = 1;
    return;
  }

  // —— ③ 把整条链跑完（轮询 + 下载），证明真能出片 ——
  console.log(`\n   采用 --schema ${winner.schema}（task ${winner.id}），等它出片…`);
  result.winnerSchema = winner.schema;
  result.base64FirstFrameAccepted = true; // 建任务接受 = 收 base64 首帧
  try {
    const url = await pollVideo(winner.id);
    const out = path.join(PROBE_DIR, `probe-video-${winner.schema}.mp4`);
    await download(url, out);
    console.log(`\n   ✓ 出片并下载成功 → ${out}（${(fs.statSync(out).size / 1024).toFixed(0)} KB）`);
    result.video = 'ok';
    result.videoUrl = url;
    result.videoFile = out;
  } catch (e) {
    console.log(`\n   ✗ 任务提交成功但没拿到片子：${e.message}`);
    if (e.raw) console.log(`   原始响应：${e.raw}`);
    result.video = `submitted-but-failed: ${e.message}`;
    result.conclusion = '建任务没问题，但出片/下载失败：看上面的原始错误，别原样重发。';
    writeProbeOutputs(result, models, winner.schema);
    process.exitCode = 1;
    return;
  }

  result.notes.push(`正式生成建议用 --schema ${winner.schema}`);
  result.notes.push('base64 data URI 首帧：可接受（图生视频任务建成功）');
  result.conclusion =
    `全部通过：图模型 ${models.image} 可用、视频模型 ${models.video} 可用、写法用 --schema ${winner.schema}。` +
    `下一步：node tools/gen-api.mjs --limit 2 --schema ${winner.schema} --go`;
  writeProbeOutputs(result, models, winner.schema);
  console.log('\n════════ probe 完成 ════════');
  console.log(`结论：${result.conclusion}`);
  console.log(`已写：${PROBE_JSON}`);
  console.log(`已写：${MODELS_JSON}（之后的运行会优先读它，不用再设环境变量）`);
}

/** probe 的结论落盘：probe.json（全量结论）+ models.json（后续运行直接读）。 */
function writeProbeOutputs(result, models, schema) {
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  fs.writeFileSync(PROBE_JSON, JSON.stringify(result, null, 2), 'utf8');
  fs.writeFileSync(
    MODELS_JSON,
    JSON.stringify(
      {
        image: models.image,
        video: models.video,
        schema: schema || models.schema || 'flags',
        base: ARK_BASE,
        at: new Date().toISOString(),
        note: '由 tools/gen-api.mjs --probe 写入；环境变量 MODEL_IMAGE/MODEL_VIDEO/VIDEO_SCHEMA 优先于此文件。',
      },
      null,
      2,
    ),
    'utf8',
  );
}

// ----------------------------------------------------------------- 主流程
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(HELP); return; }

  const models = loadModels();
  // schema 优先级：--schema（含 $env:VIDEO_SCHEMA） > probe 结论 > flags
  const schema = o.schema || models.schema || 'flags';
  const explicitScope = Boolean(o.only) || o.limit > 0;

  console.log('════════ gen-api · 红队桌宠素材生成 ════════\n');
  if (!o.go) console.log('模式     : 空跑（dry-run）—— **不会发任何 HTTP 请求**');
  console.log('');

  // —— 输入体检（缺文件就别往下走了）——
  if (!fs.existsSync(o.docs)) {
    console.error(`✗ 找不到提示词包：${o.docs}`);
    process.exitCode = 1;
    return;
  }
  const docsText = fs.readFileSync(o.docs, 'utf8');
  const segs = parseDocs(docsText);
  if (!segs.length) {
    console.error(`✗ 提示词包里没解析出任何段（段头格式应为 "#### NNN. \`动作名\`"）：${o.docs}`);
    process.exitCode = 1;
    return;
  }
  if (!o.skipNameGate && !gateNames(o.docs)) {
    process.exitCode = 1;
    return;
  }

  // —— 选段：--only / --limit ——
  let work = segs;
  if (o.only) {
    const want = new Set(o.only);
    work = work.filter((s) => want.has(s.name));
    const unmatched = o.only.filter((n) => !segs.some((s) => s.name === n));
    if (unmatched.length) console.warn(`⚠ --only 里这些名字在提示词包里不存在：${unmatched.join('、')}`);
    if (!work.length) {
      console.error('✗ --only 里的名字一个都没匹配上（名字必须与 assets/config.jsonc / 提示词包逐字一致）');
      process.exitCode = 1;
      return;
    }
  }
  if (o.limit > 0) work = work.slice(0, o.limit);

  const plans = work.map((s) => planFor(s, o));

  // —— 定妆图：图生图要它当参考，--skip-image 时它直接当首帧 ——
  // 注意：空跑**不因为缺它而中止**（空跑的价值就是先把计划和花费看清楚）；
  // 真跑（--go）时它是硬门槛，缺了直接报错退出。
  const refExists = fs.existsSync(o.ref);
  console.log(refExists
    ? `定妆图   : ${o.ref}（${(fs.statSync(o.ref).size / 1024).toFixed(0)} KB，会以 base64 data URI 内联发送）`
    : `定妆图   : ${o.ref} —— ⚠ **这个文件还不存在**，真跑前必须先按 docs/01 把它做出来`);
  console.log('');

  const requireRef = () => {
    if (refExists) return true;
    console.error(`✗ 找不到定妆图：${o.ref}`);
    console.error('  图生图要用它当参考，图生视频也要用它当首帧（base64 data URI 内联发送）。');
    console.error('  用 --ref <文件> 指定，或先按 docs/01 做出 out/定妆图.png。');
    console.error('  （只看计划和花费不需要它：不加 --go 直接跑本命令即可。）');
    return false;
  };

  // ==========================================================================
  // 【闸门 A】probe：也要 --go，否则只打印 probe 计划
  // ==========================================================================
  if (o.probe) {
    if (!o.go) {
      console.log('probe 计划（空跑）：');
      console.log(`  会发 1 次图生图（${models.image}）+ 1 次图生视频（${models.video}，${Math.min(5, o.duration)} 秒）`);
      console.log(`  样本段：${work[0].name}（${work[0].no}）`);
      console.log(`  原始请求/响应会全打出来，结论写 ${PROBE_JSON} 与 ${MODELS_JSON}`);
      console.log(`  本次预计 ¥${(PRICE_IMAGE_YUAN + Math.min(5, o.duration) * PRICE_VIDEO_YUAN_PER_SEC).toFixed(2)}` +
        `（图片 1 张 × ¥${PRICE_IMAGE_YUAN} + 视频 1 段 × ${Math.min(5, o.duration)} 秒 × ¥${PRICE_VIDEO_YUAN_PER_SEC}/秒；估算，非账单承诺）`);
      if (!refExists) console.log('  ⚠ 定妆图还没有，真跑前要先做出来。');
      if (!API_KEY) console.log('  ⚠ ARK_API_KEY 还没设，真跑前要先设。');
      console.log('\n要真跑：node tools/gen-api.mjs --probe --go');
      console.log('（不加 --go 不会发任何请求）');
      return;
    }
    if (!API_KEY) {
      console.error('✗ --go 已给，但缺少环境变量 ARK_API_KEY。先：');
      console.error('    $env:ARK_API_KEY = "你的key"');
      console.error('  （火山方舟控制台 → API Key。注意：DeepSeek 的 key 不能生成图/视频。）');
      process.exitCode = 1;
      return;
    }
    if (!requireRef()) { process.exitCode = 1; return; }
    await runProbe(o, models, dataUri(o.ref), work[0]);
    return;
  }

  // ==========================================================================
  // 【闸门 B】--all 硬门槛：没给 --all 又没给 --limit/--only → 只空跑
  // ==========================================================================
  if (!o.all && !explicitScope) {
    printPlan(segs, plans, o, models, schema);
    printCost(plans, o);
    console.log('');
    if (o.go) {
      console.error(`✗ 拒绝直接跑全量 ${plans.length} 段（每段 = ${o.skipImage ? '0 张图' : '1 张图'} + 1 段视频，钱是真花的）。`);
    }
    console.log(`要真跑请加 --all 或 --limit N（或 --only 名字,名字）。本段结束：${o.go ? '已拒绝，未发任何请求' : '空跑，未发任何请求'}。`);
    console.log('建议顺序：');
    console.log('  node tools/gen-api.mjs --probe --go            # 先验模型与写法（几分钱）');
    console.log('  node tools/gen-api.mjs --limit 2 --go          # 再跑 2 段肉眼验收');
    console.log('  node tools/gen-api.mjs --all --go              # 确认后再全量');
    process.exitCode = o.go ? 1 : 0;
    return;
  }

  // ==========================================================================
  // 【闸门 C】没有 --go：只打印计划 + 花费，一个请求都不发
  // ==========================================================================
  if (!o.go) {
    printPlan(segs, plans, o, models, schema);
    printCost(plans, o);
    console.log('');
    console.log('以上全是空跑：**一个请求都没发**。真要开始生成，把 --go 加上，例如：');
    const scope = o.all ? '--all' : explicitScope ? (o.limit > 0 ? `--limit ${o.limit}` : `--only ${o.only.join(',')}`) : '--limit 2';
    console.log(`  node tools/gen-api.mjs ${scope} --go`);
    if (!process.env.ARK_API_KEY) {
      console.log('');
      console.log('⚠ 另外还没设 ARK_API_KEY，加了 --go 会直接报错退出。先：$env:ARK_API_KEY = "你的key"');
    }
    return;
  }

  // ==========================================================================
  // 真跑：这里之后才会发请求
  // ==========================================================================
  if (!API_KEY) {
    console.error('✗ --go 已给，但缺少环境变量 ARK_API_KEY。先：');
    console.error('    $env:ARK_API_KEY = "你的key"');
    console.error('  （火山方舟控制台 → API Key。注意：DeepSeek 的 key 不能生成图/视频。）');
    process.exitCode = 1;
    return;
  }
  if (!requireRef()) { process.exitCode = 1; return; }
  const refUri = dataUri(o.ref);

  fs.mkdirSync(o.outRaw, { recursive: true });
  fs.mkdirSync(o.stills, { recursive: true });

  console.log(`Ark base : ${ARK_BASE}`);
  console.log(`图模型   : ${models.image}   （来源：${models.source}）`);
  console.log(`视频模型 : ${models.video}`);
  console.log(`视频写法 : --schema ${schema}`);
  console.log(`定妆图   : ${o.ref}`);
  console.log(`并发     : ${o.concurrency}   轮询上限 ${(VIDEO_TIMEOUT_MS / 60000).toFixed(0)} 分钟/段   重试上限 ${HTTP_RETRIES}`);
  console.log(`范围     : ${plans.length} 段${o.all ? '（--all）' : o.limit > 0 ? `（--limit ${o.limit}）` : '（--only）'}`);
  console.log('');
  printCost(plans, o, { title: '开跑前再确认一次，本次预计' });
  console.log('  （失败不自动重发；中断后重跑同一条命令即可续跑，已存在的不重复花钱。）');
  console.log('');

  const { failures, abort } = await pool(plans, o.concurrency, async (p, i, total) => {
    const tag = `[${i + 1}/${total}] ${p.name}`;
    if (!p.needVideo) {
      console.log(`${tag} … 已存在，跳过（--force 可重做）`);
      return;
    }

    // ① 拿到首帧（三种来源，按省钱顺序）
    let stillUri;
    if (p.reuseStill) {
      console.log(`${tag} … 复用已有静帧（省一次图片调用）`);
      stillUri = dataUri(p.still);
    } else if (p.skipImage) {
      console.log(`${tag} … 用定妆图当首帧（--skip-image）`);
      stillUri = refUri;
    } else {
      console.log(`${tag} … 发图（${models.image} @ ${o.imageSize}）`);
      const { buf, raw } = await genImage(refUri, segs.find((s) => s.name === p.name).img, {
        model: models.image, size: o.imageSize,
      });
      fs.writeFileSync(p.still, buf);
      stillUri = `data:image/png;base64,${buf.toString('base64')}`;
      console.log(`${tag} … 出图 ${(buf.length / 1024).toFixed(0)} KB → ${path.relative(ROOT, p.still)}（响应字段 ${Object.keys(raw.data?.[0] ?? {}).join(',')}）`);
    }

    // ② 建视频任务
    console.log(`${tag} … 建视频任务（${models.video} ${schema} ${o.resolution} ${o.duration}s）`);
    const { id } = await createVideo(stillUri, segs.find((s) => s.name === p.name).vid, {
      model: models.video, schema, duration: o.duration, resolution: o.resolution,
    });

    // ③ 轮询 → 下载
    console.log(`${tag} … 等出片（task ${id}）`);
    const url = await pollVideo(id);
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    console.log(`${tag} … 下载成片`);
    await download(url, p.mp4);
    console.log(`✓ ${tag} → ${path.relative(ROOT, p.mp4)}（${(fs.statSync(p.mp4).size / 1024).toFixed(0)} KB）`);
  });

  console.log(`\n汇总：成功 ${plans.length - failures.length} / ${plans.length}`);
  if (failures.length) {
    console.log(`失败 ${failures.length} 个：${failures.map((f) => f.name).join(' / ')}`);
    if (abort) console.log(`首个失败原因：${abort.message.split('\n')[0]}`);
    console.log('（**不自动重发**。修好原因后重跑同一条命令即可增量补齐，已成功/已存在的不会重做。）');
    process.exitCode = 1;
  } else if (plans.length) {
    console.log('下一步：node tools/pipeline.mjs   （抠像 → 装进插件 → 体检）');
  }
}

const isMain =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((e) => {
    console.error(`\n✗ ${e.message}`);
    if (e.raw) console.error(`原始响应：${e.raw}`);
    process.exitCode = 1;
  });
}
