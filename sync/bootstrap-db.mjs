// ============================================================
//  离线创建账号：直接往 D1 写初始数据，完全不经过 HTTP
//
//  为什么需要它：
//   1. workers.dev 在国内被 SNI 阻断，HTTP 方式的 bootstrap 根本走不通
//   2. 走 wrangler/Cloudflare API 的通道是通的，所以可以用它来写库
//   3. 顺带消掉了「SETUP_TOKEN 忘了 / 响应丢了」这类问题
//
//  用法：node bootstrap-db.mjs            写入本地 D1（测试用）
//        node bootstrap-db.mjs --remote   写入线上 D1
// ============================================================

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { pbkdf2Hex, sha256Hex, randomHex, makePassword, makeBackupCode, normalizeCode } from './src/crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REMOTE = process.argv.includes('--remote');
const DB_NAME = 'homework-sync';
const USERNAME = 'owner';

const c = {
  b: s => `\x1b[1m${s}\x1b[0m`,
  g: s => `\x1b[32m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`,
  r: s => `\x1b[31m${s}\x1b[0m`,
  d: s => `\x1b[90m${s}\x1b[0m`
};

// ---------- 1. 先确认库里还没有账号 ----------
console.log(c.b(`检查 ${REMOTE ? '线上' : '本地'} 数据库…`));
function query(sql) {
  const args = ['--yes', 'wrangler', 'd1', 'execute', DB_NAME, '--json', '--command', sql];
  if (REMOTE) args.push('--remote');
  const out = execSync('npx ' + args.map(a => (a.includes(' ') ? '"' + a.replace(/"/g, '\\"') + '"' : a)).join(' '), {
    cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  const start = out.indexOf('[');
  return JSON.parse(out.slice(start));
}

let existing;
try {
  existing = query('SELECT COUNT(*) AS n FROM users');
} catch (e) {
  console.error(c.r('✗ 查询失败：' + (e.stderr || e.message)));
  process.exit(1);
}
const n = existing[0]?.results?.[0]?.n ?? 0;
if (n > 0) {
  console.log(c.y(`\n⚠️ 数据库里已有 ${n} 个账号。`));
  console.log(c.y('若要重发凭据，请先清空（会丢失同步数据）：'));
  console.log(c.d(`  npx wrangler d1 execute ${DB_NAME} ${REMOTE ? '--remote ' : ''}--command "DELETE FROM users; DELETE FROM devices; DELETE FROM backup_codes;"`));
  process.exit(2);
}
console.log(c.g('✓ 尚无账号，可以创建'));

// ---------- 2. 生成凭据并算哈希 ----------
console.log(c.b('\n生成凭据（口令 → PBKDF2 哈希，备用码 → SHA-256）…'));
const userId = randomHex(16);
const password = makePassword();
const salt = randomHex(16);
const ITER = 150000;
const pwdHash = await pbkdf2Hex(password, salt, ITER);

const codes = [];
for (let i = 0; i < 10; i++) codes.push(makeBackupCode());
const codeHashes = [];
for (const code of codes) codeHashes.push(await sha256Hex(normalizeCode(code)));

const now = Date.now();
const esc = s => String(s).replace(/'/g, "''");
const statements = [
  `INSERT INTO users (id, username, pwd_salt, pwd_hash, pwd_iter, created_at) VALUES ('${userId}','${esc(USERNAME)}','${salt}','${pwdHash}',${ITER},${now});`,
  ...codeHashes.map(h => `INSERT INTO backup_codes (code_hash, user_id, created_at) VALUES ('${h}','${userId}',${now});`)
];

const sqlPath = path.join(here, '.bootstrap.sql');
fs.writeFileSync(sqlPath, statements.join('\n') + '\n', 'utf8');
console.log(c.d(`  SQL 已写入 ${sqlPath}（含哈希，不含明文）`));

// ---------- 3. 执行 ----------
console.log(c.b('\n写入数据库…'));
try {
  const args = ['--yes', 'wrangler', 'd1', 'execute', DB_NAME, `--file=${sqlPath}`];
  if (REMOTE) args.push('--remote');
  const out = execSync('npx ' + args.join(' '), { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const ok = /success":\s*true/.test(out) || /Executed/i.test(out);
  if (!ok) { console.log(c.r('✗ 写入结果异常：')); console.log(out.slice(-800)); process.exit(1); }
  console.log(c.g(`✓ 已写入 ${statements.length} 条记录（1 个用户 + 10 个备用码）`));
} catch (e) {
  console.error(c.r('✗ 写入失败：\n' + (e.stderr || e.stdout || e.message)));
  process.exit(1);
} finally {
  // SQL 里只有哈希，但没必要留着
  try { fs.unlinkSync(sqlPath); } catch (e) {}
}

// ---------- 4. 落盘凭据 ----------
const credPath = path.join(os.homedir(), 'Desktop', '作业同步凭据.txt');
const content = [
  '【假期作业记录 · 同步凭据】',
  '生成时间：' + new Date().toLocaleString('zh-CN'),
  '类型：' + (REMOTE ? '线上账号（Cloudflare D1）' : '本地测试账号'),
  '',
  '登录口令（相当于主密码）：',
  password,
  '',
  '一次性备用码（换设备时用，每个只能用一次）：',
  ...codes.map((code, i) => `  ${String(i + 1).padStart(2, ' ')}. ${code}`),
  '',
  '服务端只存哈希，丢了无法找回。请存进密码管理器后删除本文件。',
  ''
].join('\n');
fs.writeFileSync(credPath, content, 'utf8');

console.log(c.g('\n✓ 凭据已写入：' + credPath));
console.log(c.b('\n口令：') + c.b(password));
console.log(c.b('备用码：'));
codes.forEach((x, i) => console.log(`  ${String(i + 1).padStart(2)}. ${x}`));
console.log(c.y('\n请立即保存到密码管理器，然后删除桌面上的凭据文件。'));
