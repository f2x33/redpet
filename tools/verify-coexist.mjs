// ============================================================================
// verify-coexist.mjs —— 与 dsh-pet 的"顶层词法声明"共存回归测试
// ============================================================================
// 【为什么需要这个测试】
//   2026-10-05 的故障：本包的客户端插件在浏览器里永远 "import failed"。
//   根因不是 CSS 类名/locale 键/槽位键（那些上一轮都审计过了），而是
//   **顶层词法声明名**：DSH 把同一批的多个插件 bundle 拼成一个 classic script
//   下发，classic script 的顶层 const/let/function 落在全局词法作用域。
//   本包是 dsh-pet 0.3.5 构建产物的分叉，两份 bundle 顶层声明**同名**
//   （实测 175 个里撞 174 个），于是后加载的那个在**解析期**就抛
//   `SyntaxError: Identifier 'xxx' has already been declared`，什么都注册不上。
//
//   修法见 tools/_wrap-iife.mjs（把整个 bundle 包进 IIFE → 全部变函数作用域）。
//   本测试就是防它退化：在同一个全局作用域里按两种顺序各跑一遍两个 bundle，
//   必须**两种顺序都能注册成功**。
//
// 【判据】SyntaxError 是解析期错误，所以只要用 vm 在同一个 context 里依次
//   执行两个脚本、两次都拿到各自的注册调用，就说明没有全局词法冲突。
//
// 用法：node tools/verify-coexist.mjs
//   退出码 0 = 通过；1 = 失败；0（带跳过提示）= 本机没装 dsh-pet
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OURS = path.join(ROOT, 'lib', 'client.js');

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '';
const DSH_HOME = process.env.DSH_HOME ?? path.join(HOME, '.dsh');
const PEER_CANDIDATES = [
  path.join(DSH_HOME, 'profiles', 'web', 'node_modules', 'dsh-pet', 'lib', 'client.js'),
  path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-pet', 'lib', 'client.js'),
];
const peer = PEER_CANDIDATES.find((p) => fs.existsSync(p));

if (!fs.existsSync(OURS)) {
  console.error(`❌ 找不到本包客户端产物：${OURS}`);
  process.exit(1);
}
if (peer === undefined) {
  console.log('⏭  本机没装 dsh-pet，跳过共存测试（这不是失败）。');
  console.log('   找过：\n     ' + PEER_CANDIDATES.join('\n     '));
  process.exit(0);
}

/** 足够宽松的浏览器桩：让 bundle 的顶层代码跑完，不因缺 API 而假失败。 */
function makeSandbox(registered) {
  const noop = () => {};
  const el = () => new Proxy({ style: {}, classList: { add: noop, remove: noop, contains: () => false }, dataset: {} }, { get: (t, p) => (p in t ? t[p] : noop) });
  const doc = new Proxy({
    hasFocus: () => true, hidden: false, visibilityState: 'visible', readyState: 'complete',
    cookie: '', title: '', body: el(), head: el(), documentElement: el(),
    createElement: el, createElementNS: el, getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, removeEventListener: noop, appendChild: noop,
  }, { get: (t, p) => (p in t ? t[p] : noop) });
  const win = new Proxy({
    document: doc,
    __ModuleLoader__: { load: (m) => registered.push(m?.id), create() { return this; } },
    addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' },
    navigator: { userAgent: 'node' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    requestAnimationFrame: (fn) => setTimeout(fn, 16), cancelAnimationFrame: clearTimeout,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
    console, performance: { now: () => Date.now() },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
  }, { get: (t, p) => (p in t ? t[p] : noop) });
  const sb = {
    window: win, self: win, document: doc, navigator: win.navigator, location: win.location,
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: clearTimeout,
    fetch: win.fetch, performance: win.performance, matchMedia: win.matchMedia,
    getComputedStyle: win.getComputedStyle, localStorage: win.localStorage,
    MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
    URL, URLSearchParams, TextEncoder, TextDecoder, Math, JSON, Object, Array, String, Number,
    Boolean, Date, RegExp, Error, TypeError, Map, Set, WeakMap, WeakSet, Promise, Symbol,
    Proxy, Reflect, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  };
  sb.globalThis = sb;
  return sb;
}

const oursId = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name;

/** 在一个全新的全局作用域里按给定顺序执行两个 bundle，返回 [注册到的 id 列表, 错误]。 */
function runOrder(files) {
  const registered = [];
  const sb = makeSandbox(registered);
  vm.createContext(sb);
  for (const f of files) {
    try {
      vm.runInContext(fs.readFileSync(f, 'utf8'), sb, { filename: path.basename(f) });
    } catch (e) {
      return { registered, error: `${path.basename(path.dirname(path.dirname(f)))}: ${e.constructor.name}: ${e.message}` };
    }
  }
  return { registered, error: null };
}

console.log(`本包  : ${OURS}  (id=${oursId})`);
console.log(`dsh-pet: ${peer}\n`);

let failed = false;
const orders = [
  ['dsh-pet 先、本包后', [peer, OURS]],
  ['本包先、dsh-pet 后', [OURS, peer]],
];

for (const [label, files] of orders) {
  const { registered, error } = runOrder(files);
  const ok = error === null && registered.includes('dsh-pet') && registered.includes(oursId);
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  console.log(`    注册结果: ${registered.join(', ') || '(无)'}`);
  if (error !== null) console.log(`    抛错: ${error}`);
  if (!ok) failed = true;
}

console.log('');
if (failed) {
  console.log('❌ 共存测试失败：两个 bundle 在同一个全局作用域下不能同时注册。');
  console.log('   多半是本包 lib/client.js 的 IIFE 包裹被重新构建覆盖了 ——');
  console.log('   重跑：node tools/_wrap-iife.mjs');
  process.exit(1);
}
console.log('✅ 通过：两种加载顺序下都能正常注册，不存在顶层词法声明冲突。');
