// ============================================================
//  同步客户端（同步引擎的唯一副本）
//  这个文件被两个地方复用：
//   1. index.html 构建时把它的内容内联进 <script>（见 sync/build-page.mjs）
//   2. Node 测试直接 import
//  这样保证“测试过的逻辑”和“线上跑的逻辑”是同一份代码。
//
//  设计要点：
//   1. 本地优先：localStorage 始终可用，断网也能正常记作业
//   2. 合并按“集合”而不是“整块覆盖”：
//        - 作业按 id 去重，同一项取信息更完整的版本（已完成优先）
//        - 计时记录按 id 去重，取更完整的版本
//        - 取并集，绝不丢弃任一设备的记录
//   3. 推送带 baseUpdatedAt 做乐观并发控制：云端被另一台设备改过 -> 409，
//      客户端合并后自动重试（最多 4 轮），不会覆盖对方数据
// ============================================================

/** 取两个“同一项作业”中更可信的版本 */
export function pickTask(a, b) {
  if (!a) return b;
  if (!b) return a;
  const rank = (t) => (t.status === 'done' ? 2 : t.status === 'archived' ? 1 : 0);
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra > rb ? a : b;
  const ta = Number(a.doneTime || a.createdAt || 0);
  const tb = Number(b.doneTime || b.createdAt || 0);
  if (ta !== tb) return ta > tb ? a : b;
  // 时间也相同：合并字段，宁可保留备注/假期等有用信息
  return Object.assign({}, b, a, {
    note: a.note || b.note || '',
    vacation: a.vacation || b.vacation || '',
    subject: a.subject || b.subject || ''
  });
}

/** 取两个“同一段计时”中更完整的版本 */
export function pickSession(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ea = Number(a.endTime || 0), eb = Number(b.endTime || 0);
  if (ea !== eb) return ea > eb ? a : b;
  const da = Number(a.duration || 0), db = Number(b.duration || 0);
  if (da !== db) return da > db ? a : b;
  return a;
}

/** 按 id 合并两个数组，保留双方全部条目 */
export function mergeById(listA, listB, pick) {
  const out = new Map();
  for (const item of (listA || [])) {
    if (item && item.id) out.set(item.id, item);
  }
  for (const item of (listB || [])) {
    if (!item || !item.id) continue;
    out.set(item.id, out.has(item.id) ? pick(out.get(item.id), item) : item);
  }
  return [...out.values()];
}

/** 假期列表取并集，保持顺序稳定 */
export function mergeVacations(a, b) {
  const out = [];
  const seen = new Set();
  for (const v of [].concat(a || [], b || [])) {
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

/** 合并两个完整状态 */
export function mergeStates(localState, remoteState) {
  const local = localState || {};
  const remote = remoteState || {};
  let sessions = mergeById(local.sessions, remote.sessions, pickSession);

  // 两台设备可能各自留下一个“计时中”，合并后只保留开始较晚的一个
  const doing = sessions.filter(s => s && s.status === 'doing');
  if (doing.length > 1) {
    const keep = doing.reduce(
      (best, s) => (Number(s.startTime || 0) > Number(best.startTime || 0) ? s : best), doing[0]
    );
    sessions = sessions.map(s => (s.status === 'doing' && s.id !== keep.id)
      ? Object.assign({}, s, {
          status: 'abandoned',
          endTime: s.endTime || keep.startTime,
          duration: Number(s.duration || 0)
        })
      : s);
  }

  return {
    tasks: mergeById(local.tasks, remote.tasks, pickTask),
    sessions,
    vacations: mergeVacations(local.vacations, remote.vacations),
    currentVacation: local.currentVacation || remote.currentVacation || ''
  };
}

function resolveFetch(fetchLike) {
  const f = fetchLike || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) throw new Error('fetch_unavailable');
  return f;
}

function trimBase(apiBase) {
  return String(apiBase || '').replace(/\/+$/, '');
}

/**
 * 带冲突重试的推送。
 * @param {string} apiBase 服务地址
 * @param {string} token 设备令牌
 * @param {object} state 完整状态
 * @param {number} baseUpdatedAt 客户端记录的云端版本号
 * @param {Function} [fetchLike] 可注入，便于测试
 */
export async function pushWithRetry(apiBase, token, state, baseUpdatedAt, fetchLike) {
  const doFetch = resolveFetch(fetchLike);
  let current = state;
  let base = Number(baseUpdatedAt || 0);
  let lastBody = null;

  for (let round = 1; round <= 4; round++) {
    const res = await doFetch(trimBase(apiBase) + '/api/sync', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ data: current, baseUpdatedAt: base })
    });

    if (res.status === 200) {
      const body = await res.json();
      return { ok: true, updatedAt: body.updatedAt, rounds: round, merged: current };
    }

    if (res.status === 409) {
      const body = await res.json();
      current = mergeStates(current, body.data);   // 合并云端改动，绝不覆盖
      base = Number(body.updatedAt || 0);
      lastBody = body;
      continue;
    }

    let body = {};
    try { body = await res.json(); } catch (e) {}
    const err = new Error(body.error || ('HTTP ' + res.status));
    err.status = res.status;
    err.body = body;
    throw err;
  }

  const err = new Error('conflict_retry_exhausted');
  err.status = 409;
  err.body = lastBody;
  err.merged = current;
  throw err;
}

/** 拉取云端状态 */
export async function pull(apiBase, token, fetchLike) {
  const doFetch = resolveFetch(fetchLike);
  const res = await doFetch(trimBase(apiBase) + '/api/sync', {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token }
  });
  if (res.status === 401) {
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const err = new Error('pull_failed');
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  return { data: body.data, updatedAt: Number(body.updatedAt || 0) };
}

/** 登录：用口令或备用码换取设备令牌 */
export async function login(apiBase, secret, kind, label, fetchLike) {
  const doFetch = resolveFetch(fetchLike);
  const res = await doFetch(trimBase(apiBase) + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, kind: kind || 'password', label: label || '' })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    const err = new Error(body.error || ('HTTP ' + res.status));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/** 探活：确认服务地址可用、是否已初始化 */
export async function health(apiBase, fetchLike) {
  const doFetch = resolveFetch(fetchLike);
  const res = await doFetch(trimBase(apiBase) + '/api/health', { method: 'GET' });
  if (!res.ok) {
    const err = new Error('health_failed');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** 创建账号（仅首次可用），返回 { password, backupCodes } */
export async function bootstrap(apiBase, setupToken, username, fetchLike) {
  const doFetch = resolveFetch(fetchLike);
  const res = await doFetch(trimBase(apiBase) + '/api/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken, username: username || 'owner' })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    const err = new Error(body.error || ('HTTP ' + res.status));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * 用 SETUP_TOKEN 重发一套凭据（首次初始化响应丢失 / 凭据全丢时的补救）。
 * 副作用：旧口令与旧备用码作废，所有设备需重新登录。
 */
export async function resetCredentials(apiBase, setupToken, fetchLike) {
  const doFetch = resolveFetch(fetchLike);
  const res = await doFetch(trimBase(apiBase) + '/api/reset-credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    const err = new Error(body.error || ('HTTP ' + res.status));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/** 本设备登出 / 全部设备登出 */
export async function logout(apiBase, token, allDevices, fetchLike) {
  const doFetch = resolveFetch(fetchLike);
  const path = allDevices ? '/api/logout-all' : '/api/logout';
  const res = await doFetch(trimBase(apiBase) + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token }
  });
  return res.ok;
}
