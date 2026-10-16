// ============================================================
//  作业记录 · 账号与同步 API
//  运行环境：Cloudflare Workers + D1
//
//  安全设计：
//   - 口令用 PBKDF2-SHA256（15 万次迭代）加盐哈希，服务端不存明文
//   - 设备令牌是 32 字节随机值，数据库只存 SHA-256
//   - 备用码同样只存哈希，用过即标记，不可重用
//   - 所有受保护接口都必须带 Authorization: Bearer <设备令牌>
//   - CORS 只放行白名单来源，防止别的网站盗用你的接口
// ============================================================

import {
  randomHex, sha256Hex, pbkdf2Hex, timingSafeEqual,
  makeBackupCode, makePassword, normalizeCode
} from './crypto.js';

const PBKDF2_ITERATIONS = 150000;
const MAX_BLOB_BYTES = 1024 * 1024;   // 单个用户同步数据上限 1MB

// ------------------------------------------------------------
// 工具
// ------------------------------------------------------------
function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const allow = allowed.includes(origin) ? origin : (allowed[0] || '');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }, extraHeaders || {})
  });
}

async function readBody(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/** 校验设备令牌 -> 返回 { user_id } 或 null */
async function authUser(request, env) {
  const header = request.headers.get('Authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const tokenHash = await sha256Hex(m[1].trim());
  const row = await env.DB.prepare(
    'SELECT token_hash, user_id, revoked FROM devices WHERE token_hash = ?'
  ).bind(tokenHash).first();
  if (!row || row.revoked) return null;
  // 顺带刷新最后活跃时间（失败不影响主流程）
  try {
    await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE token_hash = ?')
      .bind(Date.now(), tokenHash).run();
  } catch (e) { /* 忽略 */ }
  return { user_id: row.user_id, token_hash: tokenHash };
}

// ------------------------------------------------------------
// 路由处理
// ------------------------------------------------------------

/** GET /api/health —— 探活，顺便告诉客户端服务是否已初始化 */
async function handleHealth(env) {
  let initialized = false;
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    initialized = !!(row && row.n > 0);
  } catch (e) {
    return json({ ok: false, error: 'db_error', detail: String(e && e.message || e) }, 500);
  }
  return json({ ok: true, service: 'homework-sync', initialized });
}

/**
 * POST /api/bootstrap —— 仅首次可用，创建 owner 账号
 * 需要 SETUP_TOKEN，成功后返回口令与备用码。
 * 因为设置了 SETUP_TOKEN，即使暴露在公网也只有你能初始化。
 */
async function handleBootstrap(request, env) {
  if (!env.SETUP_TOKEN) {
    return json({ ok: false, error: 'setup_disabled' }, 403);
  }
  const body = await readBody(request);
  if (body === null) return json({ ok: false, error: 'bad_json' }, 400);
  if (!timingSafeEqual(String(body.setupToken || ''), String(env.SETUP_TOKEN))) {
    return json({ ok: false, error: 'bad_setup_token' }, 403);
  }

  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (existing && existing.n > 0) {
    return json({ ok: false, error: 'already_initialized' }, 409);
  }

  const userId = randomHex(16);
  const username = (body.username || 'owner').trim() || 'owner';
  const password = makePassword();
  const salt = randomHex(16);
  const pwdHash = await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS);
  const now = Date.now();

  await env.DB.prepare(
    'INSERT INTO users (id, username, pwd_salt, pwd_hash, pwd_iter, created_at) VALUES (?,?,?,?,?,?)'
  ).bind(userId, username, salt, pwdHash, PBKDF2_ITERATIONS, now).run();

  // 生成 10 个一次性备用码
  const codes = [];
  const stmts = [];
  for (let i = 0; i < 10; i++) {
    const code = makeBackupCode();
    codes.push(code);
    stmts.push(
      env.DB.prepare('INSERT INTO backup_codes (code_hash, user_id, created_at) VALUES (?,?,?)')
        .bind(await sha256Hex(normalizeCode(code)), userId, now)
    );
  }
  await env.DB.batch(stmts);

  return json({
    ok: true,
    username,
    password,
    backupCodes: codes,
    warning: '口令与备用码只显示这一次，请立即保存到密码管理器'
  });
}

/**
 * POST /api/login —— 用口令或备用码换取设备令牌
 * body: { secret, kind: 'password'|'backup', label }
 */
