#!/usr/bin/env node
// ============================================================
//  账号管理（管理员在本地终端执行）
//
//  用途：由你（管理员）手工为别人创建账号并分配口令，
//        对方拿到「账号 + 口令」后在网页登录框输入即可。
//
//  安全前提：公网上没有任何注册/重置入口（/api/bootstrap 与
//  /api/reset-credentials 在未配置 SETUP_TOKEN 时一律 403）。
//  建号、改口令、删号只能通过本脚本 + 你的 Cloudflare 权限完成。
//
//  用法：
//    node admin.mjs create <账号> [口令]     新建账号（不给口令则随机生成）
//    node admin.mjs reset  <账号> [口令]     重设口令（旧口令/备用码/所有设备全部失效）
//    node admin.mjs list                     列出账号、作业数、数据量、设备数、最后同步
//    node admin.mjs delete <账号>            删除账号（连带其设备、备用码、作业数据）
//
//  可选参数：
//    --local        操作本地 D1（默认操作线上）
//    --out <路径>   把凭据写到指定文件（create/reset）
//    --no-file      不写凭据文件，只打印到终端
//    --yes          删除时不询问
// ============================================================

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  pbkdf2Hex, sha256Hex, randomHex, makePassword, makeBackupCode,
  normalizeCode, PBKDF2_ITERATIONS
} from './src/crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = 'homework-sync';

const c = {
  b: s => `\x1b[1m${s}\x1b[0m`,
  g: s => `\x1b[32m${s}\x1b[0m`,
  r: s => `\x1b[31m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`,
  d: s => `\x1b[90m${s}\x1b[0m`
};

// ------------------------------------------------------------
// SQL 基础
// ------------------------------------------------------------

