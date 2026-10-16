// ============================================================
//  Worker API 行为测试（用 mock D1，不依赖 Cloudflare）
//  运行：node test/worker.test.mjs
// ============================================================

import worker from '../src/worker.js';
import { makeMockD1 } from './mock-d1.js';

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const ORIGIN = 'https://zhangchenhao2014.github.io';
const SETUP_TOKEN = 'setup-token-for-test';

function makeEnv() {
  return { DB: makeMockD1(), SETUP_TOKEN, ALLOWED_ORIGINS: ORIGIN };
}

async function call(env, method, path, { body, token, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (origin !== null) headers['Origin'] = origin || ORIGIN;
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const req = new Request('https://sync.example.workers.dev' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const res = await worker.fetch(req, env);
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, cors: res.headers.get('Access-Control-Allow-Origin') };
}

// ------------------------------------------------------------
section('1. 探活与 CORS');
{
  const env = makeEnv();
  let r = await call(env, 'GET', '/api/health');
  check('health 返回 200', r.status === 200, r);
  check('service 名为 homework-sync', r.json.service === 'homework-sync', r.json);
  check('初始未初始化 initialized=false', r.json.initialized === false, r.json);
  check('CORS 放行前端域名', r.cors === ORIGIN, r.cors);

  r = await call(env, 'OPTIONS', '/api/sync');
  check('预检请求返回 204', r.status === 204, r.status);

  const evil = await call(env, 'GET', '/api/health', { origin: 'https://evil.example.com' });
  check('陌生域名不获得自身 Origin 的放行', evil.cors !== 'https://evil.example.com', evil.cors);
}

// ------------------------------------------------------------
section('2. 首次初始化（bootstrap）');
const env = makeEnv();
let password, codes, token;
{
  let r = await call(env, 'POST', '/api/bootstrap', { body: { setupToken: 'wrong' } });
  check('错误 SETUP_TOKEN 被拒绝', r.status === 403 && r.json.error === 'bad_setup_token', r);

  r = await call(env, 'POST', '/api/bootstrap', { body: { setupToken: SETUP_TOKEN } });
  check('正确 SETUP_TOKEN 初始化成功', r.status === 200 && r.json.ok === true, r);
  check('返回口令', typeof r.json.password === 'string' && r.json.password.length >= 16, r.json.password && r.json.password.length);
  check('返回 10 个备用码', Array.isArray(r.json.backupCodes) && r.json.backupCodes.length === 10, r.json.backupCodes && r.json.backupCodes.length);
  password = r.json.password;
  codes = r.json.backupCodes;
  check('备用码为 4 组 4 字符格式', /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(codes[0]), codes[0]);
  check('备用码不含易混字符 I/O/0/1', !/[IO01]/.test(codes.join('')), codes[0]);

  const dump = env.DB._dump();
  check('数据库存的是哈希，不含明文口令', !JSON.stringify(dump).includes(password), '口令泄露！');
  check('数据库不含明文备用码', !dump.codes.some(c => JSON.stringify(c).includes(codes[0])), '备用码明文泄露！');
  check('users 表有 1 条记录', dump.users.length === 1, dump.users.length);
  check('backup_codes 表有 10 条记录', dump.codes.length === 10, dump.codes.length);

  r = await call(env, 'POST', '/api/bootstrap', { body: { setupToken: SETUP_TOKEN } });
  check('重复初始化被拒绝(409)', r.status === 409 && r.json.error === 'already_initialized', r);

  r = await call(env, 'GET', '/api/health');
  check('初始化后 initialized=true', r.json.initialized === true, r.json);
}

// ------------------------------------------------------------
section('3. 登录');
{
  let r = await call(env, 'POST', '/api/login', { body: { secret: password, kind: 'password' } });
  check('正确口令登录成功', r.status === 200 && r.json.ok === true, r);
  check('返回设备令牌(64 hex)', typeof r.json.token === 'string' && /^[0-9a-f]{64}$/.test(r.json.token), r.json.token && r.json.token.length);
  check('返回剩余备用码数量 10', r.json.backupCodesLeft === 10, r.json.backupCodesLeft);
  token = r.json.token;

  const dump = env.DB._dump();
  check('设备令牌只存哈希，明文不落库', !JSON.stringify(dump.devices).includes(token), '令牌明文泄露！');

  r = await call(env, 'POST', '/api/login', { body: { secret: 'wrong-password', kind: 'password' } });
  check('错误口令被拒绝(401)', r.status === 401 && r.json.error === 'invalid_secret', r);

  r = await call(env, 'POST', '/api/login', { body: { secret: password, kind: 'password' }, origin: ORIGIN });
  check('同一口令可在新设备再登录（多设备）', r.status === 200 && r.json.token !== token, r.status);

  r = await call(env, 'POST', '/api/login', { body: {} });
  check('空 secret 被拒绝(400)', r.status === 400 && r.json.error === 'missing_secret', r);
}

// ------------------------------------------------------------
section('4. 备用码（一次性）');
{
  let r = await call(env, 'POST', '/api/login', { body: { secret: codes[0], kind: 'backup' } });
  check('备用码可登录', r.status === 200 && r.json.ok === true, r);
  check('标记 usedBackupCode=true', r.json.usedBackupCode === true, r.json);
  check('剩余备用码变为 9', r.json.backupCodesLeft === 9, r.json.backupCodesLeft);

  r = await call(env, 'POST', '/api/login', { body: { secret: codes[0], kind: 'backup' } });
  check('同一个备用码二次使用被拒绝', r.status === 401, r);

  const lucky = codes[1].toLowerCase().replace(/-/g, ' ');   // 测试容错：小写+空格
  r = await call(env, 'POST', '/api/login', { body: { secret: lucky, kind: 'backup' } });
  check('备用码容错：小写与空格也能识别', r.status === 200, r);

  r = await call(env, 'POST', '/api/login', { body: { secret: 'AAAA-BBBB-CCCC-DDDD', kind: 'backup' } });
  check('不存在的备用码被拒绝', r.status === 401, r);
}

// ------------------------------------------------------------
section('5. 鉴权');
{
  let r = await call(env, 'GET', '/api/sync');
  check('无令牌访问被拒(401)', r.status === 401 && r.json.error === 'unauthorized', r);

  r = await call(env, 'GET', '/api/sync', { token: 'a'.repeat(64) });
  check('伪造令牌被拒(401)', r.status === 401, r);

  r = await call(env, 'GET', '/api/nonexistent', { token });
  check('未知接口返回 404', r.status === 404 && r.json.error === 'not_found', r);
}

// ------------------------------------------------------------
section('6. 同步：推送 / 拉取 / 冲突');
{
  const dataA = { version: 1, tasks: [{ id: 't1', name: '数学卷子', subject: '数学', vacation: '寒假', status: 'pending' }], sessions: [] };

  let r = await call(env, 'GET', '/api/sync', { token });
  check('初始拉取返回空数据', r.status === 200 && r.json.data === null && r.json.updatedAt === 0, r.json);

  r = await call(env, 'PUT', '/api/sync', { token, body: { data: dataA, baseUpdatedAt: 0 } });
  check('首次推送成功', r.status === 200 && r.json.ok === true, r);
  const v1 = r.json.updatedAt;
  check('返回服务端 updatedAt', typeof v1 === 'number' && v1 > 0, v1);

  r = await call(env, 'GET', '/api/sync', { token });
  check('拉取到刚推送的数据', r.json.data && r.json.data.tasks[0].name === '数学卷子', r.json);
  check('updatedAt 与推送时一致', r.json.updatedAt === v1, [r.json.updatedAt, v1]);

  // 另一台设备
  const login2 = await call(env, 'POST', '/api/login', { body: { secret: password, kind: 'password', label: '我的手机' } });
  const token2 = login2.json.token;
  r = await call(env, 'GET', '/api/sync', { token: token2 });
  check('第二台设备用同一账号看到相同数据', r.json.data && r.json.data.tasks[0].name === '数学卷子', r.json);

  // 设备2 正常更新（基于最新版本）
  const dataB = { version: 1, tasks: dataA.tasks.concat([{ id: 't2', name: '英语阅读', subject: '英语', vacation: '寒假', status: 'pending' }]), sessions: [] };
  r = await call(env, 'PUT', '/api/sync', { token: token2, body: { data: dataB, baseUpdatedAt: v1 } });
  check('设备2 基于最新版本推送成功', r.status === 200, r);
  const v2 = r.json.updatedAt;

  // 设备1 拿旧版本号推送 -> 必须冲突
  r = await call(env, 'PUT', '/api/sync', { token, body: { data: dataA, baseUpdatedAt: v1 } });
  check('设备1 用过期版本号推送触发 409 冲突', r.status === 409 && r.json.error === 'conflict', r);
  check('冲突响应里带回云端最新数据', r.json.data && r.json.data.tasks.length === 2, r.json.data && r.json.data.tasks && r.json.data.tasks.length);
  check('冲突响应里带回云端 updatedAt', r.json.updatedAt === v2, [r.json.updatedAt, v2]);

  // 合并后重试成功
  const merged = { version: 1, tasks: dataB.tasks, sessions: [] };
  r = await call(env, 'PUT', '/api/sync', { token, body: { data: merged, baseUpdatedAt: v2 } });
  check('合并后用最新版本号重试成功', r.status === 200, r);
}

// ------------------------------------------------------------
section('7. 异常输入');
{
  let r = await call(env, 'PUT', '/api/sync', { token, body: { baseUpdatedAt: 0 } });
  check('缺少 data 字段被拒(400)', r.status === 400 && r.json.error === 'missing_data', r);

  r = await call(env, 'PUT', '/api/sync', { token, body: { data: { big: 'x'.repeat(1024 * 1024 + 10) }, baseUpdatedAt: 0 } });
  check('数据超过 1MB 被拒(413)', r.status === 413 && r.json.error === 'too_large', r.status);

  const req = new Request('https://sync.example.workers.dev/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{ not json'
  });
  const res = await worker.fetch(req, env);
  check('非法 JSON 被拒(400)', res.status === 400, res.status);
}

