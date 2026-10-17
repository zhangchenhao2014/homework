// ============================================================
//  本地测试用的 D1 模拟器（内存实现）
//  目的是在部署到 Cloudflare 之前，把 Worker 的 SQL 与业务逻辑跑通。
//  它按固定 SQL 语句匹配，未识别的语句会直接抛错 —— 这是刻意的，
//  这样一旦 worker.js 里改了 SQL 而模拟器没跟上，测试会立刻暴露。
// ============================================================

export function makeMockD1() {
  const users = new Map();          // id -> row
  const devices = new Map();        // token_hash -> row
  const codes = new Map();          // code_hash -> row
  const sync = new Map();           // user_id -> { data, updated_at }

  function rowsOf(map) {
    return [...map.values()];
  }

  function exec(sql, args) {
    const s = sql.replace(/\s+/g, ' ').trim();

    // ---- users ----
    if (/^SELECT COUNT\(\*\) AS n FROM users$/i.test(s)) {
      return { first: { n: users.size }, all: [{ n: users.size }] };
    }
    if (/^INSERT INTO users \(id, username, pwd_salt, pwd_hash, pwd_iter, created_at\) VALUES \(\?,\?,\?,\?,\?,\?\)$/i.test(s)) {
      const [id, username, pwd_salt, pwd_hash, pwd_iter, created_at] = args;
      users.set(id, { id, username, pwd_salt, pwd_hash, pwd_iter, created_at });
      return { first: null, all: [] };
    }
    if (/^SELECT \* FROM users ORDER BY created_at LIMIT 1$/i.test(s)) {
      const sorted = rowsOf(users).sort((a, b) => a.created_at - b.created_at);
      const row = sorted[0] || null;
      return { first: row, all: row ? [row] : [] };
    }
    if (/^SELECT \* FROM users WHERE username = \?$/i.test(s)) {
      const row = rowsOf(users).find(u => u.username === args[0]) || null;
      return { first: row, all: row ? [row] : [] };
    }
    if (/^SELECT \* FROM users WHERE id = \?$/i.test(s)) {
      const row = users.get(args[0]) || null;
      return { first: row, all: row ? [row] : [] };
    }
    if (/^UPDATE users SET pwd_salt = \?, pwd_hash = \?, pwd_iter = \? WHERE id = \?$/i.test(s)) {
      const [pwd_salt, pwd_hash, pwd_iter, id] = args;
      const u = users.get(id);
      if (u) Object.assign(u, { pwd_salt, pwd_hash, pwd_iter });
      return { first: null, all: [] };
    }
    if (/^DELETE FROM backup_codes WHERE user_id = \?$/i.test(s)) {
      for (const [k, c] of [...codes.entries()]) if (c.user_id === args[0]) codes.delete(k);
      return { first: null, all: [] };
    }

    // ---- devices ----
    if (/^SELECT token_hash, user_id, revoked FROM devices WHERE token_hash = \?$/i.test(s)) {
      const row = devices.get(args[0]) || null;
      return { first: row, all: row ? [row] : [] };
    }
    if (/^UPDATE devices SET last_seen_at = \? WHERE token_hash = \?$/i.test(s)) {
      const d = devices.get(args[1]);
      if (d) d.last_seen_at = args[0];
      return { first: null, all: [] };
    }
    if (/^INSERT INTO devices \(token_hash, user_id, label, created_at, last_seen_at, revoked\) VALUES \(\?,\?,\?,\?,\?,0\)$/i.test(s)) {
      const [token_hash, user_id, label, created_at, last_seen_at] = args;
      devices.set(token_hash, { token_hash, user_id, label, created_at, last_seen_at, revoked: 0 });
      return { first: null, all: [] };
    }
    if (/^UPDATE devices SET revoked = 1 WHERE token_hash = \?$/i.test(s)) {
      const d = devices.get(args[0]);
      if (d) d.revoked = 1;
      return { first: null, all: [] };
    }
    if (/^UPDATE devices SET revoked = 1 WHERE user_id = \?$/i.test(s)) {
      for (const d of devices.values()) if (d.user_id === args[0]) d.revoked = 1;
      return { first: null, all: [] };
    }

    // ---- backup_codes ----
    if (/^INSERT INTO backup_codes \(code_hash, user_id, created_at\) VALUES \(\?,\?,\?\)$/i.test(s)) {
      const [code_hash, user_id, created_at] = args;
      codes.set(code_hash, { code_hash, user_id, created_at, used_at: null });
      return { first: null, all: [] };
    }
    if (/^SELECT code_hash, used_at FROM backup_codes WHERE code_hash = \? AND user_id = \?$/i.test(s)) {
      const row = codes.get(args[0]);
      const ok = row && row.user_id === args[1] ? row : null;
      return { first: ok, all: ok ? [ok] : [] };
    }
    // 多账号后：备用码本身即可定位账号，不再需要 username
    if (/^SELECT code_hash, used_at, user_id FROM backup_codes WHERE code_hash = \?$/i.test(s)) {
      const row = codes.get(args[0]) || null;
      return { first: row, all: row ? [row] : [] };
    }
    if (/^UPDATE backup_codes SET used_at = \? WHERE code_hash = \?$/i.test(s)) {
      const c = codes.get(args[1]);
      if (c) c.used_at = args[0];
      return { first: null, all: [] };
    }
    if (/^SELECT COUNT\(\*\) AS n FROM backup_codes WHERE user_id = \? AND used_at IS NULL$/i.test(s)) {
      const n = rowsOf(codes).filter(c => c.user_id === args[0] && c.used_at === null).length;
      return { first: { n }, all: [{ n }] };
    }

    // ---- sync_data ----
    if (/^SELECT data, updated_at FROM sync_data WHERE user_id = \?$/i.test(s)) {
      const row = sync.get(args[0]) || null;
      return { first: row, all: row ? [row] : [] };
    }
    if (/^SELECT updated_at FROM sync_data WHERE user_id = \?$/i.test(s)) {
      const row = sync.get(args[0]);
      const out = row ? { updated_at: row.updated_at } : null;
      return { first: out, all: out ? [out] : [] };
    }
    if (/^SELECT data FROM sync_data WHERE user_id = \?$/i.test(s)) {
      const row = sync.get(args[0]);
      const out = row ? { data: row.data } : null;
      return { first: out, all: out ? [out] : [] };
    }
    if (/^INSERT INTO sync_data \(user_id, data, updated_at\) VALUES \(\?,\?,\?\) ON CONFLICT\(user_id\) DO UPDATE SET data = excluded\.data, updated_at = excluded\.updated_at$/i.test(s)) {
      const [user_id, data, updated_at] = args;
      sync.set(user_id, { user_id, data, updated_at });
      return { first: null, all: [] };
    }

    throw new Error('MockD1 未识别的 SQL：' + s);
  }

  function statement(sql) {
    let bound = [];
    return {
      bind(...args) { bound = args; return this; },
      async first() { return exec(sql, bound).first; },
      async all() { const r = exec(sql, bound); return { results: r.all }; },
      async run() { exec(sql, bound); return { success: true }; },
      _exec() { return exec(sql, bound); }
    };
  }

  return {
    prepare(sql) { return statement(sql); },
    async batch(stmts) {
      return stmts.map(st => { st._exec(); return { success: true }; });
    },
    // 测试辅助
    _dump() {
      return {
        users: rowsOf(users), devices: rowsOf(devices),
        codes: rowsOf(codes), sync: rowsOf(sync)
      };
    },
    /**
     * 测试辅助：直接种一个账号（模拟 admin.mjs 建号后的数据库状态）。
     * 用与 api.js 相同的 PBKDF2 参数，所以能真实走登录校验。
     * @returns {Promise<{id, username, password, codes}>}
     */
    async _seedUser({ username, password, iterations = 100000, codeCount = 10 }) {
      const { pbkdf2Hex, sha256Hex, randomHex, makeBackupCode, normalizeCode } = await import('../src/crypto.js');
      const id = randomHex(16);
      const salt = randomHex(16);
      const hash = await pbkdf2Hex(password, salt, iterations);
      const now = Date.now();
      users.set(id, { id, username, pwd_salt: salt, pwd_hash: hash, pwd_iter: iterations, created_at: now });

      const codeList = [];
      for (let i = 0; i < codeCount; i++) {
        const code = makeBackupCode();
        codeList.push(code);
        const h = await sha256Hex(normalizeCode(code));
        codes.set(h, { code_hash: h, user_id: id, created_at: now, used_at: null });
      }
      return { id, username, password, codes: codeList };
    }
  };
}