async function handleLogin(request, env) {
  const body = await readBody(request);
  if (body === null) return json({ ok: false, error: 'bad_json' }, 400);

  const secret = String(body.secret || '');
  const kind = body.kind === 'backup' ? 'backup' : 'password';
  const label = String(body.label || '').slice(0, 60);
  if (!secret) return json({ ok: false, error: 'missing_secret' }, 400);

  const user = await env.DB.prepare('SELECT * FROM users ORDER BY created_at LIMIT 1').first();
  if (!user) return json({ ok: false, error: 'not_initialized' }, 409);

  let valid = false;
  if (kind === 'password') {
    const hash = await pbkdf2Hex(secret, user.pwd_salt, user.pwd_iter);
    valid = timingSafeEqual(hash, user.pwd_hash);
  } else {
    const codeHash = await sha256Hex(normalizeCode(secret));
    const row = await env.DB.prepare(
      'SELECT code_hash, used_at FROM backup_codes WHERE code_hash = ? AND user_id = ?'
    ).bind(codeHash, user.id).first();
    if (row && !row.used_at) {
      await env.DB.prepare('UPDATE backup_codes SET used_at = ? WHERE code_hash = ?')
        .bind(Date.now(), codeHash).run();
      valid = true;
    }
  }

  if (!valid) {
    // 统一错误，不区分“口令错”和“备用码错”，避免信息泄露
    return json({ ok: false, error: 'invalid_secret' }, 401);
  }

  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO devices (token_hash, user_id, label, created_at, last_seen_at, revoked) VALUES (?,?,?,?,?,0)'
  ).bind(tokenHash, user.id, label, now, now).run();

  const remaining = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM backup_codes WHERE user_id = ? AND used_at IS NULL'
  ).bind(user.id).first();

  return json({
    ok: true,
    token,                       // 仅此一次返回明文，之后只存哈希
    username: user.username,
    usedBackupCode: kind === 'backup',
    backupCodesLeft: remaining ? remaining.n : 0
  });
}

/** POST /api/logout —— 吊销当前设备令牌 */
async function handleLogout(request, env, auth) {
  await env.DB.prepare('UPDATE devices SET revoked = 1 WHERE token_hash = ?')
    .bind(auth.token_hash).run();
  return json({ ok: true });
}

/** POST /api/logout-all —— 吊销该用户全部设备（换手机 / 怀疑泄露时用） */
async function handleLogoutAll(request, env, auth) {
  await env.DB.prepare('UPDATE devices SET revoked = 1 WHERE user_id = ?')
    .bind(auth.user_id).run();
  return json({ ok: true });
}

/** GET /api/sync —— 拉取云端数据 */
async function handlePull(env, auth) {
  const row = await env.DB.prepare(
    'SELECT data, updated_at FROM sync_data WHERE user_id = ?'
  ).bind(auth.user_id).first();
  if (!row) {
    return json({ ok: true, data: null, updatedAt: 0 });
  }
  let parsed = null;
  try { parsed = JSON.parse(row.data); } catch (e) { parsed = null; }
  return json({ ok: true, data: parsed, updatedAt: row.updated_at });
}

/**
 * PUT /api/sync —— 推送数据
 * body: { data, baseUpdatedAt }
 * 乐观并发控制：若云端 updated_at 与客户端 baseUpdatedAt 不一致，
 * 返回 409 + 云端数据，让客户端合并后重试，避免覆盖掉另一台设备的改动。
 */
