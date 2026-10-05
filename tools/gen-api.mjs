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
//   ③ 单价是脚本顶部两个显式常量（PRICE_IMAGE_YUAN / PRICE_VIDEO_YUAN_PER_MTOKENS），
//      视频按 **token** 计费，token 量 = 宽×高×帧率×时长÷1024（实测误差 <1%），
//      单价默认取 Seedance 2.0 文档的 92 元/百万 tokens（480P/720P）。**按你自己账号的实际单价改**。
//      dry-run 与每次真跑前都打印 token 量与金额，并给一行「换分辨率/时长能省多少」的对照。
//      这是**估算、不是账单承诺**：真实金额以方舟控制台账单为准。
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
// 【自测用假 fetch】GENAPI_STUB_FETCH=1 时把 fetch 换成假的：**零网络、零花费**
// ----------------------------------------------------------------------------
// 为什么必须有它：2026-10-05 我用**带 --go 的真实命令**去验证"预算闸门"，
// 结果真的调了 API、花掉 ¥4.66。教训：**花钱闸门的测试绝不能碰真网络。**
// `--self-test` 会给每个用例设 GENAPI_STUB_FETCH=1 + GENAPI_STUB_LOG=<文件>，
// 之后只检查「退出码」与「假 fetch 记下的调用日志」，一个真实请求都不会发。
// ============================================================================
if (process.env.GENAPI_STUB_FETCH === '1') {
  const stubLog = process.env.GENAPI_STUB_LOG || path.join(ROOT, 'out', '_selftest', `stub-${process.pid}.log`);
  fs.mkdirSync(path.dirname(stubLog), { recursive: true });
  fs.writeFileSync(stubLog, '');
  // 1×1 透明 PNG；够 genImage 走完 sniffImage + 落盘即可
  const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method ?? 'GET').toUpperCase();
    fs.appendFileSync(stubLog, `${method} ${u}\nBODY:${init.body === undefined ? '' : String(init.body)}\n---\n`);
    const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('/images/generations')) return json({ model: 'stub', data: [{ b64_json: TINY_PNG, output_format: 'png' }] });
    if (u.includes('/contents/generations/tasks') && method === 'POST') return json({ id: 'stub-task-1' });
    if (u.includes('/contents/generations/tasks/')) {
      return json({ id: 'stub-task-1', status: 'succeeded', content: { video_url: 'https://stub.invalid/v.mp4' }, usage: { total_tokens: 48437 } });
    }
    return new Response(Buffer.alloc(1024), { status: 200, headers: { 'content-type': 'video/mp4' } }); // 视频下载
  };
}

// ============================================================================
// 【单价】—— 2026-10-05 改用**真实账单口径**重写（不再是我拍脑袋的占位价）
// ----------------------------------------------------------------------------
// 视频按 **token** 计费，token 量几乎正好是 (宽 × 高 × 帧率 × 时长) ÷ 1024：
//   实测 720p / 24fps / 5 秒 → **108,900 tokens**（公式给 108,000，差 0.8%）
//
// 单价（火山引擎文档《AICC-Seedance2.0模型计费说明》2026-08-03 版）：
//   doubao-seedance-2.0（480P / 720P）不含视频输入 = 92 元/百万 tokens
//   doubao-seedance-2.0（480P / 720P）含视频输入   = 56 元/百万 tokens
//   doubao-seedance-2.0（1080P）      不含视频输入 = 102 元/百万 tokens
//   ⚠ 我们实际用的是 seedance-**2-5**，单价可能高于 2.0；以控制台账单为准。
//   ⚠ **480P 与 720P 单价相同**，所以省钱只能靠降分辨率（token 少），不是换个型号。
//
// 由此推出的量级（不含视频输入、92 元/百万 tokens、24fps）：
//   720p：21,600 tokens/秒 → 5 秒 ¥9.9   10 秒 ¥19.9
//   480p： 9,600 tokens/秒 → 5 秒 ¥4.4   10 秒 ¥8.8
//   全量参考：10 段 × 10 秒 720p ≈ **¥199**（很贵！）
//             10 段 × 10 秒 480p ≈ ¥88
//             10 段 ×  5 秒 480p ≈ **¥44**  ← 素材最终只有 640×360，480p 完全够
// ============================================================================
/** 视频刊例价：元/百万 tokens（480P/720P、不含视频输入）。按你账号实际单价改。 */
const PRICE_VIDEO_YUAN_PER_MTOKENS = 92;
/** 图片单价（元/张）。Seedream 按张计费，这个数**未实测**，请按控制台账单改。 */
const PRICE_IMAGE_YUAN = 0.20;
/** 视频帧率（Seedance 默认 24）。 */
const VIDEO_FPS = 24;

