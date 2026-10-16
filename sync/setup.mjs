// ============================================================
//  一键部署脚本：把 SETUP.md 里的 6 步合并成一条命令
//
//  用法：
//    npm run setup
//
//  它会依次：
//    1. 检查 Cloudflare 登录状态
//    2. 创建 D1 数据库（若已存在则跳过）
//    3. 把 database_id 写回 wrangler.toml
//    4. 建立数据表
//    5. 生成随机 SETUP_TOKEN 并设为机密
//    6. 部署 Worker，解析出服务地址
//    7. 调用 /api/bootstrap 创建账号
//    8. 把口令与备用码写到桌面文件（不经过任何第三方）
// ============================================================

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tomlPath = path.join(here, 'wrangler.toml');

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

/** 运行 npx wrangler 并返回输出（失败不抛错，由调用方判断） */
function wrangler(args, opts = {}) {
  const res = spawnSync('npx', ['--yes', 'wrangler', ...args], {
    cwd: here,
    encoding: 'utf8',
    stdio: opts.interactive ? 'inherit' : 'pipe',
    shell: process.platform === 'win32'
  });
  return {
    code: res.status,
    out: (res.stdout || '') + (res.stderr || '')
  };
}

const TOTAL = 8;

// ------------------------------------------------------------
// 1. 检查登录状态
// ------------------------------------------------------------
step(1, TOTAL, '检查 Cloudflare 登录状态');
{
  const r = wrangler(['whoami']);
  if (r.code !== 0 || /not authenticated|You are not logged in/i.test(r.out)) {
    console.log(c.y('尚未登录 Cloudflare，正在打开浏览器授权…'));
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
// 2~3. 创建 D1 数据库，并把 ID 写回 wrangler.toml
// ------------------------------------------------------------
step(2, TOTAL, '准备 D1 数据库');
let toml = fs.readFileSync(tomlPath, 'utf8');
const needId = /database_id\s*=\s*"REPLACE_WITH_YOUR_D1_ID"/.test(toml);
let dbId = (toml.match(/database_id\s*=\s*"([^"]+)"/) || [])[1];

if (!needId) {
  console.log(c.g('✓ wrangler.toml 里已有 database_id') + c.d(' ' + dbId));
} else {
  console.log(c.d('wrangler.toml 还是占位符，开始创建数据库…'));
  const created = wrangler(['d1', 'create', 'homework-sync']);
  console.log(c.d(created.out.trim().split('\n').slice(-6).join('\n')));

  const idMatch = created.out.match(/database_id\s*=\s*"([^"]+)"/)
    || created.out.match(/"uuid"\s*:\s*"([^"]+)"/)
    || created.out.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/);

  if (!idMatch) {
    console.log(c.r('✗ 没能从输出里解析出 database_id。'));
    console.log('  请手动把上面输出里的 database_id 填进 wrangler.toml 后重跑 npm run setup');
    process.exit(1);
  }
  dbId = idMatch[1];
  toml = toml.replace(/"REPLACE_WITH_YOUR_D1_ID"/, `"${dbId}"`);
  fs.writeFileSync(tomlPath, toml, 'utf8');
  console.log(c.g('✓ 已写入 wrangler.toml') + c.d(' database_id=' + dbId));
}

step(3, TOTAL, '建立数据表');
{
  const r = wrangler(['d1', 'execute', 'homework-sync', '--remote', '--file=./schema.sql', '-y']);
  if (r.code !== 0) {
    console.log(c.r('✗ 建表失败：'));
    console.log(r.out.trim().split('\n').slice(-12).join('\n'));
    process.exit(1);
  }
  console.log(c.g('✓ 数据表已就绪（users / devices / backup_codes / sync_data）'));
}

// ------------------------------------------------------------
// 4. 生成并设置 SETUP_TOKEN
// ------------------------------------------------------------
step(4, TOTAL, '设置初始化令牌 SETUP_TOKEN');
const setupToken = crypto.randomBytes(24).toString('hex');
{
  const res = spawnSync('npx', ['--yes', 'wrangler', 'secret', 'put', 'SETUP_TOKEN'], {
    cwd: here,
    input: setupToken + '\n',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32'
  });
  const out = (res.stdout || '') + (res.stderr || '');
  if (res.status !== 0) {
    console.log(c.r('✗ 设置机密失败：'));
    console.log(out.trim().split('\n').slice(-10).join('\n'));
    console.log(c.y('\n可手动执行：npx wrangler secret put SETUP_TOKEN'));
    process.exit(1);
  }
  console.log(c.g('✓ 已设置（随机生成，仅用于本次初始化）'));
}

