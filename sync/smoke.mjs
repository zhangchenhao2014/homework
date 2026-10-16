// ============================================================
//  线上冒烟验收：部署后立刻跑一遍，确认线上真的能用
//
//  为什么必须有这个脚本：
//    本地 Node 和本地 workerd 都不复现 Cloudflare 的平台限制
//    （PBKDF2 迭代上限、CPU 时间、子请求数……）。曾经因此出现
//    「本地测试全绿、线上登录 500」的情况。唯一可靠的做法是
//    部署完成后对真实站点做一次黑盒验收。
//
//  用法：
//    npm run smoke                                  # 用 .site-url 里记录的地址
//    node smoke.mjs https://xxx.pages.dev           # 指定地址
//    node smoke.mjs --password '口令'               # 额外验证登录链路（可选）
//
//  设计原则：默认完全只读、不需要任何凭据；
//  只有显式传 --password 时才会写一条测试数据，并在结束时清理。
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

const c = {
  b: s => `\x1b[1m${s}\x1b[0m`,
  g: s => `\x1b[32m${s}\x1b[0m`,
  r: s => `\x1b[31m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`,
  d: s => `\x1b[90m${s}\x1b[0m`
};

// ---------- 解析参数 ----------
const args = process.argv.slice(2);
let siteUrl = '';
let password = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--password') { password = args[++i] || ''; continue; }
  if (args[i].startsWith('http')) { siteUrl = args[i]; continue; }
}
if (!siteUrl) {
  const f = path.join(here, '.site-url');
  if (fs.existsSync(f)) siteUrl = fs.readFileSync(f, 'utf8').trim();
}
if (!siteUrl) {
  console.error(c.r('✗ 没找到站点地址。用法：node smoke.mjs https://xxx.pages.dev'));
  process.exit(1);
}
siteUrl = siteUrl.replace(/\/+$/, '');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ' + c.g('✓') + ' ' + label); }
  else { fail++; console.log('  ' + c.r('✗') + ' ' + label + (extra !== undefined ? c.d('  → ' + JSON.stringify(extra)) : '')); }
}
const section = t => console.log('\n' + c.b(t));

const timeout = (ms) => AbortSignal.timeout(ms);

// ------------------------------------------------------------
console.log(c.b('线上冒烟验收：' + siteUrl));

// ------------------------------------------------------------
section('1. 连通性与静态资源');
{
  let res = null, err = null;
  for (let i = 1; i <= 3 && !res; i++) {
    try { res = await fetch(siteUrl + '/api/health', { signal: timeout(15000) }); }
    catch (e) { err = e.cause?.code || e.message; console.log(c.d(`   第 ${i} 次尝试失败：${err}`)); }
  }
  if (!res) {
    console.log('  ' + c.r('✗ 连不上站点：' + err));
    console.log(c.y('\n  若浏览器能打开，多半是本机网络抖动，稍后重跑；'));
    console.log(c.y('  若浏览器也打不开，说明该域名在当前网络不可达。\n'));
    process.exit(1);
  }
  const health = await res.json().catch(() => ({}));
  check('GET /api/health 返回 200 且 ok', res.status === 200 && health.ok === true, health);
  check('服务名正确', health.service === 'homework-sync', health.service);
  check('账号已初始化', health.initialized === true, health.initialized);

  const page = await fetch(siteUrl + '/', { signal: timeout(20000) });
  const html = await page.text();
  check('首页返回 200', page.status === 200, page.status);
  check('是作业记录页', html.includes('假期作业记录'), '缺少标题');
  check('已内联同步引擎', html.includes('mergeStates') && html.includes('pushWithRetry'), '同步代码缺失');
  check('支持同域自动填地址', html.includes('defaultApiBase'), '缺少 defaultApiBase');
  check('登录界面存在', html.includes('登录以同步数据') || html.includes('mSecret'), '缺少登录界面');
}

