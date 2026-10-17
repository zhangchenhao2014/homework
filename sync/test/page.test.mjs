// ============================================================
//  页面集成测试：用最小 DOM 桩执行 index.html 里的真实脚本，
//  配一个模拟同步服务，验证「登录 → 同步 → 合并」整条链路。
//  运行：node page.test.mjs
// ============================================================

import fs from 'fs';
import vm from 'vm';

const PAGE = 'C:\\Users\\章陈镐\\Desktop\\self\\vibecoding\\homework\\index.html';
const code = fs.readFileSync(PAGE, 'utf8').match(/<script defer>([\s\S]*?)<\/script>/)[1];

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ---------- 最小 DOM 桩 ----------
class El {
  constructor(id) {
    this.id = id; this._html = ''; this.textContent = ''; this.value = '';
    this.style = {}; this.dataset = {}; this.listeners = {}; this.disabled = false;
    this.placeholder = ''; this.className = ''; this.children = [];
  }
  set innerHTML(v) { this._html = String(v); this._sync(); }
  get innerHTML() { return this._html; }
  _sync() {
    // 从 innerHTML 里提取子元素 id / class，模拟 querySelector
    this._ids = new Set([...this._html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
    this._classes = new Set(
      [...this._html.matchAll(/class="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/))
    );
  }
  querySelector(sel) {
    const s = String(sel);
    const byId = s.match(/^#(.+)$/);
    if (byId) {
      if (!this._ids || !this._ids.has(byId[1])) return null;
      return getEl(byId[1]);
    }
    const byClass = s.match(/^\.([\w-]+)$/);
    if (byClass) {
      if (!this._classes || !this._classes.has(byClass[1])) return null;
      // 返回一个能继续用 #id 取子元素的代理元素
      const proxy = new El('__' + byClass[1]);
      proxy.innerHTML = this._html;
      return proxy;
    }
    return null;
  }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  click() { (this.listeners.click || []).forEach(f => f({ target: this, closest: () => this })); }
  closest() { return this; }
  appendChild(c) { this.children.push(c); }
  removeChild(c) { this.children = this.children.filter(x => x !== c); }
  includes(s) { return (this._html + ' ' + this.textContent).includes(s); }
  focus() {}
}

const els = new Map();
function getEl(id) { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); }
const document = {
  readyState: 'complete',
  getElementById: getEl,
  addEventListener() {},
  createElement: () => new El('tmp')
};

// ---------- 定时器 ----------
// 用真实定时器：页面同步是异步的（fetch + 700ms 防抖推送），
// 若把 setTimeout 换成空实现，Promise 链会永远悬在“同步中”。
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 模拟同步服务 ----------
function makeServer() {
  const state = { users: 1, devices: new Map(), store: null, calls: [] };
  const ORIGIN = 'https://zhangchenhao2014.github.io';

  function json(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ORIGIN }
    });
  }
  function authorized(opts) {
    const h = (opts && opts.headers) || {};
    const m = String(h['Authorization'] || h['authorization'] || '').match(/^Bearer\s+(.+)$/);
    if (!m || !state.devices.has(m[1].trim())) return null;
    return m[1].trim();
  }

  const fetchLike = async (url, opts) => {
    opts = opts || {};
    const path = new URL(url).pathname;
    state.calls.push({ path, method: opts.method || 'GET' });

    if (path === '/api/health') return json({ ok: true, service: 'homework-sync', initialized: true });

    if (path === '/api/login' && opts.method === 'POST') {
      const body = JSON.parse(opts.body || '{}');
      const okSecret = body.secret === 'CORRECT-PASSWORD' || body.secret === 'AAAA-BBBB-CCCC-DDDD';
      if (!okSecret) return json({ ok: false, error: 'invalid_secret' }, 401);
      const token = 'tok-' + Math.random().toString(36).slice(2).padEnd(12, '0');
      state.devices.set(token, { label: body.label || '' });
      return json({ ok: true, token, username: 'owner', backupCodesLeft: 9 });
    }

    const token = authorized(opts);
    if (!token) return json({ ok: false, error: 'unauthorized' }, 401);

    if (path === '/api/logout') { state.devices.delete(token); return json({ ok: true }); }
    if (path === '/api/logout-all') { state.devices.clear(); return json({ ok: true }); }

    if (path === '/api/sync' && (!opts.method || opts.method === 'GET')) {
      if (!state.store) return json({ ok: true, data: null, updatedAt: 0 });
      return json({ ok: true, data: state.store.data, updatedAt: state.store.updatedAt });
    }

    if (path === '/api/sync' && opts.method === 'PUT') {
      const body = JSON.parse(opts.body || '{}');
      if (!state.store) {
        state.store = { data: body.data, updatedAt: 1000 };
        return json({ ok: true, updatedAt: 1000 });
      }
      if (state.store.updatedAt !== body.baseUpdatedAt) {
        return json({ ok: false, error: 'conflict', data: state.store.data, updatedAt: state.store.updatedAt }, 409);
      }
      state.store = { data: body.data, updatedAt: state.store.updatedAt + 1 };
      return json({ ok: true, updatedAt: state.store.updatedAt });
    }

    return json({ ok: false, error: 'not_found', path }, 404);
  };

  return { state, fetchLike };
}

// ---------- 启动一个页面实例 ----------
function bootPage(storageInit, server) {
  const map = new Map(Object.entries(storageInit || {}));
  const localStorage = {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, k === '__never__' ? v : String(v)),
    removeItem: k => map.delete(k)
  };
  const sandbox = {
    document, localStorage,
    console: { log() {}, error() {}, warn() {} },
    window: { addEventListener() {}, performance: { now: () => Date.now() } },
    navigator: { userAgent: 'node-test', onLine: true },
    alert: () => {}, confirm: () => true, prompt: () => null,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: server.fetchLike,
    Date, Math, JSON, String, Number, Array, Object, RegExp, Set, Map, Error, Promise,
    performance: { now: () => Date.now() },
    Response, Request,
    Blob: function () {},
    // 注意：URL 必须是真正的构造函数（页面里 new URL() 要用），
    // 只在上面挂 createObjectURL / revokeObjectURL 两个静态方法
    URL: Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL() {} })
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // 把页面脚本和一段只读探针拼成同一个脚本执行：
  // Node 的 vm 里顶层 function/let 属于脚本作用域，分开 runInContext 读不到，
  // 测试也就无法确定「同步到底跑完没有」——只能靠 sleep 猜，必然偶发失败。
  vm.runInContext(code + '\n' + `
globalThis.__probe = function () {
  return {
    syncState: syncState,
    syncMessage: syncMessage,
    loggedIn: isLoggedIn(),
    taskCount: tasks.length,
    sessionCount: sessions.length,
    modalOpen: document.getElementById('modalRoot').innerHTML !== '',
    acctText: document.getElementById('acctText').textContent
  };
};
`, sandbox);
  return { sandbox, map, storage: localStorage };
}

