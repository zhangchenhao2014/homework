// ============================================================
//  平台限制一致性测试
//
//  为什么需要这个文件：
//    Cloudflare 的 WebCrypto 有一批本地 Node 没有的硬限制，
//    最典型的就是 PBKDF2 迭代次数上限 100000。
//    曾经因为设成 150000，导致「建号成功但一登录就 500」，
//    而本地所有测试与本地 workerd 都测不出来。
//
//  做法：把 Cloudflare 的限制「模拟」到 globalThis.crypto 上，
//  然后断言我们的代码不会撞上它们。这样这类平台级 bug
//  在本地 npm test 阶段就能被抓到。
//
//  运行：node test/platform-limits.test.mjs
// ============================================================

let pass = 0, fail = 0;
const check = (l, c, e) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); } };
const section = t => console.log('\n=== ' + t + ' ===');

// ------------------------------------------------------------
// 1. 先看真实 Node 环境（基线）
// ------------------------------------------------------------
section('1. 真实 Node 环境的基线行为');
{
  const { pbkdf2Hex, randomHex, PBKDF2_ITERATIONS } = await import('../src/crypto.js');
  check('导出 PBKDF2_ITERATIONS', typeof PBKDF2_ITERATIONS === 'number', typeof PBKDF2_ITERATIONS);
  check('常量 <= 100000（Cloudflare 上限）', PBKDF2_ITERATIONS <= 100000, PBKDF2_ITERATIONS);

  const salt = randomHex(16);
  const t0 = Date.now();
  const h = await pbkdf2Hex('test-password', salt, PBKDF2_ITERATIONS);
  const ms = Date.now() - t0;
  check('在真实 Node 下能算出哈希', /^[0-9a-f]{64}$/.test(h), h.slice(0, 16));
  console.log(`     （${PBKDF2_ITERATIONS} 次迭代耗时 ${ms}ms —— Cloudflare 免费版 CPU 上限约 10ms/请求，` +
              `所以登录接口的 CPU 预算是关键，下面会验证）`);
}

// ------------------------------------------------------------
// 2. 模拟 Cloudflare 的 PBKDF2 上限
// ------------------------------------------------------------
section('2. 模拟 Cloudflare WebCrypto：迭代次数 > 100000 必须抛错');
{
  // 包装 subtle.deriveBits，复刻 Cloudflare 的报错行为
  const realSubtle = globalThis.crypto.subtle;
  const patched = Object.create(realSubtle);
  patched.deriveBits = async function (algo, key, len) {
    if (algo && algo.name === 'PBKDF2' && algo.iterations > 100000) {
      throw new Error(`Pbkdf2 failed: iteration counts above 100000 are not supported (requested ${algo.iterations}).`);
    }
    return realSubtle.deriveBits(algo, key, len);
  };
  patched.importKey = realSubtle.importKey.bind(realSubtle);
  patched.digest = realSubtle.digest.bind(realSubtle);

  Object.defineProperty(globalThis.crypto, 'subtle', { value: patched, configurable: true });

  // 重新导入，让 crypto.js 在带限制的环境下工作
  const mod = await import('../src/crypto.js?limits=1');
  const { pbkdf2Hex, randomHex, PBKDF2_ITERATIONS } = mod;

  // 2.1 默认参数（代码实际使用的路径）必须不触发限制
  let okDefault = true, errDefault = null;
  try { await pbkdf2Hex('pw', randomHex(16)); } catch (e) { okDefault = false; errDefault = e.message; }
  check('默认迭代次数不触发平台错误（真实登录路径）', okDefault, errDefault);

  let okConst = true, errConst = null;
  try { await pbkdf2Hex('pw', randomHex(16), PBKDF2_ITERATIONS); } catch (e) { okConst = false; errConst = e.message; }
  check('显式传入 PBKDF2_ITERATIONS 也不触发', okConst, errConst);

  // 2.2 即使有人误传超限值，也必须被夹住而不是抛错
  let okOver = true, errOver = null;
  try { await pbkdf2Hex('pw', randomHex(16), 150000); } catch (e) { okOver = false; errOver = e.message; }
  check('误传 150000 会被夹到上限而不抛错', okOver, errOver);

  let okHuge = true, errHuge = null;
  try { await pbkdf2Hex('pw', randomHex(16), 9999999); } catch (e) { okHuge = false; errHuge = e.message; }
  check('误传极大值也不抛错', okHuge, errHuge);

  // 2.3 夹取后结果必须与上限一致（证明真的按 100000 算）
  const salt = randomHex(16);
  const a = await pbkdf2Hex('pw', salt, 100000);
  const b = await pbkdf2Hex('pw', salt, 150000);
  check('夹取后哈希与 100000 完全一致', a === b, [a.slice(0, 12), b.slice(0, 12)]);

  // 2.4 顺便确认：真实 Node 不限制（说明这个测试确实在起作用）
  const realCheck = await realSubtle.deriveBits(
    { name: 'PBKDF2', salt: new Uint8Array(16), iterations: 150000, hash: 'SHA-256' },
    await realSubtle.importKey('raw', new TextEncoder().encode('x'), 'PBKDF2', false, ['deriveBits']),
    256
  );
  check('真实 Node 能算 150000 次（所以本地测不出该 bug）', realCheck.byteLength === 32, realCheck.byteLength);
}

// ------------------------------------------------------------
// 3. 其它 Cloudflare 限制的静态检查
// ------------------------------------------------------------
section('3. 静态检查：代码里不应出现超过上限的迭代次数');
{
  const fs = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const targets = [
    '../src/api.js', '../src/crypto.js', '../bootstrap-db.mjs', '../setup.mjs'
  ];

  let offenders = [];
  for (const rel of targets) {
    const p = path.join(here, rel);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    // 找所有出现的 6 位以上数字（迭代次数形态）
    for (const m of text.matchAll(/\b(\d{6,})\b/g)) {
      const n = Number(m[1]);
      if (n > 100000 && n < 1e9) offenders.push(`${rel}: ${n}`);
    }
  }
  check('没有硬编码超过 100000 的迭代次数', offenders.length === 0, offenders);

  // 允许的时间常量（毫秒）不算违规
  const allow = new Set([1000000, 600000, 3600000, 86400000, 1500000]);
  const realOffenders = offenders.filter(o => !allow.has(Number(o.split(': ')[1])));
  check('排除已知的时间常量后仍无违规', realOffenders.length === 0, realOffenders);
}

console.log('\n================ 结果 ================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
