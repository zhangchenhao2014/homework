// ============================================================
//  一键部署：把整套后端部署到 Cloudflare Pages 并创建账号
//
//  用法：
//    npm run setup
//
//  依次完成：
//    1. 检查 Cloudflare 登录状态（未登录会自动打开浏览器授权）
//    2. 准备 D1 数据库（已存在则跳过）
//    3. 建立数据表
//    4. 离线创建账号：本地生成口令/备用码并算出哈希，直接写入 D1
//       —— 不经过任何 HTTP，因此不依赖 workers.dev（国内被阻断）
//    5. 部署到 Pages，解析出 *.pages.dev 地址
//    6. 连通性检查（pages.dev 国内可访问）
//    7. 把凭据写到桌面文件，并打开
//
//  为什么用 Pages 而不是 Workers：
//    workers.dev 域名在国内被 TLS/SNI 层阻断（换任何 IP 都在握手阶段被重置），
//    而 pages.dev 可以正常访问；并且 Pages 能把静态页和 API 放在同一域名，
//    前端连服务地址都不用手填。
// ============================================================

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tomlPath = path.join(here, 'wrangler.toml');
const credPath = path.join(os.homedir(), 'Desktop', '作业同步凭据.txt');

const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  d: (s) => `\x1b[90m${s}\x1b[0m`
};

function step(n, total, title) {
  console.log(`\n${c.b(`[${n}/${total}]`)} ${title}`);
}

/** 运行 npx wrangler（不抛错，由调用方判断退出码） */
function wrangler(args, opts = {}) {
  const res = spawnSync('npx', ['--yes', 'wrangler', ...args], {
    cwd: here,
    encoding: 'utf8',
    stdio: opts.interactive ? 'inherit' : 'pipe',
    shell: process.platform === 'win32'
  });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

const TOTAL = 7;
const PROJECT = 'homework';
const DB = 'homework-sync';

// ------------------------------------------------------------
step(1, TOTAL, '检查 Cloudflare 登录状态');
{
  const r = wrangler(['whoami']);
  if (r.code !== 0 || /not authenticated|You are not logged in/i.test(r.out)) {
    console.log(c.y('尚未登录，正在打开浏览器授权…'));
    const login = wrangler(['login'], { interactive: true });
    if (login.code !== 0) {
      console.log(c.r('登录失败，请手动执行：npx wrangler login'));
      process.exit(1);
    }
  }
  const r2 = wrangler(['whoami']);
  const email = (r2.out.match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0];
  console.log(c.g('✓ 已登录') + (email ? c.d(' (' + email + ')') : ''));
}

// ------------------------------------------------------------
step(2, TOTAL, '准备 D1 数据库');
{
  let toml = fs.readFileSync(tomlPath, 'utf8');
  const placeholder = /database_id\s*=\s*"(REPLACE_WITH_YOUR_D1_ID|00000000-0000-0000-0000-000000000000)"/.test(toml);

  if (!placeholder) {
    const id = (toml.match(/database_id\s*=\s*"([^"]+)"/) || [])[1];
    console.log(c.g('✓ wrangler.toml 已有 database_id') + c.d(' ' + id));
  } else {
    console.log(c.d('创建数据库…'));
    const created = wrangler(['d1', 'create', DB]);
    const m = created.out.match(/database_id\s*=\s*"([^"]+)"/)
      || created.out.match(/"uuid"\s*:\s*"([^"]+)"/)
      || created.out.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/);
    if (!m) {
      console.log(c.r('✗ 无法从输出解析 database_id，请手动填入 wrangler.toml 后重跑'));
      console.log(c.d(created.out.slice(-600)));
      process.exit(1);
    }
    toml = toml.replace(/"REPLACE_WITH_YOUR_D1_ID"|"00000000-0000-0000-0000-000000000000"/, `"${m[1]}"`);
    fs.writeFileSync(tomlPath, toml, 'utf8');
    console.log(c.g('✓ 已创建并写入 wrangler.toml') + c.d(' ' + m[1]));
  }
}

// ------------------------------------------------------------
step(3, TOTAL, '建立数据表');
{
  const r = wrangler(['d1', 'execute', DB, '--remote', '--file=./schema.sql', '-y']);
  if (r.code !== 0) {
    console.log(c.r('✗ 建表失败：'));
    console.log(c.d(r.out.trim().split('\n').slice(-12).join('\n')));
    process.exit(1);
  }
  console.log(c.g('✓ 数据表就绪（users / devices / backup_codes / sync_data）'));
}