const flush = async (n = 40) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/** 轮询等待条件成立，避免用固定 sleep 猜异步时序 */
async function waitFor(fn, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await flush(10);
    if (fn()) { await flush(20); return true; }
    await sleep(25);
  }
  console.log(`     （等待超时：${label}）`);
  return false;
}

/** 等到同步彻底停下来（既不在同步中，也没有待推送） */
async function settle(app) {
  // 弹窗打开时（例如“选择合并方式”）应用正等用户决定，不会有后续异步动作
  await waitFor(() => {
    const p = app.sandbox.__probe();
    return p.syncState !== 'syncing' || p.modalOpen;
  }, '同步结束', 6000);
  // 再等到一次防抖推送完成
  await sleep(900);
  await flush(20);
}

// 注意：页面里 tasks/sessions 是 let 声明，不会挂到 vm sandbox 上，
// 因此一律通过 localStorage（也就是“页面真正持久化的数据”）来断言。
const readTasks = (app) => JSON.parse(app.map.get('hw_tasks') || '[]');
const readSessions = (app) => JSON.parse(app.map.get('hw_records') || '[]');

const task = (id, over) => Object.assign({
  id, name: '作业' + id, subject: '数学', vacation: '寒假', note: '',
  status: 'pending', createdAt: 1000, doneTime: null
}, over || {});