/** 分辨率字符串 → [宽, 高]（16:9）。 */
function pixelSize(resolution) {
  const table = { '480p': [864, 480], '720p': [1280, 720], '1080p': [1920, 1080] };
  return table[resolution] ?? table['720p'];
}

/**
 * 一段视频的 token 量估算：(宽 × 高 × 帧率 × 时长) ÷ 1024。
 * 这条公式是 2026-10-05 拿真实任务反推出来的（720p/24fps/5s 实测 108,900 tokens）。
 */
function estimateVideoTokens(resolution, durationSec) {
  const [w, h] = pixelSize(resolution);
  return Math.round((w * h * VIDEO_FPS * durationSec) / 1024);
}

/** 一段视频的估算花费（元）。 */
function estimateVideoYuan(resolution, durationSec) {
  return (estimateVideoTokens(resolution, durationSec) / 1e6) * PRICE_VIDEO_YUAN_PER_MTOKENS;
}

/**
 * 预算闸门（元）：**预估超过这个数就必须再加一个 --yes 才会真跑**。
 * 为什么需要它：估价虽然打印了，但打印和开跑之间没有停顿 —— `--all --go` 完全可能
 * 在人没细看那一行时就烧掉几百元（默认 720p/10 秒 × 10 段 ≈ ¥199）。
 * 设成 0 或 $env:BUDGET_GUARD_YUAN=0 可关闭。
 */
const BUDGET_GUARD_YUAN = 50;

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
  --yes                预算闸门放行：预估超过 ¥50（可用 $env:BUDGET_GUARD_YUAN 改）时必须再加它
  --self-test          用假 fetch 把花钱闸门与接口参数约束全测一遍（**零网络零花费**）。
                       改过闸门/参数后先跑这个，**绝不要用带 --go 的真命令去测**。
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
    yes: false, // 预算闸门放行：预估超过 BUDGET_GUARD_YUAN 时必须显式加 --yes
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
      case '--yes': o.yes = true; break;
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
/**
 * 从字节头嗅探真实图片格式。
 *
 * 【2026-10-05 实测】Ark 的图生图即使 response_format=b64_json，
 * 返回的也**不一定是 PNG**（我们实测拿到的是 JPEG，响应里 data[0].output_format 会写出来）。
 * 早先版本硬按 .png 存、data URI 硬写 image/png —— 后果有两个：
 *   1) 文件扩展名与实际字节不符（看图工具会报错）；
 *   2) 拿它当视频首帧时 data URI 的 MIME 是错的。
 * 所以：以 output_format 为准，缺了就用魔数嗅探。
 */
function sniffImage(buf, declared) {
  const d = String(declared || '').toLowerCase();
  if (d.includes('jpeg') || d.includes('jpg')) return { ext: 'jpg', mime: 'image/jpeg' };
  if (d.includes('png')) return { ext: 'png', mime: 'image/png' };
  if (d.includes('webp')) return { ext: 'webp', mime: 'image/webp' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return { ext: 'png', mime: 'image/png' }; // 认不出来就按 PNG 处理（旧行为）
}

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
  const buf = Buffer.from(b64, 'base64');
  const fmt = sniffImage(buf, r.json?.data?.[0]?.output_format);
  return { buf, raw: r.json, ...fmt };
}

// ----------------------------------------------------------------- ② 图生视频
/** 按 schema 组装请求体 —— 两代写法差异的唯一集中点。
 *
 * 【2026-10-05 实测修正 1：给首帧时**不能**传 ratio】
 *   带首帧（first-frame）生成时，服务端直接返回 400：
 *     InvalidParameter.TaskTypeConstraint
 *     "The parameter ratio specified in the request is not valid.
 *      For first-frame or first-last-frame generation, the output ratio follows the first-frame image."
 *   也就是**输出比例自动跟随首帧图**，再传 ratio 反而非法。
 *
 * 【2026-10-05 实测修正 2：seedance-2-5 的 i2v **不接受 camera_fixed**】
 *   400 InvalidParameter："the specified parameter camera_fixed is not supported for
 *   model doubao-seedance-2-5 in i2v, must be empty"。
 *   同理 generate_audio 也不是所有 i2v 模型都认。这两个都是"锦上添花"的可选参数，
 *   而且**镜头固定这件事我们的提示词里已经用自然语言写死了**（"镜头完全固定：不推拉、不旋转"），
 *   所以这里一律不发，换取跨模型兼容性。
 *
 * 本脚本永远都带首帧（图生图得到的静帧，或 --skip-image 时的定妆图），
 * 因此 ratio 也一律不发；ratio 形参保留只为将来做「纯文生视频」时用。
 */
