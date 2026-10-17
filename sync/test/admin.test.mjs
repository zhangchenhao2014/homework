// ============================================================
//  admin.mjs 的关键逻辑测试
//
//  重点不是"脚本能跑"，而是几条容易出错、出错了很严重的规则：
//   1. 用户名转义 —— 带单引号的账号名不能破坏 SQL
//   2. 重置口令**绝不能**删掉 sync_data（那是用户的作业数据）
//   3. 删除账号的语句顺序必须「子表 → users」，否则外键约束失败
//   4. 迭代次数不得超过 Cloudflare 上限 100000
//   5. 生成的哈希必须能被 api.js 的登录校验通过（同一套参数）
//
//  运行：node test/admin.test.mjs
// ============================================================

import {
  sqlLit, buildInsertUser, buildInsertCodes, buildUpdatePassword,
  buildClearAuthStatements, buildDeleteUser, buildListSql, extractJson
} from '../admin.mjs';
import {
  pbkdf2Hex, sha256Hex, randomHex, makeBackupCode, normalizeCode, PBKDF2_ITERATIONS
} from '../src/crypto.js';

let pass = 0, fail = 0;
const check = (l, c, e) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); } };
const section = t => console.log('\n=== ' + t + ' ===');

// ------------------------------------------------------------
section('1. SQL 转义（防注入）');
{
  check('普通字符串加引号包裹', sqlLit('abc') === "'abc'", sqlLit('abc'));
  check('单引号翻倍', sqlLit("o'brien") === "'o''brien'", sqlLit("o'brien"));
  check('多个单引号都翻倍', sqlLit("a'b'c") === "'a''b''c'", sqlLit("a'b'c"));
  check('null 安全', sqlLit(null) === "''", sqlLit(null));
  check('undefined 安全', sqlLit(undefined) === "''", sqlLit(undefined));

  // 模拟注入尝试：转义后不应出现"提前闭合字符串"的情况
  const evil = "x'; DROP TABLE users; --";
  const lit = sqlLit(evil);
  check('注入尝试被整体包在一个字符串里',
    lit.startsWith("'") && lit.endsWith("'") && lit === "'x''; DROP TABLE users; --'", lit);

  // 带引号的账号名生成的 INSERT 语句里，引号数量应为偶数（成对）
  const stmt = buildInsertUser({
    id: 'id1', username: "o'brien", salt: 'aa', hash: 'bb', iter: 100000, now: 1
  });
  const quotes = (stmt.match(/'/g) || []).length;
  check('含单引号的账号名生成语句引号成对', quotes % 2 === 0, quotes);
  check('账号名被正确转义进语句', stmt.includes("'o''brien'"), stmt);
}

// ------------------------------------------------------------
section('2. 重置口令绝不能动用户数据（高危）');
{
  const userId = 'user-abc';
  const clear = buildClearAuthStatements(userId);

  check('重置会清掉 backup_codes', clear.includes('DELETE FROM backup_codes'), clear);
  check('重置会清掉 devices（踢掉旧登录）', clear.includes('DELETE FROM devices'), clear);
  check('重置**不会**删除 sync_data（作业记录必须保留）',
    !clear.includes('sync_data'), clear);
  check('重置不会删除 users 本身', !/DELETE FROM users/i.test(clear), clear);
}

// ------------------------------------------------------------
section('3. 删除账号：顺序必须子表在前（外键约束）');
{
  const userId = 'user-abc';
  const del = buildDeleteUser(userId);

  const iCodes = del.indexOf('DELETE FROM backup_codes');
  const iDevices = del.indexOf('DELETE FROM devices');
  const iSync = del.indexOf('DELETE FROM sync_data');
  const iUsers = del.indexOf('DELETE FROM users');

  check('四条删除语句都在', [iCodes, iDevices, iSync, iUsers].every(i => i >= 0), del);
  check('backup_codes 在 users 之前', iCodes < iUsers, [iCodes, iUsers]);
  check('devices 在 users 之前', iDevices < iUsers, [iDevices, iUsers]);
  check('sync_data 在 users 之前', iSync < iUsers, [iSync, iUsers]);
  check('users 是最后一条', iUsers === Math.max(iCodes, iDevices, iSync, iUsers), del);
  check('每条语句都以分号结尾', (del.match(/;/g) || []).length === 4, (del.match(/;/g) || []).length);
}

// ------------------------------------------------------------
section('4. 迭代次数不超过 Cloudflare 上限');
{
  check('admin 使用的迭代次数 <= 100000', PBKDF2_ITERATIONS <= 100000, PBKDF2_ITERATIONS);

  const stmt = buildInsertUser({
    id: 'id1', username: 'u', salt: 'aa', hash: 'bb', iter: PBKDF2_ITERATIONS, now: 1
  });
  check('INSERT 语句里的 pwd_iter 就是该常量',
    stmt.includes(`, ${PBKDF2_ITERATIONS}, `), stmt);
}

// ------------------------------------------------------------
section('5. 建号生成的哈希能被登录校验通过（同一套参数）');
{
  // 完整模拟 admin create 的流程
  const username = 'tester';
  const password = 'My-Pass-1234';
  const salt = randomHex(16);
  const hash = await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS);

  // 登录时的校验：用同样的 salt / iter 再算一次
  const attempt = await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS);
  check('同一口令算两次结果一致 → 能登录', attempt === hash);
  check('哈希长度 64 hex', hash.length === 64, hash.length);

  const wrong = await pbkdf2Hex(password + 'x', salt, PBKDF2_ITERATIONS);
  check('错误口令算出来不同 → 登不进', wrong !== hash);

  // 备用码哈希
  const code = makeBackupCode();
  const h1 = await sha256Hex(normalizeCode(code));
  const h2 = await sha256Hex(normalizeCode(code.toLowerCase().replace(/-/g, ' ')));
  check('备用码大小写/空格不影响哈希（容错）', h1 === h2);
}