// ============================================================
section('1. 未登录：页面正常，显示登录引导');
{
  const server = makeServer();
  const app = bootPage({}, server);
  await settle(app);

  check('注入的同步引擎在页面里可用',
    typeof app.sandbox.mergeStates === 'function' && typeof app.sandbox.pushWithRetry === 'function');
  check('本地功能仍可用（无作业时提示）',
    getEl('pendingList').innerHTML.includes('完成啦') || getEl('pendingList').innerHTML.includes('还没有'));
  check('账号栏显示未登录', getEl('acctText').textContent.includes('未登录'), getEl('acctText').textContent);
  check('提示条引导登录', getEl('syncBar').innerHTML.includes('登录 / 开启同步'), getEl('syncBar').innerHTML.slice(0, 80));
  check('未登录时不发起网络请求', server.state.calls.length === 0, server.state.calls);
}

// ============================================================
section('2. 未登录时点账号按钮 → 弹出登录框');
{
  const server = makeServer();
  const localTasks = [task('L1'), task('L2', { status: 'done', doneTime: 5000 })];
  const app = bootPage({
    hw_tasks: JSON.stringify(localTasks),
    hw_records: JSON.stringify([]),
    hw_api_base: JSON.stringify('https://sync.test'),
    hw_current_vacation: JSON.stringify('寒假')
  }, server);
  await settle(app);

  check('未登录时账号栏提示仅本机', getEl('acctText').textContent.includes('未登录'), getEl('acctText').textContent);
  check('未登录时数据仍在本机可用', readTasks(app).length === 2, readTasks(app).length);

  getEl('acctBtn').onclick && getEl('acctBtn').onclick();
  check('未登录点账号按钮弹出登录框', getEl('modalRoot').innerHTML.includes('登录以同步数据'),
    getEl('modalRoot').innerHTML.slice(0, 60));
  check('登录框预填了服务地址', getEl('modalRoot').innerHTML.includes('https://sync.test'));

  // 关闭弹窗，避免影响后续
  app.sandbox.closeModal();
}

// ============================================================
section('3. 登录（口令正确）→ 本机数据自动上传 + 本地改动自动推送');
{
  const server = makeServer();
  const localTasks = [task('L1'), task('L2', { status: 'done', doneTime: 5000 })];
  const app = bootPage({
    hw_tasks: JSON.stringify(localTasks),
    hw_records: JSON.stringify([]),
    hw_api_base: JSON.stringify('https://sync.test'),
    hw_current_vacation: JSON.stringify('寒假')
  }, server);
  await settle(app);

  check('有账号无令牌时仍显示未登录（需验证身份）',
    getEl('acctText').textContent.includes('未登录'), getEl('acctText').textContent);
  check('未登录时不发起网络请求', server.state.calls.length === 0, server.state.calls);
}
{
  const server = makeServer();
  const localTasks = [task('L1'), task('L2', { status: 'done', doneTime: 5000 })];
  const app = bootPage({
    hw_tasks: JSON.stringify(localTasks),
    hw_records: JSON.stringify([]),
    hw_api_base: JSON.stringify('https://sync.test'),
    hw_current_vacation: JSON.stringify('寒假')
  }, server);
  await settle(app);

  const modal = {
    querySelector: (sel) => {
      const vals = {
        '#mErr': getEl('mErr'), '#mOk': getEl('mOk'), '#mKind': { value: 'password' },
        '#mApi': { value: 'https://sync.test' }, '#mSecret': { value: 'CORRECT-PASSWORD' },
        '#mUser': { value: 'owner' }
      };
      return vals[sel] || getEl(sel.replace('#', ''));
    }
  };
  await app.sandbox.doLogin(modal);
  await settle(app);

  check('登录成功：弹窗已关闭', getEl('modalRoot').innerHTML === '', getEl('modalRoot').innerHTML.slice(0, 60));
  check('令牌已保存到本机', !!app.map.get('hw_device_token'), app.map.get('hw_device_token'));
  check('服务地址已保存', app.map.get('hw_api_base') === '"https://sync.test"', app.map.get('hw_api_base'));
  check('本机 2 项作业已上传到云端',
    server.state.store && server.state.store.data.tasks.length === 2,
    server.state.store && server.state.store.data.tasks.length);
  check('账号栏显示已同步', getEl('acctText').textContent.includes('已同步'), getEl('acctText').textContent);
  check('登录引导条消失', !getEl('syncBar').innerHTML.includes('登录 / 开启同步'));

  // ---- 本地改动会自动推送 ----
  getEl('taskSubject').value = '英语';
  getEl('taskName').value = '新加的英语作业';
  getEl('addBtn').onclick();
  await settle(app);

  const pushed = server.state.store.data.tasks.map(t => t.name);
  check('新增作业后自动推送到云端', pushed.includes('新加的英语作业'), pushed);
  check('推送是防抖的（不会每输入一次就请求）',
    server.state.calls.filter(c => c.method === 'PUT').length <= 3,
    server.state.calls.filter(c => c.method === 'PUT').length);
}

