// ============================================================
//  同步引擎测试：重点验证“合并绝不丢数据”
//  运行：node test/sync.test.mjs
// ============================================================

import {
  pickTask, pickSession, mergeById, mergeStates, mergeVacations, pushWithRetry
} from '../src/sync-client.js';

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const task = (id, over) => Object.assign({
  id, name: '作业' + id, subject: '数学', vacation: '寒假',
  note: '', status: 'pending', createdAt: 1000, doneTime: null
}, over || {});

const sess = (id, taskId, over) => Object.assign({
  id, taskId, taskName: '作业' + taskId, subject: '数学', vacation: '寒假',
  startTime: 1000, endTime: 2000, duration: 1000, status: 'done'
}, over || {});

const state = (tasks, sessions) => ({ tasks: tasks || [], sessions: sessions || [] });

// ------------------------------------------------------------
section('1. 作业合并规则');
{
  check('一边为空时保留另一边', pickTask(null, task('a')).id === 'a');
  check('两边都有且都是 pending 时按时间取较新', pickTask(
    task('a', { createdAt: 100 }), task('a', { createdAt: 200, note: '新的' })
  ).note === '新的');

  const done = task('a', { status: 'done', doneTime: 3000 });
  const pending = task('a', { status: 'pending', createdAt: 5000 });
  check('已完成版本优先于未完成版本（不因时间戳回退）', pickTask(pending, done).status === 'done');
  check('已完成优先对调顺序也成立', pickTask(done, pending).status === 'done');

  const withNote = task('a', { note: '共20页' });
  const noNote = task('a', { note: '' });
  check('时间相同时保留非空备注', pickTask(noNote, withNote).note === '共20页');
  check('时间相同时保留假期字段', pickTask(
    task('a', { vacation: '' }), task('a', { vacation: '暑假' })
  ).vacation === '暑假');
}

// ------------------------------------------------------------
section('2. 计时记录合并规则');
{
  check('取 endTime 更晚的版本', pickSession(
    sess('s1', 'a', { endTime: 5000 }), sess('s1', 'a', { endTime: 9000 })
  ).endTime === 9000);
  check('endTime 相同时取 duration 更长的', pickSession(
    sess('s1', 'a', { duration: 100 }), sess('s1', 'a', { duration: 900 })
  ).duration === 900);
  check('进行中(endTime=null)不会覆盖已结束的记录', pickSession(
    sess('s1', 'a', { endTime: null, status: 'doing', duration: 0 }),
    sess('s1', 'a', { endTime: 8000, status: 'done', duration: 7000 })
  ).status === 'done');
}

// ------------------------------------------------------------
section('3. 数组合并：绝不丢条目');
{
  const a = [task('1'), task('2')];
  const b = [task('2', { note: 'B改过' }), task('3')];
  const merged = mergeById(a, b, pickTask);
  check('合并后有三个作业（并集）', merged.length === 3, merged.map(t => t.id));
  check('重复项被合并为一条', merged.filter(t => t.id === '2').length === 1);
  check('缺失的条目被补齐', merged.some(t => t.id === '3'));
  check('没有 id 的脏数据被忽略', mergeById([{ name: '无id' }], [], pickTask).length === 0);
}

// ------------------------------------------------------------
section('4. 完整状态合并');
{
  const local = state(
    [task('1'), task('2')],
    [sess('s1', '1', { duration: 60000 })]
  );
  const remote = state(
    [task('2', { status: 'done', doneTime: 9000 }), task('3')],
    [sess('s1', '1', { duration: 60000 }), sess('s2', '2', { duration: 120000 })]
  );

  const m = mergeStates(local, remote);
  check('作业取并集：3 项', m.tasks.length === 3, m.tasks.map(t => t.id));
  check('作业2 采用云端“已完成”状态', m.tasks.find(t => t.id === '2').status === 'done');
  check('计时记录取并集：2 段', m.sessions.length === 2, m.sessions.map(s => s.id));
  check('累计用时不会互相覆盖', m.sessions.reduce((s, x) => s + x.duration, 0) === 180000,
    m.sessions.reduce((s, x) => s + x.duration, 0));

  const mergedAgain = mergeStates(m, local);
  check('合并是幂等的（不会重复膨胀）', mergedAgain.tasks.length === 3 && mergedAgain.sessions.length === 2,
    [mergedAgain.tasks.length, mergedAgain.sessions.length]);

  const bothEmpty = mergeStates(state(), state());
  check('两边都为空时安全返回', bothEmpty.tasks.length === 0 && bothEmpty.sessions.length === 0);
  const nullSafe = mergeStates(null, null);
  check('传入 null 不崩溃', Array.isArray(nullSafe.tasks) && Array.isArray(nullSafe.sessions));
}