/** 把字符串转成 SQL 字面量（单引号翻倍），防止注入 */
export function sqlLit(v) {
  return "'" + String(v == null ? '' : v).replace(/'/g, "''") + "'";
}

/** 生成一条 INSERT users 语句 */
export function buildInsertUser({ id, username, salt, hash, iter, now }) {
  return `INSERT INTO users (id, username, pwd_salt, pwd_hash, pwd_iter, created_at) ` +
    `VALUES (${sqlLit(id)}, ${sqlLit(username)}, ${sqlLit(salt)}, ${sqlLit(hash)}, ` +
    `${Number(iter)}, ${Number(now)});`;
}

/** 生成 10 条 INSERT backup_codes 语句 */
export function buildInsertCodes({ codeHashes, userId, now }) {
  return codeHashes.map(h =>
    `INSERT INTO backup_codes (code_hash, user_id, created_at) ` +
    `VALUES (${sqlLit(h)}, ${sqlLit(userId)}, ${Number(now)});`
  ).join('\n');
}

/** 生成 UPDATE users 口令语句 */
export function buildUpdatePassword({ userId, salt, hash, iter }) {
  return `UPDATE users SET pwd_salt = ${sqlLit(salt)}, pwd_hash = ${sqlLit(hash)}, ` +
    `pwd_iter = ${Number(iter)} WHERE id = ${sqlLit(userId)};`;
}

/**
 * 清除某账号的「认证类」派生数据：备用码 + 设备令牌。
 * 重置口令时用它 —— **绝不能删 sync_data**，那是用户的作业记录。
 * 顺序：子表在前（都是指向 users 的外键）
 */
export function buildClearAuthStatements(userId) {
  const id = sqlLit(userId);
  return [
    `DELETE FROM backup_codes WHERE user_id = ${id};`,
    `DELETE FROM devices WHERE user_id = ${id};`
  ].join('\n');
}

/** 生成删除账号的完整语句（注意：users 必须最后删，否则外键约束失败） */
export function buildDeleteUser(userId) {
  const id = sqlLit(userId);
  return [
    `DELETE FROM backup_codes WHERE user_id = ${id};`,
    `DELETE FROM devices WHERE user_id = ${id};`,
    `DELETE FROM sync_data WHERE user_id = ${id};`,
    `DELETE FROM users WHERE id = ${id};`
  ].join('\n');
}

/** 列表查询 */
export function buildListSql() {
  return `
SELECT
  u.username                                        AS username,
  u.created_at                                      AS created_at,
  COALESCE(json_array_length(json_extract(s.data, '$.tasks')), 0)    AS tasks,
  COALESCE(json_array_length(json_extract(s.data, '$.sessions')), 0) AS sessions,
  COALESCE(LENGTH(s.data), 0)                       AS bytes,
  s.updated_at                                      AS synced_at,
  (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.revoked = 0) AS devices,
  (SELECT COUNT(*) FROM backup_codes b WHERE b.user_id = u.id AND b.used_at IS NULL) AS codes_left
FROM users u
LEFT JOIN sync_data s ON s.user_id = u.id
ORDER BY u.created_at ASC;`.trim();
}

// ------------------------------------------------------------
// 执行 wrangler
// ------------------------------------------------------------

/**
 * 调 wrangler。
 * Windows 上 npx 是 .cmd，必须经 shell 才能执行。
 * 这里不用「shell:true + 参数数组」（会触发 DEP0190 警告），
 * 而是自己拼一条命令字符串：只有含空格的参数才加引号，命令名不加
 * （给 npx 加引号会破坏它在 PATH 里的解析）。
 * 参与拼接的参数都是脚本内生成的字面量或随机文件名，不含用户输入。
 */
function q(s) {
  return '"' + String(s) + '"';
}

function buildCmd(args, json) {
  const parts = ['npx', '--yes', 'wrangler', 'd1', 'execute', DB, '-y', ...args];
  if (json) parts.push('--json');
  return parts
    .map(a => (String(a).includes(' ') ? q(a) : String(a)))
    .join(' ');
}

function wrangler(args, { json = false } = {}) {
  const cmd = buildCmd(args, json);
  const res = spawnSync(cmd, {
    cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true
  });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

/** 临时 SQL 文件放在脚本目录下（文件名纯 ASCII，避免路径里的中文/空格干扰） */
function tmpSqlFile() {
  return path.join(here, `.admin-${randomHex(5)}.sql`);
}

/** 执行一段 SQL（用临时文件，避免命令行转义问题） */
function execSql(sqlText, { remote }) {
  const tmp = tmpSqlFile();
  fs.writeFileSync(tmp, sqlText, 'utf8');
  try {
    const args = [`--file=${tmp}`];
    if (remote) args.push('--remote');
    const r = wrangler(args);
    const ok = /"success":\s*true/i.test(r.out) || /Executed/i.test(r.out);
    if (r.code !== 0 || !ok) {
      const err = new Error('SQL 执行失败：\n' + r.out.trim().split('\n').slice(-14).join('\n'));
      throw err;
    }
    return r.out;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

/**
 * 从 wrangler 的输出里提取 JSON。
 * 不能简单找第一个 '[' —— 输出里可能混进 Node 警告（形如
 * "node:internal/modules/[as runMain]"），会误判。
 * 这里逐个 '[' 尝试解析，取第一个能解析成功且像 D1 结果的对象。
 */
export function extractJson(text) {
  const clean = String(text)
    .replace(/\x1b\[[0-9;]*m/g, '')          // 去掉颜色
    .replace(/\r/g, '');
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== '[') continue;
    try {
      const parsed = JSON.parse(clean.slice(i));
      if (Array.isArray(parsed)) return parsed;
    } catch (e) { /* 这个 '[' 不是 JSON 起点，继续找 */ }
  }
  return null;
}

/**
 * 查询并返回结果行。
 * 注意：必须用 --command 而不是 --file —— 实测 --file 配合 --remote 时
 * wrangler 只返回执行汇总（"Total queries executed" 之类），拿不到数据行。
 * 所以这里把 SQL 压成单行再通过 --command 传入（只读 SELECT，不含写操作）。
 */
function queryRows(sqlText, { remote }) {
  const oneLine = String(sqlText).replace(/\s+/g, ' ').trim().replace(/;+\s*$/, '');
  const args = [`--command=${oneLine}`, '--json'];
  if (remote) args.push('--remote');
  const r = wrangler(args);
  const parsed = extractJson(r.out);
  if (!parsed) throw new Error('查询没有返回可解析的 JSON：\n' + r.out.trim().slice(-800));
  // D1 --json 返回 [{ results: [...] }]
  if (parsed[0] && Array.isArray(parsed[0].results)) return parsed[0].results;
  return [];
}

// ------------------------------------------------------------
// 业务动作
// ------------------------------------------------------------

async function makeCredentialPayload(password) {
  const pwd = password || makePassword();
  const salt = randomHex(16);
  const hash = await pbkdf2Hex(pwd, salt, PBKDF2_ITERATIONS);
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push(makeBackupCode());
  const codeHashes = [];
  for (const code of codes) codeHashes.push(await sha256Hex(normalizeCode(code)));
  return { pwd, salt, hash, codes, codeHashes };
}

function findUser(username, opts) {
  const rows = queryRows(
    `SELECT id, username, created_at FROM users WHERE username = ${sqlLit(username)};`,
    opts
  );
  return rows[0] || null;
}

function writeCredFile(username, password, codes, siteUrl, outPath) {
  const lines = [
    `【假期作业记录 · 账号凭据】`,
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    `账号：${username}`,
    ``,
    `登录口令：`,
    password,
    ``,
    `一次性备用码（换设备时用，每个只能用一次）：`,
    ...codes.map((x, i) => `  ${String(i + 1).padStart(2, ' ')}. ${x}`),
    ``,
    `怎么登录：`,
    `  1. 打开 ${siteUrl}`,
    `  2. 右上角「账号」→ 填账号 + 口令 → 登录`,
    `  3. 换手机时用「一次性备用码」登录（不用记账号）`,
    ``,
    `提示：服务端只存哈希，忘记口令只能让管理员重置。`,
    ``
  ];
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
}

async function cmdCreate(username, password, opts) {
  if (!username) throw new Error('用法：node admin.mjs create <账号> [口令]');
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5.-]{1,32}$/.test(username)) {
    throw new Error('账号名只能用字母/数字/下划线/汉字/点/横线，长度 1-32');
  }
  if (findUser(username, opts)) {
    throw new Error(`账号「${username}」已存在。改口令请用：node admin.mjs reset ${username}`);
  }

  const { pwd, salt, hash, codes, codeHashes } = await makeCredentialPayload(password);
  const userId = randomHex(16);
  const now = Date.now();

  const sql = [
    buildInsertUser({ id: userId, username, salt, hash, iter: PBKDF2_ITERATIONS, now }),
    buildInsertCodes({ codeHashes, userId, now })
  ].join('\n');
  execSql(sql, opts);

  console.log(c.g(`✓ 已创建账号「${username}」`) + c.d(`  (${opts.remote ? '线上' : '本地'}数据库)`));
  await printAndSave(username, pwd, codes, opts);
}

async function cmdReset(username, password, opts) {
  if (!username) throw new Error('用法：node admin.mjs reset <账号> [口令]');
  const user = findUser(username, opts);
  if (!user) throw new Error(`账号「${username}」不存在`);

  const { pwd, salt, hash, codes, codeHashes } = await makeCredentialPayload(password);
  const now = Date.now();

  const sql = [
    buildUpdatePassword({ userId: user.id, salt, hash, iter: PBKDF2_ITERATIONS }),
    buildClearAuthStatements(user.id),           // 旧备用码与旧设备失效（作业数据不动）
    buildInsertCodes({ codeHashes, userId: user.id, now })
  ].join('\n');
  execSql(sql, opts);

  console.log(c.g(`✓ 已重置「${username}」的口令`) +
    c.y('  （旧口令、旧备用码、该账号所有设备登录均已失效）'));
  await printAndSave(username, pwd, codes, opts);
}

async function cmdList(opts) {
  let rows;
  try {
    rows = queryRows(buildListSql(), opts);
  } catch (e) {
    // 某些 D1 版本可能没有 json_array_length；退化为只看体积
    rows = queryRows(`
SELECT u.username, u.created_at,
       COALESCE(LENGTH(s.data),0) AS bytes, s.updated_at AS synced_at,
       (SELECT COUNT(*) FROM devices d WHERE d.user_id=u.id AND d.revoked=0) AS devices,
       (SELECT COUNT(*) FROM backup_codes b WHERE b.user_id=u.id AND b.used_at IS NULL) AS codes_left
FROM users u LEFT JOIN sync_data s ON s.user_id=u.id ORDER BY u.created_at ASC;`.trim(), opts);
    rows.forEach(r => { r.tasks = null; r.sessions = null; });
  }

  if (!rows.length) {
    console.log(c.y('还没有任何账号。用 node admin.mjs create <账号> [口令] 创建。'));
    return;
  }

  const fmtSize = b => b >= 1024 ? (b / 1024).toFixed(1) + ' KB' : (b || 0) + ' B';
  const fmtTime = ts => ts ? new Date(Number(ts)).toLocaleString('zh-CN') : '—';

  console.log(c.b(`\n共 ${rows.length} 个账号（${opts.remote ? '线上' : '本地'}）：\n`));
  const head = ['账号', '作业', '计时', '数据量', '设备', '备用码', '最后同步'];
  const table = [head];
  for (const r of rows) {
    table.push([
      r.username,
      r.tasks === null || r.tasks === undefined ? '—' : String(r.tasks),
      r.sessions === null || r.sessions === undefined ? '—' : String(r.sessions),
      fmtSize(Number(r.bytes) || 0),
      String(r.devices || 0),
      String(r.codes_left || 0),
      fmtTime(r.synced_at)
    ]);
  }
  // 简单对齐（中文字符按 2 宽计算）
  const width = s => [...String(s)].reduce((n, ch) => n + (/[\u4e00-\u9fa5]/.test(ch) ? 2 : 1), 0);
  const colW = head.map((_, i) => Math.max(...table.map(row => width(row[i]))));
  for (const [ri, row] of table.entries()) {
    const line = row.map((cell, i) => String(cell) + ' '.repeat(colW[i] - width(cell))).join('  ');
    console.log(ri === 0 ? c.b(line) : '  ' + line);
  }
  console.log();
}

async function cmdDelete(username, opts) {
  if (!username) throw new Error('用法：node admin.mjs delete <账号>');
  const user = findUser(username, opts);
  if (!user) throw new Error(`账号「${username}」不存在`);

  if (!opts.yes) {
    const ask = `确定删除账号「${username}」？\n它的所有作业与计时记录、所有设备登录、所有备用码都会一并删除，无法恢复。\n输入 yes 继续：`;
    const answer = await promptLine(ask);
    if (String(answer).trim().toLowerCase() !== 'yes') {
      console.log(c.y('已取消'));
      return;
    }
  }

  execSql(buildDeleteUser(user.id), opts);
  console.log(c.g(`✓ 已删除账号「${username}」及其全部数据`));
}

// ------------------------------------------------------------
// 输出与交互
// ------------------------------------------------------------

function siteUrlFromConfig() {
  // 优先用 deploy 时记录下来的地址
  const f = path.join(here, '.site-url');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return 'https://你的站点.pages.dev';
}

async function printAndSave(username, password, codes, opts) {
  const url = siteUrlFromConfig();
  console.log('');
  console.log(c.b('  账号：') + c.b(username));
  console.log(c.b('  口令：') + c.b(password));
  console.log(c.b('  备用码（换设备用，各只能用一次）：'));
  codes.forEach((x, i) => console.log(`    ${String(i + 1).padStart(2)}. ${x}`));
  console.log('');

  if (opts.noFile) {
    console.log(c.y('  （--no-file：未写文件，请自行复制上面的内容）\n'));
    return;
  }

  const outPath = opts.out || path.join(os.homedir(), 'Desktop', `账号-${username}.txt`);
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    writeCredFile(username, password, codes, url, outPath);
    console.log(c.g('  ✓ 凭据已写入：') + outPath);
    console.log(c.d('    把这个文件的内容发给对方，然后删掉本机这个文件。\n'));
    try {
      spawnSync('notepad', [outPath], { stdio: 'ignore', detached: true, shell: true }).unref();
    } catch (e) {}
  } catch (e) {
    console.log(c.r('  ✗ 写文件失败：' + e.message));
    console.log(c.y('  请手动复制上面的内容。\n'));
  }
}