// ============================================================
section('4. 第二台设备：登录后看到同一账号的数据');
{
  const server = makeServer();
  // 设备 A：登录并写入数据
  const a = bootPage({
    hw_tasks: JSON.stringify([task('A1')]),
    hw_records: JSON.stringify([]),
    hw_api_base: JSON.stringify('https://sync.test')
  }, server);
  await settle(a);
  const modal = (secret) => ({
    querySelector: (sel) => ({
      '#mErr': getEl('mErr'), '#mOk': getEl('mOk'), '#mKind': { value: 'password' },
      '#mApi': { value: 'https://sync.test' }, '#mSecret': { value: secret },
      '#mUser': { value: 'owner' }
    }[sel] || getEl(sel.replace('#', '')))
  });
  await a.sandbox.doLogin(modal('CORRECT-PASSWORD'));
  await settle(a);
  check('设备A 已上传 1 项作业',
    server.state.store.data.tasks.length === 1, server.state.store.data.tasks.length);

  // 设备 B：全新浏览器，先放一个不同的作业，再登录 -> 应自动合并
  const b = bootPage({
    hw_tasks: JSON.stringify([task('B1', { name: '手机上的作业' })]),
    hw_records: JSON.stringify([]),
    hw_api_base: JSON.stringify('https://sync.test')
  }, server);
  await settle(b);

  const modalB = {
    querySelector: (sel) => ({
      '#mErr': getEl('mErr'), '#mOk': getEl('mOk'), '#mKind': { value: 'password' },
      '#mApi': { value: 'https://sync.test' }, '#mSecret': { value: 'CORRECT-PASSWORD' },
        '#mUser': { value: 'owner' }
    }[sel] || getEl(sel.replace('#', '')))
  };
  await b.sandbox.doLogin(modalB);
  await settle(b);

  // 两边都有数据 -> 出现“合并/只用云端”选择；默认点合并
  const mergePicker = getEl('modalRoot');
  check('两边都有数据时弹出合并选择', mergePicker.innerHTML.includes('发现两份数据'),
    mergePicker.innerHTML.slice(0, 80));

  const mergeBtn = mergePicker.querySelector ? mergePicker.querySelector('#mMerge') : null;
  if (mergeBtn) { mergeBtn.onclick(); await settle(b); }

  const names = server.state.store.data.tasks.map(t => t.name).sort();
  check('合并后云端同时有两台设备的作业',
    names.includes('作业A1') && names.includes('手机上的作业'), names);
  check('设备B 本地也拿到两台设备的作业',
    readTasks(b).length === 2, readTasks(b).map(t => t.name));
  check('合并后账号栏为已同步', getEl('acctText').textContent.includes('已同步'), getEl('acctText').textContent);
}

