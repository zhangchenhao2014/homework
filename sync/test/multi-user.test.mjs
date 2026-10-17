// ============================================================
//  多账号测试
//
//  重点验证三件事：
//   1. 登录必须按账号名找账号（不能再"永远取第一个"）
//   2. 账号之间数据严格隔离（A 绝不能看到 B 的作业）
//   3. 兼容：单账号 + 老客户端（不带账号名）仍能登录
//
//  运行：node test/multi-user.test.mjs
// ============================================================

import worker from '../src/api.js';
import { makeMockD1 } from './mock-d1.js';

let pass = 0, fail = 0;
const check = (l, c, e) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); } };
const section = t => console.log('\n=== ' + t + ' ===');

const ORIGIN = 'https://zhangchenhao2014.github.io';

function makeEnv() {
  return { DB: makeMockD1(), ALLOWED_ORIGINS: ORIGIN };
}

async function call(env, method, path, { body, token } = {}) {
  const headers = { Origin: ORIGIN };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const req = new Request('https://sync.example.workers.dev' + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const res = await worker.fetch(req, env);
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}

const task = (id, name) => ({
  id, name, subject: '数学', vacation: '寒假', note: '',
  status: 'pending', createdAt: 1000, doneTime: null
});

// ============================================================
section('1. 两个账号：登录必须按账号名匹配');
const env = makeEnv();
let alice, bob;
{
  alice = await env.DB._seedUser({ username: 'alice', password: 'alice-pw-1111' });
  bob = await env.DB._seedUser({ username: 'bob', password: 'bob-pw-2222' });
  check('已种入两个账号', env.DB._dump().users.length === 2, env.DB._dump().users.length);

  let r = await call(env, 'POST', '/api/login', { body: { username: 'alice', secret: 'alice-pw-1111', kind: 'password' } });
  check('alice 用自己的口令登录成功', r.status === 200 && r.json.ok, r);
  check('返回的账号名是 alice', r.json.username === 'alice', r.json.username);
  const aliceToken = r.json.token;

  r = await call(env, 'POST', '/api/login', { body: { username: 'bob', secret: 'bob-pw-2222', kind: 'password' } });
  check('bob 用自己的口令登录成功', r.status === 200 && r.json.ok, r);
  check('返回的账号名是 bob（没串到 alice）', r.json.username === 'bob', r.json.username);
  const bobToken = r.json.token;

  // 关键：不能拿 alice 的账号名 + bob 的口令登进去
  r = await call(env, 'POST', '/api/login', { body: { username: 'alice', secret: 'bob-pw-2222', kind: 'password' } });
  check('账号与口令不匹配时拒绝（alice + bob 的口令）', r.status === 401, r.status);

  r = await call(env, 'POST', '/api/login', { body: { username: 'bob', secret: 'alice-pw-1111', kind: 'password' } });
  check('账号与口令不匹配时拒绝（bob + alice 的口令）', r.status === 401, r.status);

  // 账号名不存在
  r = await call(env, 'POST', '/api/login', { body: { username: 'nobody', secret: 'x', kind: 'password' } });
  check('账号不存在返回 401（与口令错一致，不泄露账号是否存在）', r.status === 401, r.status);

  // 多账号时不带账号名
  r = await call(env, 'POST', '/api/login', { body: { secret: 'alice-pw-1111', kind: 'password' } });
  check('多账号下不带账号名返回 need_username', r.status === 400 && r.json.error === 'need_username', r);

  env.__aliceToken = aliceToken;
  env.__bobToken = bobToken;
}

// ============================================================
section('2. 数据隔离：A 看不到 B 的作业');
{
  const aliceToken = env.__aliceToken;
  const bobToken = env.__bobToken;

  // alice 上传两条
  let r = await call(env, 'PUT', '/api/sync', {
    token: aliceToken,
    body: {
      data: { tasks: [task('a1', '爱丽丝的数学卷'), task('a2', '爱丽丝的作文')], sessions: [], vacations: ['寒假'] },
      baseUpdatedAt: 0
    }
  });
  check('alice 推送成功', r.status === 200, r);

  // bob 上传一条
  r = await call(env, 'PUT', '/api/sync', {
    token: bobToken,
    body: {
      data: { tasks: [task('b1', '鲍勃的物理作业')], sessions: [], vacations: ['寒假'] },
      baseUpdatedAt: 0
    }
  });
  check('bob 推送成功', r.status === 200, r);

  // alice 只应看到自己的 2 条
  r = await call(env, 'GET', '/api/sync', { token: aliceToken });
  const aliceNames = (r.json.data?.tasks || []).map(t => t.name).sort();
  check('alice 拉到自己的 2 项', aliceNames.length === 2, aliceNames);
  check('alice 的结果里没有 bob 的作业',
    !aliceNames.includes('鲍勃的物理作业'), aliceNames);

  // bob 只应看到自己的 1 条
  r = await call(env, 'GET', '/api/sync', { token: bobToken });
  const bobNames = (r.json.data?.tasks || []).map(t => t.name).sort();
  check('bob 拉到自己的 1 项', bobNames.length === 1, bobNames);
  check('bob 的结果里没有 alice 的作业',
    !bobNames.some(n => n.includes('爱丽丝')), bobNames);

  // 各自的数据行独立存在
  const dump = env.DB._dump();
  check('sync_data 里有两行（每账号一行）', dump.sync.length === 2, dump.sync.length);
}

// ============================================================
section('3. 令牌不能越界：A 的令牌只能操作 A 的数据');
{
  const aliceToken = env.__aliceToken;

  // 用 alice 的令牌推送，只会改 alice 自己的行
  const before = await call(env, 'GET', '/api/sync', { token: env.__bobToken });
  const bobBefore = JSON.stringify(before.json.data);

  const cur = await call(env, 'GET', '/api/sync', { token: aliceToken });
  const r = await call(env, 'PUT', '/api/sync', {
    token: aliceToken,
    body: { data: { tasks: [], sessions: [], vacations: ['寒假'] }, baseUpdatedAt: cur.json.updatedAt }
  });
  check('alice 清空自己的数据成功', r.status === 200, r);

  const after = await call(env, 'GET', '/api/sync', { token: env.__bobToken });
  check('bob 的数据完全没被影响', JSON.stringify(after.json.data) === bobBefore, '被改动了');
}

// ============================================================
section('4. 备用码：准确定位到所属账号（且不需要账号名）');
{
  let r = await call(env, 'POST', '/api/login', { body: { secret: bob.codes[0], kind: 'backup' } });
  check('用 bob 的备用码（不带账号名）登录成功', r.status === 200 && r.json.ok, r);
  check('登录后身份是 bob', r.json.username === 'bob', r.json.username);

  // alice 的备用码应该登成 alice，不能错位
  r = await call(env, 'POST', '/api/login', { body: { secret: alice.codes[0], kind: 'backup' } });
  check('用 alice 的备用码登录，身份是 alice', r.json.username === 'alice', r.json.username);

  // 一次性
  r = await call(env, 'POST', '/api/login', { body: { secret: alice.codes[0], kind: 'backup' } });
  check('同一备用码不能重复使用', r.status === 401, r.status);
}

// ============================================================
section('5. 兼容：单个账号时，不带账号名仍可登录');
{
  const env2 = makeEnv();
  const solo = await env2.DB._seedUser({ username: 'owner', password: 'solo-pw-9999' });

  let r = await call(env2, 'POST', '/api/login', { body: { secret: 'solo-pw-9999', kind: 'password' } });
  check('单账号 + 不带账号名 → 登录成功（老客户端兼容）', r.status === 200 && r.json.ok, r);
  check('身份正确', r.json.username === 'owner', r.json.username);

  r = await call(env2, 'POST', '/api/login', { body: { username: 'owner', secret: 'solo-pw-9999', kind: 'password' } });
  check('单账号 + 带账号名 → 也成功', r.status === 200, r);

  r = await call(env2, 'POST', '/api/login', { body: { username: 'wrong', secret: 'solo-pw-9999', kind: 'password' } });
  check('账号名写错 → 拒绝（不会回落到唯一账号）', r.status === 401, r.status);
}

// ============================================================
section('6. 空库');
{
  const env3 = makeEnv();
  const r = await call(env3, 'POST', '/api/login', { body: { username: 'x', secret: 'y', kind: 'password' } });
  check('没有任何账号时返回 not_initialized', r.status === 409 && r.json.error === 'not_initialized', r);
}

console.log('\n================ 结果 ================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