// ------------------------------------------------------------
section('6. 生成的语句结构完整');
{
  const codes = [await sha256Hex('a'), await sha256Hex('b')];
  const stmts = buildInsertCodes({ codeHashes: codes, userId: 'u1', now: 123 });
  check('每个备用码一条 INSERT', (stmts.match(/INSERT INTO backup_codes/g) || []).length === 2,
    (stmts.match(/INSERT INTO backup_codes/g) || []).length);
  check('包含 user_id', stmts.includes("'u1'"), stmts.slice(0, 80));

  const upd = buildUpdatePassword({ userId: 'u1', salt: 's', hash: 'h', iter: 100000 });
  check('UPDATE 只改口令相关字段',
    upd.startsWith('UPDATE users SET pwd_salt') && upd.includes('WHERE id = '), upd);
  check('UPDATE 不包含 sync_data', !upd.includes('sync_data'), upd);

  const list = buildListSql();
  check('列表查询统计作业数', list.includes('$.tasks'), list.slice(0, 120));
  check('列表查询统计计时记录', list.includes('$.sessions'), list.slice(0, 120));
  check('列表查询统计数据量', list.includes('LENGTH'), list.slice(0, 200));
  check('列表查询统计在线设备', list.includes('FROM devices'), list.slice(0, 300));
  check('列表查询统计可用备用码', list.includes('FROM backup_codes'), list.slice(0, 300));
}

// ------------------------------------------------------------
section('7. 从 wrangler 输出里提取 JSON（真实踩过的坑）');
{
  // wrangler 的输出前面可能混进 Node 警告，其中含 '['（如 [as runMain]）
  const messy = `node:internal/modules/run_main:33
    at Module.executeUserEntryPoint [as runMain]
[{"results":[{"username":"owner"}],"success":true}]`;
  const got = extractJson(messy);
  check('能跳过含 [ 的噪声文本', Array.isArray(got), got);
  check('取到正确的数组', got && got[0] && got[0].results && got[0].results[0].username === 'owner',
    got && got[0]);

  // 带 ANSI 颜色码
  const colored = '\x1b[32m✓\x1b[0m\n[{"results":[{"a":1}],"success":true}]';
  const cg = extractJson(colored);
  check('能去掉 ANSI 颜色码后解析', Array.isArray(cg) && cg[0].results[0].a === 1, cg);

  // 完全不含 JSON
  check('没有 JSON 时返回 null', extractJson('nothing here') === null);
  check('空字符串返回 null', extractJson('') === null);
}

console.log('\n================ 结果 ================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);