function buildVideoBody({ model, stillUri, prompt, schema, duration, ratio = RATIO, resolution }) {
  const content = [{ type: 'image_url', image_url: { url: stillUri } }];
  const ratioFlag = stillUri ? '' : ` --ratio ${ratio}`;
  if (schema === 'flags') {
    const flags = ` --resolution ${resolution} --duration ${duration}${ratioFlag} --watermark false`;
    content.unshift({ type: 'text', text: prompt + flags });
    return { model, content };
  }
  content.unshift({ type: 'text', text: prompt });
  // generate_audio：**不传时模型默认会合成音频**（实测任务详情里 generate_audio=true），
  // 而桌宠素材完全用不到音轨（keyscreen 转码时 -an 直接丢掉），所以显式关掉，别为它付钱。
  // camera_fixed 则相反：seedance-2-5 的 i2v 传了会 400，这里刻意不发。
  const body = { model, content, duration, resolution, watermark: false, generate_audio: false };
  if (!stillUri) body.ratio = ratio;
  return body;
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
  // 静帧后缀**不固定**：Ark 的图生图可能返回 JPEG（见 sniffImage 的注释），
  // 所以判断"已存在静帧"时要按多种后缀找，否则 --force 之外的重跑会白买一张图。
  const stillBase = path.join(o.stills, seg.name);
  const STILL_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
  const stillFound = STILL_EXTS.map((e) => `${stillBase}.${e}`).find((f) => fs.existsSync(f));
  const still = stillFound ?? `${stillBase}.png`;
  // --force 只管视频产物（不牵连静帧）；--force-still 才重出静帧（并连带重建该段视频，
  // 否则会出现"静帧换新的了、视频还是旧的"的错配）。
  const needVideo = o.force || o.forceStill || !fs.existsSync(mp4);
  const reuseStill = !o.skipImage && !o.forceStill && stillFound !== undefined;
  const needImage = needVideo && !o.skipImage && !reuseStill;
  return { name: seg.name, mp4, still, stillBase, needVideo, needImage, reuseStill, skipImage: o.skipImage };
}

function estimate(plans, o) {
  const img = plans.filter((p) => p.needVideo && p.needImage).length;
  const vid = plans.filter((p) => p.needVideo).length;
  const tokensPerVideo = estimateVideoTokens(o.resolution, o.duration);
  const yuan = img * PRICE_IMAGE_YUAN + vid * estimateVideoYuan(o.resolution, o.duration);
  return { img, vid, yuan, tokensPerVideo };
}

function printCost(plans, o, { title = '本次预计' } = {}) {
  const est = estimate(plans, o);
  console.log(
    `${title} ¥${est.yuan.toFixed(2)}`
    + `（图片 ${est.img} 张 × ¥${PRICE_IMAGE_YUAN}`
    + ` + 视频 ${est.vid} 段 × ${o.duration} 秒 ${o.resolution} ≈ ${est.tokensPerVideo.toLocaleString()} tokens/段`
    + ` × ¥${PRICE_VIDEO_YUAN_PER_MTOKENS}/百万tokens）`,
  );
  console.log('  ⚠ 这是**估算，不是账单承诺**。视频 token 公式 = 宽×高×帧率×时长÷1024（实测误差 <1%），');
  console.log(`    单价 ¥${PRICE_VIDEO_YUAN_PER_MTOKENS}/百万tokens 取自 Seedance 2.0 文档；我们用的 2-5 可能更贵。以控制台账单为准。`);
  // 预算对照表：让人一眼看出换分辨率/时长能省多少（这是最容易省错的地方）
  const rows = [];
  for (const res of ['480p', '720p']) {
    for (const dur of [5, o.duration]) {
      rows.push(`${res}/${dur}s ¥${estimateVideoYuan(res, dur).toFixed(2)}`);
    }
  }
  console.log(`    单段参考：${[...new Set(rows)].join('  ·  ')}`);
  if (o.resolution === '720p' && o.duration >= 10) {
    console.log('    💡 提醒：素材最终只有 640×360，用 --resolution 480p 单价一样但 token 少 56%，效果几乎无差。');
  }
  return est;
}

