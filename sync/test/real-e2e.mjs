// ============================================================
//  真实端到端测试：本地 workerd（wrangler dev）+ 真实 D1(SQLite)
//  全程走真实 HTTP，不使用任何模拟 —— 覆盖加密、路由、SQL、并发控制。
//  用法：node real-e2e.mjs
// ============================================================

import { mergeStates, pushWithRetry, pull, login, health } from '../src/sync-client.js';

const API = process.env.E2E_API || 'http://127.0.0.1:8787';
const SETUP_TOKEN = 'e2e-local-setup-token';

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const task = (id, over) => Object.assign({
  id, name: '作业' + id, subject: '数学', vacation: '寒假', note: '',
  status: 'pending', createdAt: 1000, doneTime: null
}, over || {});

const st = (tasks, sessions) => ({ version: 1, tasks: tasks || [], sessions: sessions || [], vacations: ['寒假'] });

// ------------------------------------------------------------
section('1. 真实服务健康检查');
let initialized;
{
  const h = await health(API);
  check('health 返回 ok', h.ok === true, h);
  check('初始状态 initialized=false', h.initialized === false, h);
  initialized = h.initialized;
}

// ------------------------------------------------------------
section('2. 账号准备（离线写入 D1，与 npm run setup 的真实流程一致）');
let password, codes;
{
  // 注意：部署后的 Worker/Pages 不再暴露 HTTP bootstrap 接口
  // （env.SETUP_TOKEN 为空即返回 setup_disabled），这是有意的安全设计：
  // 账号只能通过 wrangler 直连数据库创建，公网上没有任何初始化入口。
  const bad = await fetch(API + '/api/bootstrap', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken: 'anything' })
  });
  check('HTTP bootstrap 已关闭（setup_disabled）', bad.status === 403, bad.status);

  // 读一下当前状态，决定是否需要建号
  const h0 = await health(API);
  if (h0.initialized) {
    console.log('     （数据库已有账号，直接复用）');
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const credPath = path.join(os.homedir(), 'Desktop', '作业同步凭据.txt');
    if (!fs.existsSync(credPath)) {
      console.log('     桌面缺少凭据文件，无法继续。请先跑 npm run bootstrap:remote 或清空数据库。');
      process.exit(1);
    }
    const lines = fs.readFileSync(credPath, 'utf8').split('\n');
    password = lines[5].trim();
    codes = [...lines.join('\n').matchAll(/([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/g)].map(m => m[1]);
    check('从凭据文件读到口令', password.length >= 16, password.length);
    check('从凭据文件读到 10 个备用码', codes.length === 10, codes.length);
  } else {
    // 数据库还是空的：用离线 bootstrap 建号（与用户实际执行的命令相同）
    const { spawnSync } = await import('child_process');
    const { fileURLToPath } = await import('url');
    const path = await import('path');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const res = spawnSync('node', ['bootstrap-db.mjs'], {
      cwd: path.join(here, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    const out = (res.stdout || '') + (res.stderr || '');
    if (res.status !== 0) {
      console.log('     bootstrap-db.mjs 失败：');
      console.log(out.split('\n').slice(-8).join('\n'));
      process.exit(1);
    }
    const fs = await import('fs');
    const os = await import('os');
    const credPath = path.join(os.homedir(), 'Desktop', '作业同步凭据.txt');
    const lines = fs.readFileSync(credPath, 'utf8').split('\n');
    password = lines[5].trim();
    codes = [...lines.join('\n').matchAll(/([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/g)].map(m => m[1]);
    check('离线建号成功，读到口令', password.length >= 16, password.length);
    check('读到 10 个备用码', codes.length === 10, codes.length);
  }

  const h1 = await health(API);
  check('health 现在 initialized=true', h1.initialized === true, h1);
}

// ------------------------------------------------------------
section('3. 两台设备真实登录');
let tokenA, tokenB;
{
  const badLogin = await fetch(API + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'wrong-password', kind: 'password' })
  });
  check('错误口令被拒（401）', badLogin.status === 401, badLogin.status);

  const a = await login(API, password, 'password', '电脑', 'owner');
  tokenA = a.token;
  check('设备A 登录成功（真实 HTTP + 真实 SQL）', !!tokenA, a);
  check('剩余备用码数量合理（0~10）',
    a.backupCodesLeft >= 0 && a.backupCodesLeft <= 10, a.backupCodesLeft);

  const b = await login(API, password, 'password', '手机', 'owner');
  tokenB = b.token;
  check('设备B 登录成功', !!tokenB, !!tokenB);
  check('两台设备令牌不同', tokenA !== tokenB, 'token 相同！');
}

// ------------------------------------------------------------
section('4. 设备A 上传 → 设备B 拉取到相同数据');
{
  const stateA = st([task('A1', { name: '电脑上的作业' })], []);
  // 先拉到当前版本号，避免库里已有数据导致 409（测试要能在「已有数据的库」上重复跑）
  const baseline = await pull(API, tokenA);
  const pushed = await pushWithRetry(API, tokenA, stateA, baseline.updatedAt);
  check('设备A 推送成功', pushed.ok === true && pushed.updatedAt > 0, pushed);
  const v1 = pushed.updatedAt;

  const pulled = await pull(API, tokenB);
  check('设备B 拉到数据', !!pulled.data, pulled);
  check('内容与设备A 一致', pulled.data.tasks[0].name === '电脑上的作业', pulled.data?.tasks);
  check('版本号与推送时一致', pulled.updatedAt === v1, [pulled.updatedAt, v1]);

  // ------------------------------------------------------------
  section('5. 真实并发冲突：过期版本号必须 409（真实 SQLite 校验）');
  // 注意：两台设备看到的“同一项作业”必须用同一个 id，这才是真实场景。
  // mergeStates 按 id 去重，若 id 不同会被视为两项不同作业（下方 5b 单独验证）。
  const stateB = st([task('A1', { name: '电脑上的作业' }), task('B1', { name: '手机上的作业' })], []);
  const okB = await pushWithRetry(API, tokenB, stateB, v1);
  check('设备B 基于最新版本推送成功', okB.ok === true, okB);

  const raw = await fetch(API + '/api/sync', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenA },
    body: JSON.stringify({ data: stateA, baseUpdatedAt: v1 })   // 故意用过期版本号
  });
  const conflictBody = await raw.json();
  check('设备A 用过期版本号推送被拒（409）', raw.status === 409 && conflictBody.error === 'conflict', raw.status);
  check('冲突响应带回云端最新数据', conflictBody.data?.tasks?.length === 2, conflictBody.data?.tasks?.length);

  // ------------------------------------------------------------
  section('6. 合并后重试：两台设备的作业都保留');
  const merged = mergeStates(stateA, conflictBody.data);
  check('同一 id 的作业被正确合并（不重复）', merged.tasks.length === 2, merged.tasks.map(t => t.name));
  check('合并后含两台设备各自的作业',
    merged.tasks.map(t => t.name).sort().join(',') === '手机上的作业,电脑上的作业',
    merged.tasks.map(t => t.name));
  const retry = await pushWithRetry(API, tokenA, merged, conflictBody.updatedAt);
  check('合并后重试成功', retry.ok === true, retry);

  const finalPull = await pull(API, tokenB);
  const names = finalPull.data.tasks.map(t => t.name).sort();
  check('云端最终含两台设备的作业（不丢数据）',
    names.includes('电脑上的作业') && names.includes('手机上的作业'), names);

  // 5b：id 不同 = 两项不同作业，合并后应各留一份（验证不会误删）
  section('6b. id 不同则视为两项不同作业');
  const other = mergeStates(st([task('X1', { name: '作业X' })]), st([task('Y1', { name: '作业Y' })]));
  check('不同 id 的作业都保留', other.tasks.length === 2, other.tasks.map(t => t.id));
}

// ------------------------------------------------------------
section('7. 真实备用码登录（一次性）');
{
  // 记录登录前的剩余数量，避免依赖「库是全新的」这个前提
  const pre = await login(API, password, 'password', '统计用', 'owner');
  const beforeLeft = pre.backupCodesLeft;

  const ok = await fetch(API + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: codes[0], kind: 'backup', label: '备用设备' })
  });
  const body = await ok.json();
  check('备用码可登录', ok.status === 200 && body.ok === true, body);
  check('剩余备用码比登录前少 1',
    body.backupCodesLeft === beforeLeft - 1, [beforeLeft, body.backupCodesLeft]);

  const reuse = await fetch(API + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: codes[0], kind: 'backup' })
  });
  check('同一备用码不能二次使用', reuse.status === 401, reuse.status);

  const messy = codes[1].toLowerCase().replace(/-/g, ' ');
  const tolerant = await fetch(API + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: messy, kind: 'backup' })
  });
  check('备用码容错（小写 + 空格）', tolerant.status === 200, tolerant.status);
}