// ============================================================
section('5. 令牌失效（在别的设备退出全部）→ 提示重新登录');
{
  const server = makeServer();
  const app = bootPage({
    hw_tasks: JSON.stringify([task('A1')]),
    hw_records: JSON.stringify([]),
    hw_api_base: JSON.stringify('https://sync.test'),
    hw_device_token: JSON.stringify('stale-token-not-on-server')
  }, server);
  await settle(app);

  check('失效令牌被清除', !app.map.get('hw_device_token') || app.map.get('hw_device_token') === '""',
    app.map.get('hw_device_token'));
  check('弹出重新验证提示', getEl('modalRoot').innerHTML.includes('重新验证') || getEl('modalRoot').innerHTML.includes('登录'),
    getEl('modalRoot').innerHTML.slice(0, 80));
  check('本地作业记录没有被删掉', readTasks(app).length === 1, readTasks(app).length);
}

// ============================================================
section('6. 云端比本地新：启动时自动拉取合并');
{
  const server = makeServer();
  // 先在云端放数据（模拟另一台设备已经记了作业）
  const login = await server.fetchLike('https://sync.test/api/login', {
    method: 'POST', body: JSON.stringify({ secret: 'CORRECT-PASSWORD' })
  });
  const token = (await login.json()).token;
  await server.fetchLike('https://sync.test/api/sync', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { tasks: [task('CLOUD1'), task('CLOUD2')], sessions: [] }, baseUpdatedAt: 0 })
  });

  const app = bootPage({
    hw_tasks: JSON.stringify([task('LOCAL1')]),
    hw_records: JSON.stringify([]),
    hw_api_base: JSON.stringify('https://sync.test'),
    hw_device_token: JSON.stringify(token),
    hw_remote_updated_at: JSON.stringify(server.state.store.updatedAt)
  }, server);
  await settle(app);
  await settle(app);

  const ids = readTasks(app).map(t => t.id).sort();
  check('启动后本地作业 = 云端2项 + 本地1项', ids.length === 3, ids);
  check('云端两项都在', ids.includes('CLOUD1') && ids.includes('CLOUD2'), ids);
  check('本地那项也没丢（合并而非覆盖）', ids.includes('LOCAL1'), ids);
  check('账号栏显示已同步', getEl('acctText').textContent.includes('已同步'), getEl('acctText').textContent);
}

// ============================================================
section('7. 同步失败时本地数据完好');
{
  const server = makeServer();
  const failing = async () => { throw new Error('network down'); };
  server.fetchLike = failing;
  const app = bootPage({
    hw_tasks: JSON.stringify([task('KEEP1'), task('KEEP2')]),
    hw_records: JSON.stringify([]),
    hw_api_base: JSON.stringify('https://sync.test'),
    hw_device_token: JSON.stringify('some-token')
  }, server);
  await settle(app);

  check('本地 2 项作业仍然存在', readTasks(app).length === 2, readTasks(app).length);
  check('界面提示同步失败', getEl('syncBar').innerHTML.includes('同步失败'), getEl('syncBar').innerHTML.slice(0, 80));
  check('本地存储未被破坏', JSON.parse(app.map.get('hw_tasks')).length === 2);
  check('账号栏显示同步失败', getEl('acctText').textContent.includes('失败'), getEl('acctText').textContent);
}

// ============================================================
section('8. 原有的本地功能未被破坏');
{
  const server = makeServer();
  const app = bootPage({}, server);
  await settle(app);

  check('科目仍是五门',
    JSON.stringify([...getEl('taskSubject').innerHTML.matchAll(/value="([^"]+)"/g)].map(m => m[1]))
    === JSON.stringify(['语文', '数学', '英语', '科学', '文综']),
    getEl('taskSubject').innerHTML);

  getEl('taskSubject').value = '数学';
  getEl('taskName').value = '本地回归测试作业';
  getEl('addBtn').onclick();
  await settle(app);
  check('添加作业仍然可用', readTasks(app).length === 1, readTasks(app).length);
  check('未登录时添加不会发请求', server.state.calls.length === 0, server.state.calls);

  const t = readTasks(app)[0];
  app.sandbox.startTimer(t.id);
  await settle(app);
  check('开始计时仍然可用', readSessions(app).some(s => s.status === 'doing'));
  app.sandbox.markDone(t.id);
  await settle(app);
  check('标记完成仍然可用', readTasks(app)[0].status === 'done');
  check('计时记录已结算', readSessions(app).every(s => s.status !== 'doing'));
}

// ============================================================
console.log('\n================ 结果 ================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