function promptLine(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', d => {
      process.stdin.pause();
      resolve(String(d).trim());
    });
  });
}

// ------------------------------------------------------------
// CLI 入口
// ------------------------------------------------------------

function parseArgs(argv) {
  const opts = { remote: true, noFile: false, yes: false, out: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') { opts.remote = false; continue; }
    if (a === '--remote') { opts.remote = true; continue; }
    if (a === '--no-file') { opts.noFile = true; continue; }
    if (a === '--yes' || a === '-y') { opts.yes = true; continue; }
    if (a === '--out') { opts.out = argv[++i] || ''; continue; }
    rest.push(a);
  }
  return { opts, rest };
}

const usage = `
${c.b('账号管理')}

  node admin.mjs create <账号> [口令]    新建账号（不给口令则随机生成）
  node admin.mjs reset  <账号> [口令]    重设口令（旧口令/备用码/所有设备全部失效）
  node admin.mjs list                    列出账号、作业数、数据量、设备数
  node admin.mjs delete <账号>           删除账号及其全部数据

可选：
  --local         操作本地 D1（默认线上）
  --out <路径>    凭据写到指定文件
  --no-file       只打印，不写文件
  --yes           删除时不询问

示例：
  node admin.mjs create zhangsan 123456
  node admin.mjs list
`;

async function main() {
  const { opts, rest } = parseArgs(process.argv.slice(2));
  const [cmd, arg1, arg2] = rest;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(usage);
    return;
  }

  switch (cmd) {
    case 'create': await cmdCreate(arg1, arg2, opts); break;
    case 'reset': await cmdReset(arg1, arg2, opts); break;
    case 'list': await cmdList(opts); break;
    case 'delete': await cmdDelete(arg1, opts); break;
    default:
      console.log(c.r(`未知命令：${cmd}`));
      console.log(usage);
      process.exitCode = 1;
  }
}

// 只有直接运行时才执行 CLI（被测试 import 时不触发）
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch(e => {
    console.error(c.r('\n✗ ' + e.message + '\n'));
    process.exit(1);
  });
}