// ------------------------------------------------------------
section('8. 吊销令牌');
{
  const login = await call(env, 'POST', '/api/login', { body: { secret: password, kind: 'password' } });
  const t = login.json.token;
  let r = await call(env, 'GET', '/api/sync', { token: t });
  check('新令牌可用', r.status === 200, r.status);

  r = await call(env, 'POST', '/api/logout', { token: t });
  check('登出成功', r.status === 200 && r.json.ok === true, r);

  r = await call(env, 'GET', '/api/sync', { token: t });
  check('登出后该令牌失效', r.status === 401, r.status);

  // 当前 token 仍有效
  r = await call(env, 'GET', '/api/sync', { token });
  check('其他设备令牌不受影响', r.status === 200, r.status);

  r = await call(env, 'POST', '/api/logout-all', { token });
  check('全部登出成功', r.status === 200, r);
  r = await call(env, 'GET', '/api/sync', { token });
  check('logout-all 后当前令牌也失效', r.status === 401, r.status);

  const relogin = await call(env, 'POST', '/api/login', { body: { secret: password, kind: 'password' } });
  check('吊销后仍可用口令重新登录', relogin.status === 200, relogin.status);
}

// ------------------------------------------------------------
section('9. 凭据重发（首次初始化响应丢失时的补救）');
{
  // 先拿一个可用令牌，稍后验证重发会让它失效
  const before = await call(env, 'POST', '/api/login', { body: { secret: password, kind: 'password' } });
  const oldToken = before.json.token;
  check('重发前令牌可用', (await call(env, 'GET', '/api/sync', { token: oldToken })).status === 200);

  let r = await call(env, 'POST', '/api/reset-credentials', { body: { setupToken: 'wrong' } });
  check('错误 SETUP_TOKEN 被拒绝', r.status === 403 && r.json.error === 'bad_setup_token', r);

  r = await call(env, 'POST', '/api/reset-credentials', { body: { setupToken: SETUP_TOKEN } });
  check('正确 SETUP_TOKEN 重发成功', r.status === 200 && r.json.ok === true, r);
  check('返回新口令', typeof r.json.password === 'string' && r.json.password.length >= 16, r.json.password?.length);
  check('返回 10 个新备用码', Array.isArray(r.json.backupCodes) && r.json.backupCodes.length === 10, r.json.backupCodes?.length);
  const newPassword = r.json.password;
  const newCodes = r.json.backupCodes;

  check('新口令与旧口令不同', newPassword !== password, '口令未变化！');

  r = await call(env, 'POST', '/api/login', { body: { secret: password, kind: 'password' } });
  check('旧口令失效', r.status === 401, r.status);

  r = await call(env, 'POST', '/api/login', { body: { secret: newPassword, kind: 'password' } });
  check('新口令可登录', r.status === 200, r.status);
  const freshToken = r.json.token;

  r = await call(env, 'POST', '/api/login', { body: { secret: newCodes[0], kind: 'backup' } });
  check('新备用码可用', r.status === 200, r.status);

  r = await call(env, 'POST', '/api/login', { body: { secret: codes[5], kind: 'backup' } });
  check('旧备用码全部作废', r.status === 401, r.status);

  r = await call(env, 'GET', '/api/sync', { token: oldToken });
  check('重发后旧设备令牌被吊销', r.status === 401, r.status);

  r = await call(env, 'GET', '/api/sync', { token: freshToken });
  check('新登录的令牌可用', r.status === 200, r.status);

  // 与旧口令同名的哈希不应再存明文；顺带确认库中仍无明文口令
  const dump = env.DB._dump();
  check('数据库中仍无明文口令', !JSON.stringify(dump).includes(newPassword), '明文泄露！');
  check('数据库中仍无明文备用码', !dump.codes.some(c => JSON.stringify(c).includes(newCodes[0])), '明文泄露！');
  check('用户表仍只有 1 条记录（未重复创建）', dump.users.length === 1, dump.users.length);
}

// ------------------------------------------------------------
console.log('\n================ 结果 ================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