function printPlan(segs, plans, o, models, schema) {
  console.log(`Ark base : ${ARK_BASE}`);
  console.log(`图模型   : ${models.image}   （来源：${models.source}）`);
  console.log(`视频模型 : ${models.video}`);
  console.log(`视频写法 : --schema ${schema}`);
  console.log(`并发     : ${o.concurrency}   轮询上限 ${(VIDEO_TIMEOUT_MS / 60000).toFixed(0)} 分钟/段   重试上限 ${HTTP_RETRIES}`);
  console.log(`待生成   : ${plans.length} 段（提示词包共 ${segs.length} 段）`);
  console.log(`每段     : 视频 ${o.resolution} / ${o.duration}s / 比例**跟随首帧**（带首帧时不能传 ratio，实测 400）${o.skipImage ? '；跳过图生图，用定妆图当首帧' : '；先图生图再图生视频'}`);
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
  console.log('本次预计 ¥' + (PRICE_IMAGE_YUAN + estimateVideoYuan(o.resolution, probeDuration)).toFixed(2) +
    `（图片 1 张 × ¥${PRICE_IMAGE_YUAN} + 视频 1 段 × ${probeDuration} 秒 ${o.resolution} ≈ ${estimateVideoTokens(o.resolution, probeDuration).toLocaleString()} tokens` +
    ` × ¥${PRICE_VIDEO_YUAN_PER_MTOKENS}/百万tokens）`);
  console.log('  ⚠ 估算，不是账单承诺；首选写法被拒时会再用另一种写法建一次任务（最多多 1 段）。');
  console.log('  ⚠ 注意：probe 是**先买图、再验视频模型**；视频模型 ID 不对的话那张图的钱照花。\n');

  // —— ① 图生图（已有探测静帧就复用：反复重探不会再重复买图）——
  let stillUri;
  const probeStill = ['png', 'jpg', 'jpeg', 'webp']
    .map((e) => path.join(PROBE_DIR, `probe-still.${e}`))
    .find((f) => fs.existsSync(f));
  if (probeStill !== undefined && !o.force) {
    const buf = fs.readFileSync(probeStill);
    const f = sniffImage(buf);
    stillUri = `data:${f.mime};base64,${buf.toString('base64')}`;
    console.log(`① 图生图 —— ↩ 复用上次探测的静帧（省 ¥${PRICE_IMAGE_YUAN}，重探不重复扣费）`);
    console.log(`   ${path.relative(ROOT, probeStill)}（${(buf.length / 1024).toFixed(0)} KB，${f.mime}）`);
    console.log('   想强制重出图：加 --force\n');
    result.image = 'reused';
  } else {
  console.log(`① 图生图（1 张，样本：${sample.name}）`);
  console.log(`   请求：POST ${ARK_BASE}/images/generations`);
  console.log(`   请求体：${JSON.stringify({ model: models.image, size: o.imageSize, response_format: 'b64_json', watermark: false, image: '[定妆图 base64 data URI]', prompt: brief(sample.img, 60) })}`);
  try {
    const { buf, raw, ext, mime } = await genImage(refUri, sample.img, { model: models.image, size: o.imageSize });
    const p = path.join(PROBE_DIR, `probe-still.${ext}`);
    fs.writeFileSync(p, buf);
    stillUri = `data:${mime};base64,${buf.toString('base64')}`;
    console.log(`   ✓ 成功，${(buf.length / 1024).toFixed(0)} KB → ${p}`);
    console.log(`   实际格式：${mime}（扩展名已按真实格式写，别按 .png 找）`);
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
      const pd = Math.min(5, o.duration);
      console.log(`  本次预计 ¥${(PRICE_IMAGE_YUAN + estimateVideoYuan(o.resolution, pd)).toFixed(2)}`
        + `（图片 1 张 × ¥${PRICE_IMAGE_YUAN} + 视频 1 段 × ${pd} 秒 ${o.resolution} ≈ ${estimateVideoTokens(o.resolution, pd).toLocaleString()} tokens`
        + ` × ¥${PRICE_VIDEO_YUAN_PER_MTOKENS}/百万tokens；估算，非账单承诺）`);
      // 最坏情况：首选写法被拒会再建一次任务
      console.log(`  最坏情况 ¥${(PRICE_IMAGE_YUAN + 2 * estimateVideoYuan(o.resolution, pd)).toFixed(2)}`
        + `（若首选写法被拒，会再用另一种写法建 1 次任务）`);
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
    console.log('建议顺序（省钱版）：');
    console.log('  node tools/gen-api.mjs --probe --go                                # ① 验模型与写法');
    console.log('  node tools/gen-api.mjs --limit 2 --resolution 480p --duration 5 --go  # ② 跑 2 段验收（约 ¥9）');
    console.log('  node tools/gen-api.mjs --all --resolution 480p --duration 5 --go   # ③ 全量（约 ¥44）');
    console.log('  ⚠ 不要用默认的 720p/10s 全量：那是 ¥180 级，而且素材最终只有 640×360，根本用不上。');
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

  // —— 预算闸门：预估超阈值时必须显式加 --yes ——
  // 打印估价和真正开跑之间没有停顿，`--all --go` 很容易在人没细看时烧掉几百元。
  const est = estimate(plans, o);
  const budgetGuard = Number(process.env.BUDGET_GUARD_YUAN ?? BUDGET_GUARD_YUAN);
  if (budgetGuard > 0 && est.yuan > budgetGuard && !o.yes) {
    const willVideo = plans.filter((p) => p.needVideo).length;
    const willImage = plans.filter((p) => p.needVideo && p.needImage).length;
    console.error(`\n✗ 本次预估 ¥${est.yuan.toFixed(2)}，超过预算闸门 ¥${budgetGuard} —— **已中止，一个请求都没发**。`);
    console.error('  确认要花这笔钱，就在原命令末尾再加一个 --yes：');
    console.error(`    node tools/gen-api.mjs ${o.all ? '--all' : `--limit ${o.limit}`} --resolution ${o.resolution} --duration ${o.duration} --go --yes`);
    console.error(`  （闸门值可用 $env:BUDGET_GUARD_YUAN 改，设 0 关闭）`);
    if (o.resolution !== '480p' || o.duration > 5) {
      const cheap = willVideo * estimateVideoYuan('480p', 5) + willImage * PRICE_IMAGE_YUAN;
      console.error(`\n  💡 便宜得多的等价方案：--resolution 480p --duration 5 → 同样 ${willVideo} 段约 **¥${cheap.toFixed(2)}**`);
      console.error('     素材最终只有 640×360，480p 完全够；720p/10 秒 是纯浪费。');
    }
    process.exitCode = 1;
    return;
  }
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
      const { buf, raw, ext, mime } = await genImage(refUri, segs.find((s) => s.name === p.name).img, {
        model: models.image, size: o.imageSize,
      });
      // 按**真实格式**落盘：Ark 可能返回 JPEG，硬写 .png 会让后缀与字节不符，
      // 而且下一步 data URI 的 MIME 也会错。sniffImage 已从 output_format / 魔数判定。
      const stillPath = `${p.stillBase}.${ext}`;
      fs.writeFileSync(stillPath, buf);
      stillUri = `data:${mime};base64,${buf.toString('base64')}`;
      console.log(`${tag} … 出图 ${(buf.length / 1024).toFixed(0)} KB → ${path.relative(ROOT, stillPath)}（格式 ${mime}，响应字段 ${Object.keys(raw.data?.[0] ?? {}).join(',')}）`);
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

// ============================================================================
// --self-test：用假 fetch 把「花钱闸门」全测一遍（零网络、零花费）
// ============================================================================
// 每个用例都是**另起一个子进程**跑本脚本，并强制 GENAPI_STUB_FETCH=1 ——
// 子进程里的 fetch 是假的，所以哪怕用例带 --go 也一个真实请求都发不出去。
// 断言两件事：① 该拒绝的必须拒绝且 **0 次网络调用**；② 真跑路径发出的请求体
// 必须符合实测出来的接口约束（这正是 camera_fixed / ratio 那两个 bug 的回归测试）。
async function runSelfTest() {
  const { spawnSync } = await import('node:child_process');
  const self = fileURLToPath(import.meta.url);
  const tmp = path.join(ROOT, 'out', '_selftest');
  fs.mkdirSync(tmp, { recursive: true });

  let failed = 0;
  const pass = (m) => console.log(`  \u2713 ${m}`);
  const fail = (m) => { failed++; console.log(`  \u2717 ${m}`); };

  const cases = [
    {
      name: '不给 --go：只空跑，0 次网络调用',
      args: ['--limit', '1', '--resolution', '480p', '--duration', '5'],
      expectExit: 0, expectCalls: 0,
    },
    {
      name: '给了 --go 但没给 --all/--limit/--only：必须拒绝，0 次网络调用',
      args: ['--go'],
      expectExit: 1, expectCalls: 0,
    },
    {
      name: '超预算闸门（默认 720p/10 秒全量）：必须拒绝 + 0 次网络调用',
      args: ['--all', '--go'],
      expectExit: 1, expectCalls: 0,
    },
    {
      name: '真跑路径（假 fetch）：出图 → 建任务 → 轮询 → 下载，且请求体符合接口约束',
      args: ['--only', '写代码', '--force',
        '--out-raw', path.join(tmp, 'raw'), '--stills', path.join(tmp, 'stills'),
        '--resolution', '480p', '--duration', '5', '--go'],
      expectExit: 0, minCalls: 4,
      check: (log) => {
        const problems = [];
        if (!/POST .*\/images\/generations/.test(log)) problems.push('没有发图生图请求');
        if (!/POST .*\/contents\/generations\/tasks/.test(log)) problems.push('没有建视频任务');
        if (!/GET .*\/contents\/generations\/tasks\/stub-task-1/.test(log)) problems.push('没有轮询任务');
        const post = log.split('---').find((b) => b.includes('POST') && b.includes('/contents/generations/tasks'));
        if (post) {
          // —— 接口约束的回归测试（这三条都是实测踩出来的）——
          if (post.includes('camera_fixed')) problems.push('建任务请求里出现了 camera_fixed（seedance-2-5 的 i2v 会 400）');
          if (/"ratio"/.test(post)) problems.push('带首帧时不该传 ratio（会 400 TaskTypeConstraint）');
          if (!post.includes('"generate_audio":false')) problems.push('没有显式 generate_audio:false（不传时模型默认合成音频，白花钱）');
        }
        return problems;
      },
    },
  ];

  console.log('\n=== gen-api 自测（全部走假 fetch，零网络零花费）===');
  for (const c of cases) {
    const logFile = path.join(tmp, `stub-${Math.random().toString(36).slice(2, 8)}.log`);
    const env = { ...process.env, GENAPI_STUB_FETCH: '1', GENAPI_STUB_LOG: logFile, ARK_API_KEY: 'stub-not-a-real-key' };
    delete env.BUDGET_GUARD_YUAN; // 用脚本内的默认闸门值
    const r = spawnSync(process.execPath, [self, ...c.args], { cwd: ROOT, env, stdio: 'ignore' });
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const calls = (log.match(/^(GET|POST) /gm) ?? []).length;
    const problems = [];
    if (r.status !== c.expectExit) problems.push(`退出码 ${r.status}，期望 ${c.expectExit}`);
    if (c.expectCalls !== undefined && calls !== c.expectCalls) problems.push(`网络调用 ${calls} 次，期望 ${c.expectCalls} 次`);
    if (c.minCalls !== undefined && calls < c.minCalls) problems.push(`网络调用只有 ${calls} 次，至少应有 ${c.minCalls} 次`);
    if (c.check) problems.push(...c.check(log));
    if (problems.length === 0) pass(c.name);
    else fail(`${c.name} → ${problems.join('；')}`);
    fs.rmSync(logFile, { force: true });
  }

  console.log('');
  if (failed === 0) {
    console.log('结论：花钱闸门与接口参数约束全部符合预期。\n');
    process.exit(0);
  } else {
    console.log(`结论：${failed} 个用例不符合预期。\n`);
    process.exit(1);
  }
}

const isMain =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  if (process.argv.includes('--self-test')) {
    runSelfTest().catch((e) => {
      console.error(`\n✗ 自测本身崩了：${e.message}`);
      process.exitCode = 1;
    });
  } else {
    main().catch((e) => {
      console.error(`\n✗ ${e.message}`);
      if (e.raw) console.error(`原始响应：${e.raw}`);
      process.exitCode = 1;
    });
  }
}