// ------------------------------------------------------------
section('5. 合并后不会出现两个“计时中”');
{
  const local = state([task('1'), task('2')], [
    sess('s1', '1', { status: 'doing', endTime: null, duration: 0, startTime: 5000 })
  ]);
  const remote = state([task('1'), task('2')], [
    sess('s2', '2', { status: 'doing', endTime: null, duration: 0, startTime: 9000 })
  ]);
  const m = mergeStates(local, remote);
  const doing = m.sessions.filter(s => s.status === 'doing');
  check('合并后只剩一个 doing', doing.length === 1, doing.map(s => s.id));
  check('保留的是开始时间较晚的那个', doing[0].id === 's2', doing[0] && doing[0].id);
  check('被收敛的那段被标记为 abandoned', m.sessions.some(s => s.id === 's1' && s.status === 'abandoned'));
}

// ------------------------------------------------------------
section('6. 假期列表合并');
{
  check('取并集', JSON.stringify(mergeVacations(['寒假'], ['暑假', '寒假'])) === JSON.stringify(['寒假', '暑假']));
  check('去重且保序', JSON.stringify(mergeVacations(['b', 'a'], ['a', 'c'])) === JSON.stringify(['b', 'a', 'c']));
  check('空值安全', JSON.stringify(mergeVacations(null, undefined)) === '[]');
}

// ------------------------------------------------------------
section('7. 推送与冲突重试');
{
  // 模拟服务端
  function makeServer(initial) {
    let store = initial ? { data: initial, updatedAt: 1000 } : null;
    const calls = [];
    return {
      calls,
      get store() { return store; },
      fetch: async (url, opts) => {
        const body = JSON.parse(opts.body);
        calls.push({ base: body.baseUpdatedAt, tasks: body.data.tasks.length });
        if (!store) {
          store = { data: body.data, updatedAt: 2000 };
          return new Response(JSON.stringify({ ok: true, updatedAt: 2000 }), { status: 200 });
        }
        if (store.updatedAt !== body.baseUpdatedAt) {
          return new Response(JSON.stringify({
            ok: false, error: 'conflict', data: store.data, updatedAt: store.updatedAt
          }), { status: 409 });
        }
        store = { data: body.data, updatedAt: store.updatedAt + 1 };
        return new Response(JSON.stringify({ ok: true, updatedAt: store.updatedAt }), { status: 200 });
      }
    };
  }

  // 7.1 无冲突
  {
    const srv = makeServer(null);
    const r = await pushWithRetry('https://x', 'tok', state([task('1')], []), 0, srv.fetch);
    check('首次推送成功', r.ok === true && r.rounds === 1, r);
    check('服务端拿到 1 个作业', srv.store.data.tasks.length === 1);
  }

  // 7.2 云端被别的设备改过 -> 自动合并重试
  {
    const remoteState = state(
      [task('远端1'), task('远端2')],
      [sess('rs1', '远端1', { duration: 5000 })]
    );
    const srv = makeServer(remoteState);
    const localState = state(
      [task('本地1')],
      [sess('ls1', '本地1', { duration: 3000 })]
    );

    const r = await pushWithRetry('https://x', 'tok', localState, 0, srv.fetch);
    check('遇到冲突后自动重试成功', r.ok === true, r);
    check('重试了两轮', r.rounds === 2, r.rounds);
    const finalTasks = srv.store.data.tasks.map(t => t.id).sort();
    check('云端数据与本地数据都保留（不丢数据）',
      JSON.stringify(finalTasks) === JSON.stringify(['远端1', '远端2', '本地1'].sort()),
      finalTasks);
    check('计时记录也合并（2 段）', srv.store.data.sessions.length === 2, srv.store.data.sessions.length);
  }

  // 7.3 非冲突错误要抛出
  {
    const failing = async () => new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 });
    let threw = null;
    try { await pushWithRetry('https://x', 'tok', state([task('1')], []), 0, failing); }
    catch (e) { threw = e; }
    check('401 会抛错而不是静默失败', threw && threw.status === 401, threw && threw.message);
  }

  // 7.4 一直冲突 -> 最终抛错，且带回已合并的数据
  {
    let n = 0;
    const alwaysConflict = async () => {
      n++;
      return new Response(JSON.stringify({
        ok: false, error: 'conflict',
        data: state([task('远端' + n)], []), updatedAt: 1000 + n
      }), { status: 409 });
    };
    let threw = null;
    try { await pushWithRetry('https://x', 'tok', state([task('本地')], []), 0, alwaysConflict); }
    catch (e) { threw = e; }
    check('持续冲突最终抛错', threw && threw.message === 'conflict_retry_exhausted', threw && threw.message);
    check('最多只重试 4 轮（不会死循环）', n === 4, n);
    check('抛错时带回已合并的数据供调用方使用', threw && threw.merged && threw.merged.tasks.length >= 2,
      threw && threw.merged && threw.merged.tasks.length);
  }
}

// ------------------------------------------------------------
console.log('\n================ 结果 ================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