// ------------------------------------------------------------
step(4, TOTAL, '创建账号（离线写入，不经过 HTTP）');
{
  const res = spawnSync('node', ['bootstrap-db.mjs', '--remote'], {
    cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  const out = (res.stdout || '') + (res.stderr || '');
  if (res.status !== 0) {
    if (/已有 \d+ 个账号/.test(out)) {
      console.log(c.y('账号已存在。若要重设口令，请先执行：'));
      // 必须先删子表（backup_codes / devices 都有指向 users 的外键），
      // 否则会报 FOREIGN KEY constraint failed
      console.log(c.d(`  npx wrangler d1 execute ${DB} --remote -y --command "DELETE FROM backup_codes; DELETE FROM devices; DELETE FROM sync_data; DELETE FROM users;"`));
      console.log(c.y('然后重跑 npm run setup（会丢失云端同步数据，本机数据不受影响）。'));
      process.exit(2);
    }
    console.log(c.r('✗ 创建账号失败：'));
    console.log(c.d(out.trim().split('\n').slice(-12).join('\n')));
    process.exit(1);
  }
  console.log(c.g('✓ 账号已在数据库中创建'));
}

// ------------------------------------------------------------
step(5, TOTAL, '部署到 Cloudflare Pages');
let siteUrl = '';
{
  // 先确保项目存在（wrangler pages deploy 不会自动建项目，
  // 之前依赖报错文案去补救，文案一变就失效 —— 改为主动检查）
  const listOut = wrangler(['pages', 'project', 'list', '--json']);
  let exists = false;
  try {
    const start = listOut.out.indexOf('[');
    const projects = JSON.parse(listOut.out.slice(start));
    exists = projects.some(p => (p['Project Name'] || p.name) === PROJECT);
  } catch (e) { exists = /homework/.test(listOut.out); }

  if (!exists) {
    console.log(c.y('项目不存在，正在创建…'));
    const cr = wrangler(['pages', 'project', 'create', PROJECT, '--production-branch', 'main']);
    console.log(c.d(cr.out.trim().split('\n').slice(-5).join('\n')));
    if (cr.code !== 0 && !/already exists/i.test(cr.out)) {
      console.log(c.r('✗ 创建 Pages 项目失败：'));
      console.log(c.d(cr.out.trim().split('\n').slice(-12).join('\n')));
      process.exit(1);
    }
    console.log(c.g('✓ 项目已创建'));
  } else {
    console.log(c.g('✓ 项目已存在') + c.d(' (' + PROJECT + ')'));
  }

  const r = wrangler(['pages', 'deploy', 'assets', '--project-name', PROJECT, '--branch', 'main', '--commit-dirty=true']);
  const m = r.out.match(/https:\/\/[a-z0-9-]+\.pages\.dev/i);
  if (r.code !== 0 || !m) {
    console.log(c.r('✗ 部署失败：'));
    console.log(c.d(r.out.trim().split('\n').slice(-20).join('\n')));
    process.exit(1);
  }
  siteUrl = m[0].replace(/\/+$/, '');
  console.log(c.g('✓ 站点地址：') + c.b(siteUrl));
  try { fs.writeFileSync(path.join(here, '.site-url'), siteUrl + '\n', 'utf8'); } catch (e) {}
}

// ------------------------------------------------------------
step(6, TOTAL, '检查站点连通性');
{
  let host = '';
  try { host = new URL(siteUrl).hostname; } catch (e) {}

  let addrs = [];
  try {
    const dns = await import('dns');
    addrs = await dns.promises.lookup(host, { all: true });
  } catch (e) {}
  console.log(c.d(`  DNS ${host} -> ${addrs.map(a => a.address).join(', ') || '解析失败'}`));

  let reachable = false, lastErr = '';
  for (let i = 1; i <= 3 && !reachable; i++) {
    try {
      const res = await fetch(siteUrl + '/api/health', { signal: AbortSignal.timeout(15000) });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        reachable = true;
        console.log(c.g(`  ✓ 服务可访问，initialized=${body.initialized}`));
        break;
      }
      lastErr = 'HTTP ' + res.status;
    } catch (e) {
      lastErr = (e && (e.cause?.code || e.message)) || String(e);
      console.log(c.y(`  第 ${i} 次连接失败：${lastErr}`));
    }
  }

  if (!reachable) {
    console.log(c.r('\n✗ 部署成功但连不上：' + lastErr));
    console.log(`
配置都已就绪，只是这台机器暂时访问不了 ${siteUrl}。
可以在浏览器里试试打开：${siteUrl}/api/health
若浏览器能打开而这里不能，多半是本机网络/代理的临时问题，稍后重跑即可。
`);
    process.exit(3);
  }
}

// ------------------------------------------------------------
// 6.5 自动跑线上冒烟验收
// 这一步是必需的：本地 Node / 本地 workerd 都不复现 Cloudflare 的平台限制
// （例如 PBKDF2 迭代上限），曾经因此出现「本地全绿、线上登录 500」。
// ------------------------------------------------------------
{
  console.log(c.d('\n  运行线上冒烟验收（smoke.mjs）…'));
  const res = spawnSync('node', ['smoke.mjs', siteUrl], {
    cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  const out = ((res.stdout || '') + (res.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '');
  const tail = out.trim().split('\n');
  // 只回显失败项与结论，避免刷屏
  const fails = tail.filter(l => l.includes('✗'));
  const summary = tail.filter(l => /通过 \d+ 项|线上服务正常|线上有问题/.test(l));
  fails.forEach(l => console.log(c.y('  ' + l.trim())));
  summary.forEach(l => console.log('  ' + (l.includes('❌') || l.includes('失败') && !l.includes('失败 0') ? c.r(l.trim()) : c.g(l.trim()))));

  if (res.status !== 0) {
    console.log(c.r('\n✗ 线上冒烟验收未通过 —— 部署虽然成功，但服务有问题。'));
    console.log(c.y('  请把上面的失败项发我，或查看完整输出：node smoke.mjs ' + siteUrl));
    process.exit(4);
  }
  console.log(c.g('  ✓ 线上冒烟验收通过'));
}

// ------------------------------------------------------------
step(7, TOTAL, '完成');
{
  console.log(`
${c.b('下一步：')}
  1. 打开桌面上的 ${c.b('作业同步凭据.txt')}，把口令和备用码存进密码管理器
  2. 删除该文件
  3. 用浏览器打开：${c.b(siteUrl)}
  4. 点右上角「账号」→ 粘贴口令 → 登录（服务地址已自动填好，不用管）
  5. 手机上打开同一个网址，用口令或任意一个备用码登录即可看到相同数据

${c.d('以后改了页面想重新发布：npm run deploy')}
${c.d('站点地址：' + siteUrl)}
`);

  if (fs.existsSync(credPath)) {
    try {
      spawnSync('notepad', [credPath], { stdio: 'ignore', detached: true, shell: true }).unref();
    } catch (e) {}
  }
}
