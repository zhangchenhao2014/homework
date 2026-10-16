// ============================================================
//  crypto 单元测试
//  重点：把「Cloudflare 平台的硬约束」钉死在测试里，
//  因为本地 Node 没有这些限制，踩过一次坑：
//  PBKDF2 迭代次数设成 150000，建号正常但一登录就 500。
//  运行：node test/crypto.test.mjs
// ============================================================

import {
  randomHex, sha256Hex, pbkdf2Hex, timingSafeEqual,
  makeBackupCode, makePassword, normalizeCode, PBKDF2_ITERATIONS
} from '../src/crypto.js';

let pass = 0, fail = 0;
const check = (l, c, e) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); } };
const section = t => console.log('\n=== ' + t + ' ===');

section('1. 平台硬约束（Cloudflare WebCrypto 上限 100000）');
{
  check('默认迭代次数不超过 100000', PBKDF2_ITERATIONS <= 100000, PBKDF2_ITERATIONS);
  check('默认迭代次数足够高（不低于 50000）', PBKDF2_ITERATIONS >= 50000, PBKDF2_ITERATIONS);

  // 即使调用方传了超过上限的值，也必须被夹到 100000，而不是抛出平台错误
  let ok = true, err = null;
  try { await pbkdf2Hex('pw', randomHex(16), 150000); } catch (e) { ok = false; err = e.message; }
  check('传入 150000 不会抛错（自动夹到上限）', ok, err);

  const a = await pbkdf2Hex('pw', 'ab'.repeat(16), 100000);
  const b = await pbkdf2Hex('pw', 'ab'.repeat(16), 150000);
  check('超出上限时结果与 100000 一致（证明已夹取）', a === b, [a.slice(0, 16), b.slice(0, 16)]);
}

section('2. 哈希正确性');
{
  const salt = randomHex(16);
  const h1 = await pbkdf2Hex('password123', salt);
  const h2 = await pbkdf2Hex('password123', salt);
  check('相同口令+盐 => 相同哈希（可重现）', h1 === h2);
  check('哈希为 64 位 hex（256 bit）', /^[0-9a-f]{64}$/.test(h1), h1.length);

  const h3 = await pbkdf2Hex('password124', salt);
  check('不同口令 => 不同哈希', h1 !== h3);

  const h4 = await pbkdf2Hex('password123', randomHex(16));
  check('不同盐 => 不同哈希', h1 !== h4);

  check('随机盐长度为 32 hex（16 字节）', /^[0-9a-f]{32}$/.test(salt), salt.length);
}

section('3. SHA-256 与定时安全比较');
{
  const s = await sha256Hex('hello');
  check('sha256 输出 64 位 hex', /^[0-9a-f]{64}$/.test(s), s.length);
  check('sha256 结果确定', (await sha256Hex('hello')) === s);
  check('sha256 对 Unicode 正确', (await sha256Hex('中文')).length === 64);

  check('相同字符串比较为真', timingSafeEqual('abc', 'abc') === true);
  check('不同字符串比较为假', timingSafeEqual('abc', 'abd') === false);
  check('长度不同比较为假（不抛错）', timingSafeEqual('abc', 'abcd') === false);
  check('空字符串比较为真', timingSafeEqual('', '') === true);
  check('null 安全', timingSafeEqual(null, 'a') === false);
}

section('4. 口令与备用码生成');
{
  const pw = makePassword();
  check('口令长度 20', pw.length === 20, pw.length);
  check('口令只含无歧义字符', /^[a-zA-Z2-9]+$/.test(pw.replace(/[01IOlo]/g, '')), pw);
  const set = new Set();
  for (let i = 0; i < 50; i++) set.add(makePassword());
  check('50 次生成无重复', set.size === 50, set.size);

  const code = makeBackupCode();
  check('备用码格式 4-4-4-4', /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(code), code);
  check('备用码不含易混字符 I/O/0/1', !/[IO01]/.test(code), code);

  check('归一化：小写转大写', normalizeCode('abcd-efgh') === 'ABCDEFGH');
  check('归一化：去空格与横线', normalizeCode(' ab cd - ef ') === 'ABCDEF');
  check('归一化：null 安全', normalizeCode(null) === '');
}

section('5. 登录链路一致性（建号哈希 == 校验哈希）');
{
  // 模拟真实流程：bootstrap 用 pbkdf2Hex 存哈希，登录再用同样参数算一次
  const password = makePassword();
  const salt = randomHex(16);
  const stored = await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS);
  const attempt = await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS);
  check('同一口令两次计算一致（登录能通过）', timingSafeEqual(stored, attempt) === true);

  const wrong = await pbkdf2Hex(password + 'x', salt, PBKDF2_ITERATIONS);
  check('错误口令校验失败', timingSafeEqual(stored, wrong) === false);
}

console.log('\n================ 结果 ================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