// ------------------------------------------------------------
// 5. 部署
// ------------------------------------------------------------
step(5, TOTAL, '部署 Worker');
let workerUrl = '';
{
  const r = wrangler(['deploy']);
  // 只在失败时打印原始输出，避免刷屏
  const m = r.out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i)
    || r.out.match(/https:\/\/[^\s]*workers\.dev/i);

  // 常见坑：Cloudflare 要求先注册一个 workers.dev 子域名，否则无法发布
  if (/register a workers\.dev subdomain/i.test(r.out) || /workers\/onboarding/i.test(r.out)) {
    const url = (r.out.match(/https:\/\/dash\.cloudflare\.com\/[^\s]*workers\/onboarding/) || [])[0];
    console.log(c.y('\n⚠️  还差一步：你还没有 workers.dev 子域名，Cloudflare 不允许发布。'));
    console.log('\n  请打开下面这个链接，随便起一个子域名（例如你的昵称），点确认：');
    console.log('  ' + c.b(url || 'https://dash.cloudflare.com → Workers & Pages → 设置子域名'));
    console.log('\n  完成后回到这里重新执行：' + c.b('npm run setup'));
    console.log(c.d('  （数据库和机密已经建好了，重跑会跳过，不会重复创建）'));
    process.exit(2);
  }

  if (r.code !== 0 || !m) {
    console.log(c.r('✗ 部署失败：'));
    console.log(c.d(r.out.trim().split('\n').slice(-15).join('\n')));
    process.exit(1);
  }
  workerUrl = m[0].replace(/\/+$/, '');
  console.log(c.g('✓ 服务地址：') + c.b(workerUrl));
}

// ------------------------------------------------------------
// 6. 创建账号
// ------------------------------------------------------------
step(6, TOTAL, '创建账号');
let creds = null;
{
  const res = await fetch(workerUrl + '/api/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken, username: 'owner' })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    console.log(c.r(`✗ 创建账号失败（HTTP ${res.status}）：`) + JSON.stringify(body));
    console.log(c.y('  若是 already_initialized，说明之前已初始化过，可直接登录。'));
    process.exit(1);
  }
  creds = body;
  console.log(c.g('✓ 账号已创建，备用码 ' + creds.backupCodes.length + ' 个'));
}

// ------------------------------------------------------------
// 7. 写入凭据文件
// ------------------------------------------------------------
step(7, TOTAL, '保存凭据到桌面');
const credPath = path.join(os.homedir(), 'Desktop', '作业同步凭据.txt');
{
  const content = [
    '【假期作业记录 · 同步凭据】',
    '生成时间：' + new Date().toLocaleString('zh-CN'),
    '',
    '服务地址：',
    workerUrl,
    '',
    '登录口令（相当于主密码，务必保存好）：',
    creds.password,
    '',
    '一次性备用码（换手机 / 清了缓存时用，每个只能用一次）：',
    ...creds.backupCodes.map((code, i) => `  ${String(i + 1).padStart(2, ' ')}. ${code}`),
    '',
    '注意：服务端只存哈希，丢了无法找回。',
    '请把这些内容存进密码管理器，然后删除本文件。',
    ''
  ].join('\n');
  fs.writeFileSync(credPath, content, 'utf8');
  console.log(c.g('✓ 已写入：') + credPath);
}

// ------------------------------------------------------------
// 8. 完成
// ------------------------------------------------------------
step(8, TOTAL, '完成');
console.log(`
${c.b('接下来：')}
  1. 打开 ${c.b(credPath)}，把口令和备用码存进密码管理器，然后删掉这个文件
  2. 打开 ${c.b('https://zhangchenhao2014.github.io/homework/')}
  3. 点右上角「账号」→ 填服务地址和口令 → 登录

${c.d('服务地址：' + workerUrl)}
${c.d('以后改代码后，重新部署只需：npx wrangler deploy')}
`);

try {
  spawnSync('notepad', [credPath], { stdio: 'ignore', detached: true, shell: true }).unref();
} catch (e) { /* 打不开就算了 */ }
