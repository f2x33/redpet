// 一次性改名脚本：把从 dsh-pet@0.3.5 复制来的构建产物里所有 `dsh-pet` 标识改成 `dsh-redteam-pet`。
// 目的：新插件与 dsh-pet 完全解耦（路由前缀、用户数据目录、CSS 类名、日志前缀、settings 槽位键）。
// 只跑一次，跑完可以删。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FROM = 'dsh-pet';
const TO = 'dsh-redteam-pet';

// 目标：构建产物 + 素材配置 + 运行时（桌面模式）
const TARGETS = [
  'lib/index.js',
  'lib/client.js',
  'assets/config.jsonc',
  'cordis.patch.yml',
  'runtime/electron-helper/package.json',
  'runtime/electron-helper/shared-core.js',
  'runtime/electron-helper/constants.js',
  'runtime/electron-helper/events.js',
  'runtime/electron-helper/host-liveness.js',
  'runtime/electron-helper/index.html',
  'runtime/electron-helper/main.js',
  'runtime/electron-helper/pointer-target.js',
  'runtime/electron-helper/preload.js',
  'runtime/electron-helper/renderer.js',
  'runtime/electron-helper/sprite.js',
];

let totalHits = 0;
for (const rel of TARGETS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.log(`  skip (missing): ${rel}`);
    continue;
  }
  const before = fs.readFileSync(file, 'utf8');
  const hits = before.split(FROM).length - 1;
  if (hits === 0) {
    console.log(`  no-op: ${rel}`);
    continue;
  }
  // 保护：不能误伤 @deepseek-ai/... 之类；FROM 是 'dsh-pet'，本身不会出现在这些名字里。
  const after = before.split(FROM).join(TO);
  fs.writeFileSync(file, after, 'utf8');
  totalHits += hits;
  console.log(`  ${String(hits).padStart(4)} hits  ${rel}`);
}
console.log(`\n${FROM} -> ${TO}：共改 ${totalHits} 处`);