// ------------------------------------------------------------
section('2. 鉴权边界（不需要凭据）');
{
  const noAuth = await fetch(siteUrl + '/api/sync', { signal: timeout(15000) });
  check('无令牌访问 /api/sync 被拒 401', noAuth.status === 401, noAuth.status);

  const fake = await fetch(siteUrl + '/api/sync', {
    headers: { Authorization: 'Bearer ' + 'f'.repeat(64) }, signal: timeout(15000)
  });
  check('伪造令牌被拒 401', fake.status === 401, fake.status);

  const badLogin = await fetch(siteUrl + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'definitely-wrong-' + Date.now(), kind: 'password' }),
    signal: timeout(20000)
  });
  const badBody = await badLogin.json().catch(() => ({}));
  check('错误口令被拒 401 而不是 500（PBKDF2 可用性探针）',
    badLogin.status === 401, { status: badLogin.status, body: badBody });
  if (badLogin.status === 500) {
    console.log(c.r('    ⚠ 登录接口返回 500 —— 极可能是平台限制（如 PBKDF2 迭代次数）又踩坑了'));
    console.log(c.d('      ' + JSON.stringify(badBody)));
  }

  const bootstrapRes = await fetch(siteUrl + '/api/bootstrap', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken: 'anything' }), signal: timeout(15000)
  });
  check('HTTP 初始化入口已关闭 403', bootstrapRes.status === 403, bootstrapRes.status);

  const resetRes = await fetch(siteUrl + '/api/reset-credentials', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken: 'anything' }), signal: timeout(15000)
  });
  check('HTTP 重置入口已关闭 403', resetRes.status === 403, resetRes.status);

  const unknown = await fetch(siteUrl + '/api/not-a-real-endpoint', {
    headers: { Authorization: 'Bearer ' + 'f'.repeat(64) }, signal: timeout(15000)
  });
  check('未知接口返回 401（未授权优先）或 404', [401, 404].includes(unknown.status), unknown.status);
}

// ------------------------------------------------------------
if (password) {
  section('3. 登录与读写链路（已提供口令）');
  let token = null, base = 0;
  try {
    const res = await fetch(siteUrl + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: password, kind: 'password', label: 'smoke-test' }),
      signal: timeout(30000)
    });
    const body = await res.json().catch(() => ({}));
    check('口令登录成功（不是 500）', res.status === 200 && body.ok === true, { status: res.status, body });
    if (body.token) {
      token = body.token;
      check('拿到 64 位设备令牌', token.length === 64, token.length);
      check('剩余备用码数量合理（0~10）',
        body.backupCodesLeft >= 0 && body.backupCodesLeft <= 10, body.backupCodesLeft);
    }
  } catch (e) {
    check('登录请求未抛异常', false, e.cause?.code || e.message);
  }

  if (token) {
    const H = { Authorization: 'Bearer ' + token };

    const cur = await (await fetch(siteUrl + '/api/sync', { headers: H, signal: timeout(15000) })).json();
    base = Number(cur.updatedAt || 0);
    check('拉取云端数据成功', cur.ok === true, cur);

    // 写入一条明显属于测试的数据，结束后清理
    const marker = '__smoke__' + Date.now();
    const payload = {
      tasks: (cur.data?.tasks || []).filter(t => !String(t.name || '').startsWith('__smoke__'))
        .concat([{ id: marker, name: marker, subject: '语文', vacation: '寒假', note: '', status: 'pending', createdAt: Date.now(), doneTime: null }]),
      sessions: cur.data?.sessions || [],
      vacations: cur.data?.vacations || ['寒假']
    };
    const put = await fetch(siteUrl + '/api/sync', {
      method: 'PUT',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: payload, baseUpdatedAt: base }),
      signal: timeout(20000)
    });
    const putBody = await put.json().catch(() => ({}));
    check('推送成功', put.status === 200 && putBody.ok === true, { status: put.status, body: putBody });

    if (putBody.updatedAt) {
      const back = await (await fetch(siteUrl + '/api/sync', { headers: H, signal: timeout(15000) })).json();
      check('回读能拿到刚写入的数据',
        !!back.data && back.data.tasks.some(t => t.id === marker), back.data?.tasks?.map(t => t.id));

      // 清理：把测试数据移除
      const cleaned = {
        tasks: (back.data.tasks || []).filter(t => t.id !== marker),
        sessions: back.data.sessions || [],
        vacations: back.data.vacations || ['寒假']
      };
      const rm = await fetch(siteUrl + '/api/sync', {
        method: 'PUT',
        headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: cleaned, baseUpdatedAt: back.updatedAt }),
        signal: timeout(20000)
      });
      const rmBody = await rm.json().catch(() => ({}));
      check('清理测试数据成功', rm.status === 200 && rmBody.ok === true, rm.status);
    }

    // 本设备登出，避免留下长期令牌
    const out = await fetch(siteUrl + '/api/logout', { method: 'POST', headers: H, signal: timeout(15000) });
    check('冒烟测试令牌已登出', out.status === 200, out.status);
  }
} else {
  section('3. 登录与读写链路');
  console.log(c.d('   （未提供口令，跳过。要完整验收请加 --password \'你的口令\'）'));
}

// ------------------------------------------------------------
console.log('\n' + c.b('================ 结果 ================'));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail === 0) {
  console.log(c.g('\n✅ 线上服务正常'));
} else {
  console.log(c.r('\n❌ 线上有问题，请检查上面的失败项'));
}
process.exit(fail === 0 ? 0 : 1);