async function handlePush(request, env, auth) {
  const body = await readBody(request);
  if (body === null) return json({ ok: false, error: 'bad_json' }, 400);
  if (body.data === undefined || body.data === null) {
    return json({ ok: false, error: 'missing_data' }, 400);
  }

  const payload = JSON.stringify(body.data);
  if (payload.length > MAX_BLOB_BYTES) {
    return json({ ok: false, error: 'too_large', limit: MAX_BLOB_BYTES }, 413);
  }

  const base = Number(body.baseUpdatedAt || 0);
  const current = await env.DB.prepare(
    'SELECT updated_at FROM sync_data WHERE user_id = ?'
  ).bind(auth.user_id).first();

  if (current && current.updated_at !== base) {
    const row = await env.DB.prepare('SELECT data FROM sync_data WHERE user_id = ?')
      .bind(auth.user_id).first();
    let serverData = null;
    try { serverData = JSON.parse(row.data); } catch (e) { serverData = null; }
    return json({
      ok: false,
      error: 'conflict',
      data: serverData,
      updatedAt: current.updated_at
    }, 409);
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sync_data (user_id, data, updated_at) VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(auth.user_id, payload, now).run();

  return json({ ok: true, updatedAt: now });
}

/**
 * POST /api/reset-credentials —— 用 SETUP_TOKEN 重发一套凭据
 *
 * 用途：首次初始化成功但响应没收到（网络中断），或口令/备用码全丢了。
 * 因为 SETUP_TOKEN 也是你自己保管的机密，所以这不会变成后门。
 * 副作用：旧的备用码全部作废、所有设备令牌吊销（需要重新登录）。
 */
async function handleResetCredentials(request, env) {
  if (!env.SETUP_TOKEN) return json({ ok: false, error: 'setup_disabled' }, 403);

  const body = await readBody(request);
  if (body === null) return json({ ok: false, error: 'bad_json' }, 400);
  if (!timingSafeEqual(String(body.setupToken || ''), String(env.SETUP_TOKEN))) {
    return json({ ok: false, error: 'bad_setup_token' }, 403);
  }

  const user = await env.DB.prepare('SELECT * FROM users ORDER BY created_at LIMIT 1').first();
  if (!user) return json({ ok: false, error: 'not_initialized' }, 409);

  const password = makePassword();
  const salt = randomHex(16);
  const pwdHash = await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS);
  const now = Date.now();

  await env.DB.prepare('UPDATE users SET pwd_salt = ?, pwd_hash = ?, pwd_iter = ? WHERE id = ?')
    .bind(salt, pwdHash, PBKDF2_ITERATIONS, user.id).run();

  // 旧备用码全部作废，重新发 10 个
  await env.DB.prepare('DELETE FROM backup_codes WHERE user_id = ?').bind(user.id).run();
  const codes = [];
  const stmts = [];
  for (let i = 0; i < 10; i++) {
    const code = makeBackupCode();
    codes.push(code);
    stmts.push(
      env.DB.prepare('INSERT INTO backup_codes (code_hash, user_id, created_at) VALUES (?,?,?)')
        .bind(await sha256Hex(normalizeCode(code)), user.id, now)
    );
  }
  await env.DB.batch(stmts);

  // 所有旧设备令牌失效
  await env.DB.prepare('UPDATE devices SET revoked = 1 WHERE user_id = ?').bind(user.id).run();

  return json({
    ok: true,
    username: user.username,
    password,
    backupCodes: codes,
    warning: '旧口令、旧备用码与所有设备登录均已失效，请保存新的'
  });
}

// ------------------------------------------------------------
// 入口
// ------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const withCors = (res) => {
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    };

    try {
      // ---- 公开接口 ----
      if (path === '/api/health' && request.method === 'GET') {
        return withCors(await handleHealth(env));
      }
      if (path === '/api/bootstrap' && request.method === 'POST') {
        return withCors(await handleBootstrap(request, env));
      }
      if (path === '/api/login' && request.method === 'POST') {
        return withCors(await handleLogin(request, env));
      }
      if (path === '/api/reset-credentials' && request.method === 'POST') {
        return withCors(await handleResetCredentials(request, env));
      }

      // ---- 以下均需设备令牌 ----
      if (path.startsWith('/api/')) {
        const auth = await authUser(request, env);
        if (!auth) return withCors(json({ ok: false, error: 'unauthorized' }, 401));

        if (path === '/api/logout' && request.method === 'POST') {
          return withCors(await handleLogout(request, env, auth));
        }
        if (path === '/api/logout-all' && request.method === 'POST') {
          return withCors(await handleLogoutAll(request, env, auth));
        }
        if (path === '/api/sync' && request.method === 'GET') {
          return withCors(await handlePull(env, auth));
        }
        if (path === '/api/sync' && request.method === 'PUT') {
          return withCors(await handlePush(request, env, auth));
        }
        return withCors(json({ ok: false, error: 'not_found', path }, 404));
      }

      return withCors(json({ ok: true, service: 'homework-sync', hint: 'API 前缀为 /api' }, 200));
    } catch (err) {
      return withCors(json({
        ok: false, error: 'server_error',
        detail: String(err && err.message || err)
      }, 500));
    }
  }
};
