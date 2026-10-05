// ============================================================================
// _wrap-iife.mjs —— 修掉 "dsh-redpet: import failed" 的根因
// ============================================================================
// 【故障】2026-10-05：浏览器里 dsh-redpet 客户端插件永远 import 失败，
//   而同一批里的 dsh-pet 正常。报错只有一句 "see console for the import error"。
//
// 【根因】DSH 把同一批（batch）的多个插件 bundle **拼接成一个 classic script** 下发
//   （见 dsh-client-modules 的 buildComboScript）。classic script 的顶层
//   `const` / `let` / `function` 落在**全局词法作用域**里。
//
//   而本包是从 dsh-pet 0.3.5 的**构建产物**分叉改名的：两份 bundle 的顶层声明
//   **同名**（实测 175 个里撞 174 个，例如 ACCEL_REF / BURST_COLORS / notifyEnabled /
//   pick / refreshVisible ...）。
//
//   批内顺序是 dsh-pet 在前、dsh-redpet 在后，于是：
//     ① dsh-pet 的回落脚本先执行成功 → 全局占掉那些名字
//     ② 轮到 dsh-redpet 的脚本时，**解析期**就抛
//        `SyntaxError: Identifier 'xxx' has already been declared`
//     ③ 解析失败 → 什么都没注册；但 <script> 的 load 事件照样触发，
//        所以不算 transport 失败；启动路径 ClientEntries.start() 又只调
//        loader.create()、不走 modules.import()，于是错误不进 importErrors
//        → 前端只能显示 "see console for the import error"
//
//   注意：上一轮"共存审计"对比的是**字符串字面量**（CSS 类名 / locale 键 / 槽位键），
//   没覆盖**顶层词法声明名**，所以漏掉了这一整类冲突。改名（dsh-redteam-pet →
//   dsh-redpet）同样无用——冲突的是声明名，不是标识前缀。
//
// 【修法】把整个客户端 bundle 原样包进一个 IIFE：
//     所有顶层声明变成**函数作用域**，不再进入全局词法环境。
//     · 与 dsh-pet（不包裹）混在同一个 combo 里也能正常解析
//     · 单独回落加载时，无论先后顺序都安全
//     · 契约不变：仍然是一次 window.__ModuleLoader__.load({id, factory})
//     · 不加 "use strict"：避免改变原产物的语义（this 绑定 / 静默失败行为）
//     · 前导 `;` 独占一行：防 ASI，也防被上一个 bundle 末尾的 `//` 行注释吞掉
//
// 【为什么要脚本而不是手改】本包没有 src/，lib/*.js 是构建产物。
//   将来若重新构建/再次改名，重跑本脚本即可（幂等，已包裹会跳过）。
//
// 用法：
//   node tools/_wrap-iife.mjs --dry
//   node tools/_wrap-iife.mjs
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'lib', 'client.js');
const DRY = process.argv.includes('--dry');

const src = fs.readFileSync(TARGET, 'utf8');

// 自愈：如果已经被本脚本包裹过（含早期写坏注释的版本），先把包裹剥掉再重新包。
const HEAD_RE = /^\/\* dsh-redpet: IIFE 包裹[\s\S]*?\n;\(function\(\)\{\n/;
const TAIL_RE = /\n\}\)\(\);\n$/;
let body = src;
let stripped = false;
if (HEAD_RE.test(body)) { body = body.replace(HEAD_RE, ''); stripped = true; }
if (TAIL_RE.test(body)) { body = body.replace(TAIL_RE, ''); stripped = true; }
if (stripped) console.log('已剥掉旧的包裹，重新包裹。');

// 安全检查：顶层语句在第 0 列（产物是带缩进的格式化代码），
// 所以只认列 0 的 await/return —— 它们会让普通 IIFE 包裹失效。
const bad = body.match(/^(?:await|return)\b.*$/m);
if (bad !== null) {
  console.error('❌ 发现顶层 ' + bad[0].slice(0, 40) + '，不能用普通 IIFE 包裹。');
  process.exit(1);
}

const HEAD = `/* dsh-redpet: IIFE 包裹 —— 见 tools/_wrap-iife.mjs 的根因说明 */
;(function(){
`;
const TAIL = `
})();
`;

const out = HEAD + body + TAIL;

console.log(`原始长度 : ${src.length}`);
console.log(`包裹后   : ${out.length}`);
console.log(`目标文件 : ${TARGET}`);

if (DRY) {
  console.log('\n（--dry：没有写文件）');
  console.log('\n--- 包裹后的头部 ---');
  console.log(out.slice(0, 260));
  console.log('\n--- 包裹后的尾部 ---');
  console.log(out.slice(-160));
} else {
  fs.writeFileSync(TARGET, out, 'utf8');
  console.log('\n✅ 已写入。');
}