// ------------------------------------------------------------
section('8. 令牌吊销（真实数据库状态变更）');
{
  const temp = await login(API, password, 'password', '临时设备', 'owner');
  check('临时设备可拉取数据', (await pull(API, temp.token)).data !== null);

  const out = await fetch(API + '/api/logout', {
    method: 'POST', headers: { Authorization: 'Bearer ' + temp.token }
  });
  check('登出成功', out.status === 200, out.status);

  let threw = null;
  try { await pull(API, temp.token); } catch (e) { threw = e; }
  check('登出后该令牌失效（401）', threw && threw.status === 401, threw && threw.status);

  check('设备B 令牌不受影响', (await pull(API, tokenB)).data !== null);

  const allOut = await fetch(API + '/api/logout-all', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tokenA }
  });
  check('全部登出成功', allOut.status === 200, allOut.status);
  let threw2 = null;
  try { await pull(API, tokenB); } catch (e) { threw2 = e; }
  check('logout-all 后设备B 也失效', threw2 && threw2.status === 401, threw2 && threw2.status);

  const relogin = await login(API, password, 'password', '重新登录', 'owner');
  check('吊销后仍可用口令重新登录', !!relogin.token, !!relogin.token);
}

// ------------------------------------------------------------
section('9. 真实数据边界与安全');
{
  const t = await login(API, password, 'password', '边界测试', 'owner');

  const big = await fetch(API + '/api/sync', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t.token },
    body: JSON.stringify({ data: { big: 'x'.repeat(1024 * 1024 + 100) }, baseUpdatedAt: 0 })
  });
  check('超过 1MB 被拒（413）', big.status === 413, big.status);

  const noAuth = await fetch(API + '/api/sync', { method: 'GET' });
  check('无令牌被拒（401）', noAuth.status === 401, noAuth.status);

  const fake = await fetch(API + '/api/sync', {
    method: 'GET', headers: { Authorization: 'Bearer ' + 'f'.repeat(64) }
  });
  check('伪造令牌被拒（401）', fake.status === 401, fake.status);

  // 用一个「白名单里一定有的」来源做预检：GitHub Pages 域名始终在 ALLOWED_ORIGINS 中
  const GOOD_ORIGIN = 'https://zhangchenhao2014.github.io';
  const preflight = await fetch(API + '/api/sync', {
    method: 'OPTIONS',
    headers: {
      Origin: GOOD_ORIGIN,
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'authorization,content-type'
    }
  });
  check('CORS 预检返回 204', preflight.status === 204, preflight.status);
  check('CORS 放行白名单来源',
    preflight.headers.get('Access-Control-Allow-Origin') === GOOD_ORIGIN,
    preflight.headers.get('Access-Control-Allow-Origin'));
  check('CORS 允许 Authorization 头',
    String(preflight.headers.get('Access-Control-Allow-Headers') || '').toLowerCase().includes('authorization'),
    preflight.headers.get('Access-Control-Allow-Headers'));

  const evil = await fetch(API + '/api/sync', {
    method: 'GET', headers: { Origin: 'https://evil.example.com', Authorization: 'Bearer ' + t.token }
  });
  const evilAllow = evil.headers.get('Access-Control-Allow-Origin');
  check('陌生来源不被放行', evilAllow !== 'https://evil.example.com', evilAllow);
}

// ------------------------------------------------------------
section('10. 部署后 HTTP 凭据重发已关闭（改为离线流程）');
{
  const before = await login(API, password, 'password', '检查前', 'owner');
  check('口令仍可正常登录', !!before.token, !!before.token);

  const r = await fetch(API + '/api/reset-credentials', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken: 'anything' })
  });
  check('未配置 SETUP_TOKEN 时重发接口不可用（403）', r.status === 403, r.status);

  // 口令仍然有效（没有被意外改动）
  const after = await login(API, password, 'password', '检查后', 'owner');
  check('口令未被改动', !!after.token, !!after.token);
  check('原令牌仍可用', (await pull(API, before.token)).data !== null);
}

// ------------------------------------------------------------
console.log('\n================ 结果 ================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
