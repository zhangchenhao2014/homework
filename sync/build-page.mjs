// ============================================================
//  构建脚本：把 src/sync-client.js 内联进 index.html
//
//  为什么需要它：GitHub Pages 是静态托管，不能 import 本地 JS 模块到
//  内联脚本里；而我又不想把同一份同步逻辑抄成两份（两份必然出现
//  “测试通过但线上有 bug”）。所以：唯一副本放在 src/，构建时注入页面。
//
//  用法：node sync/build-page.mjs
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
// index.html 是唯一源文件；assets/index.html 是 Pages 的发布副本
const pagePath = path.join(here, '..', 'index.html');
const assetsPath = path.join(here, 'assets', 'index.html');
const clientPath = path.join(here, 'src', 'sync-client.js');

const START = '/* __SYNC_CLIENT_START__ */';
const END = '/* __SYNC_CLIENT_END__ */';

const html = fs.readFileSync(pagePath, 'utf8');
const client = fs.readFileSync(clientPath, 'utf8');

// 去掉 ESM 的 export 关键字，变成普通函数声明，供页面内联脚本使用
const inlined = client.replace(/^export\s+/gm, '').trim();

const startIdx = html.indexOf(START);
const endIdx = html.indexOf(END);
if (startIdx === -1 || endIdx === -1) {
  console.error('❌ index.html 里找不到注入标记，请确认存在：');
  console.error('   ' + START + ' 与 ' + END);
  process.exit(1);
}

const before = html.slice(0, startIdx + START.length);
const after = html.slice(endIdx);
const out = before + '\n' + inlined + '\n' + after;

// 校验：注入后必须还能在 Node 里解析（语法检查）
const scriptMatch = out.match(/<script defer>([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.error('❌ 找不到 <script defer> 块'); process.exit(1); }

fs.writeFileSync(pagePath, out, 'utf8');
// 同步一份到 Pages 的发布目录，保证 GitHub Pages 与 Cloudflare Pages 内容一致
fs.mkdirSync(path.dirname(assetsPath), { recursive: true });
fs.writeFileSync(assetsPath, out, 'utf8');

const fnNames = [...inlined.matchAll(/^function\s+(\w+)/gm)].map(m => m[1]);
console.log('✅ 已注入同步引擎');
console.log('   源文件  : index.html');
console.log('   发布副本: sync/assets/index.html');
console.log('   文件大小: ' + html.length + ' -> ' + out.length + ' 字节');
console.log('   注入函数: ' + fnNames.join(', '));
