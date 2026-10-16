// ============================================================
//  删除语义测试（tombstone）
//
//  背景：原来的合并规则是「按 id 取并集」，只能表达"某个 id 存在"，
//  无法表达"某个 id 已被删除"。于是只要还有任意一份旧副本
//  （另一台设备、或另一个还开着的标签页）参与同步，被删的项就会被
//  并集加回来 —— 用户看到的现象就是「删不掉」。
//
//  修复：每次删除都记下 { id: 删除时刻 }，它参与同步；合并时取两边
//  删除记录的并集（同 id 取较晚者），并在最后把命中标记的条目剔除。
//
//  运行：node test/tombstone.test.mjs
// ============================================================

import { mergeStates, mergeDeleted, pruneDeleted, TOMBSTONE_TTL_MS } from '../src/sync-client.js';

let pass = 0, fail = 0;
const check = (l, c, e) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l + (e !== undefined ? '  → ' + JSON.stringify(e) : '')); } };
const section = t => console.log('\n=== ' + t + ' ===');

// 注意：作业与计时记录用各自的 id 前缀，避免混淆
let seq = 0;
const task = (id, over) => Object.assign({
  id, name: '作业' + id, subject: '语文', vacation: '寒假', note: '',
  status: 'pending', createdAt: 1000, doneTime: null
}, over || {});
const sess = (id, taskId, over) => Object.assign({
  id, taskId, taskName: '作业' + taskId, subject: '语文', vacation: '寒假',
  startTime: 1000, endTime: 2000, duration: 1000, status: 'done'
}, over || {});
const st = (tasks, sessions, deleted) => ({
  tasks: tasks || [], sessions: sessions || [], vacations: ['寒假'], deletedTasks: deleted || {}
});

// ------------------------------------------------------------
section('1. 核心场景：删除不会被别的设备"复活"');
{
  // 云端有 t1，设备A 与设备B 都持有它
  const cloud = st([task('t1')], []);
  const deviceA = st([task('t1')], []);
  const deviceB = st([task('t1')], []);

  // 设备A 删除 t1（页面做法：从本地移除 + 记删除标记）
  const delTs = Date.now();
  deviceA.tasks = deviceA.tasks.filter(t => t.id !== 't1');
  deviceA.deletedTasks = { t1: delTs };

  // 设备A 推送 -> 云端变成设备A 的状态
  let cloudNow = mergeStates(deviceA, deviceA);
  check('删除后云端已无该项', cloudNow.tasks.length === 0, cloudNow.tasks.map(t => t.id));
  check('云端保留了删除标记', cloudNow.deletedTasks && 't1' in cloudNow.deletedTasks, cloudNow.deletedTasks);

  // 设备B 仍持有旧副本，执行一次普通同步：pull -> merge -> push
  const mergedOnB = mergeStates(deviceB, cloudNow);
  check('设备B 同步后本地也不再出现该项', mergedOnB.tasks.length === 0, mergedOnB.tasks.map(t => t.id));

  cloudNow = mergedOnB;
  check('推送后云端仍然没有该项（删除存活）',
    !cloudNow.tasks.some(t => t.id === 't1'), cloudNow.tasks.map(t => t.id));
}

// ------------------------------------------------------------
section('2. 删除标记的合并且不会误删其它项');
{
  const NOW = Date.now();
  const a = st([task('keep1')], [], { gone1: NOW - 60000 });
  const b = st([task('keep2'), task('gone1')], [], { gone2: NOW - 30000 });
  const m = mergeStates(a, b);
  check('未标记的项都保留', m.tasks.map(t => t.id).sort().join(',') === 'keep1,keep2', m.tasks.map(t => t.id));
  check('被标记的项被剔除', !m.tasks.some(t => t.id === 'gone1'), m.tasks.map(t => t.id));
  check('两边的标记都并入了', 'gone1' in m.deletedTasks && 'gone2' in m.deletedTasks, m.deletedTasks);
}

// ------------------------------------------------------------
section('3. 计时记录也参与删除过滤');
{
  const NOW2 = Date.now();
  const a = st([task('t1')], [sess('s1', 't1')], { s1: NOW2 - 60000 });
  const b = st([task('t1')], [sess('s1', 't1'), sess('s2', 't1')], {});
  const m = mergeStates(a, b);
  check('被删除的计时记录不会复活', !m.sessions.some(s => s.id === 's1'), m.sessions.map(s => s.id));
  check('未删除的计时记录保留', m.sessions.some(s => s.id === 's2'), m.sessions.map(s => s.id));
}

// ------------------------------------------------------------
section('4. 同一 id 取较晚的删除时刻（先删后建的极端情况）');
{
  check('取较晚的时间戳',
    mergeDeleted({ x: 100 }, { x: 300 }).x === 300,
    mergeDeleted({ x: 100 }, { x: 300 }));
  check('顺序无关',
    mergeDeleted({ x: 300 }, { x: 100 }).x === 300,
    mergeDeleted({ x: 300 }, { x: 100 }));
  check('一边缺失也能合并',
    JSON.stringify(mergeDeleted({ a: 1 }, null)) === JSON.stringify({ a: 1 }));
  check('null 安全', JSON.stringify(mergeDeleted(null, undefined)) === JSON.stringify({}));
}

// ------------------------------------------------------------
section('5. 删除标记会过期，不会无限膨胀');
{
  const now = Date.now();
  const kept = pruneDeleted({ fresh: now - 1000, stale: now - TOMBSTONE_TTL_MS - 1000 }, now);
  check('未过期的标记保留', 'fresh' in kept, kept);
  check('过期的标记被丢弃', !('stale' in kept), kept);
  check('保留时长为 90 天', TOMBSTONE_TTL_MS === 90 * 24 * 60 * 60 * 1000, TOMBSTONE_TTL_MS);

  const m = mergeStates(st([], [], { old: now - TOMBSTONE_TTL_MS - 1 }), st([task('old')], []));
  check('过期标记不再拦阻同名 id（避免永久无法新增）',
    m.tasks.some(t => t.id === 'old'), m.tasks.map(t => t.id));
}

// ------------------------------------------------------------
section('6. 向后兼容：老数据没有 deletedTasks 字段');
{
  const legacy = { tasks: [task('t1')], sessions: [] };        // 老版本结构
  const m = mergeStates(legacy, { tasks: [task('t2')], sessions: [] });
  check('没有标记时行为与以前一致（并集）',
    m.tasks.map(t => t.id).sort().join(',') === 't1,t2', m.tasks.map(t => t.id));
  check('输出总是带 deletedTasks 字段', typeof m.deletedTasks === 'object', typeof m.deletedTasks);
  check('null 输入不崩溃', Array.isArray(mergeStates(null, null).tasks));
}

// ------------------------------------------------------------
section('7. 幂等：反复合并不会把删除标记丢掉');
{
  let s = mergeStates(st([task('t1')], [], { t1: Date.now() - 60000 }), st([task('t1')], []));
  for (let i = 0; i < 5; i++) s = mergeStates(s, s);
  check('多次自合并后仍无该项', s.tasks.length === 0, s.tasks.map(t => t.id));
  check('多次自合并后标记仍在', 't1' in s.deletedTasks, s.deletedTasks);
}

console.log('\n================ 结果 ================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
