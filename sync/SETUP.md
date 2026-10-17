# 账号与同步 · 部署指南

这个目录是作业记录网站的**账号与同步后端**（Cloudflare Pages + D1）。
部署一次即可，之后手机和电脑登录同一账号就能自动同步。

---

## 为什么需要后端

GitHub Pages 只能放静态文件，没有服务器和数据库。而"验证你是不是本人"这件事
**必须由服务端判断** —— 任何写在前端代码里的密码，别人按 F12 就能看到。

### 为什么用 Pages 而不是 Workers

一开始用的是 Cloudflare Workers，但 `*.workers.dev` 这个域名在国内
**被 TLS/SNI 层阻断**：域名解析出来是无效 IP，就算手动指定可用的 Cloudflare IP，
握手也会被直接重置（`ECONNRESET`）。实测数据：

| 目标 | 结果 |
|---|---|
| `xxx.workers.dev`（任意 Cloudflare IP） | ❌ TLS 握手被重置 |
| `xxx.pages.dev` | ✅ 可正常访问 |
| `api.cloudflare.com` / `dash.cloudflare.com` | ✅ 正常 |

所以后端迁到 **Cloudflare Pages**（Advanced Mode，用 `_worker.js` 接管请求）。
额外的好处：Pages 把静态页和 API 放在**同一个域名**下，前端调同源接口，
**连服务地址都不用填**。

### 登录机制（不依赖邮箱、不依赖域名）

| 机制 | 作用 |
|---|---|
| **登录口令** | 高熵随机口令，服务端只存 PBKDF2-SHA256 哈希（15 万次迭代 + 随机盐） |
| **设备令牌** | 登录一次后签发，存浏览器本地；平时免输口令，这就是"验证过的设备" |
| **10 个一次性备用码** | 换手机 / 清了浏览器缓存时用；用掉即作废，不可重用 |

> 为什么不用邮箱验证码：你没有自己的域名，免费邮件服务通常只能发信到
> "已验证的收件地址"；而且一旦收不到信就彻底进不去。口令 + 备用码不依赖任何第三方。

### 账号只能在本地创建（重要）

部署后的站点**不提供任何 HTTP 初始化接口**：
`/api/bootstrap` 因为没配置 `SETUP_TOKEN` 而直接返回 `setup_disabled`。

账号是通过 `bootstrap-db.mjs` **在你本机生成哈希、再经 wrangler 直连数据库写入**的。
这样公网上没有任何"初始化/重置"入口可以被人利用。

---

## 部署（推荐：一条命令）

前提：有个 Cloudflare 免费账号（不用绑卡）。

```powershell
cd "C:\Users\章陈镐\Desktop\self\vibecoding\homework\sync"
npm run setup
```

这个脚本会自动完成：

1. 检查 Cloudflare 登录状态（未登录会打开浏览器授权）
2. 准备 D1 数据库（已存在则跳过）
3. 建立数据表
4. **离线创建账号**：本地生成口令与备用码、算好哈希，直接写入 D1（不经过 HTTP）
5. 部署到 Pages，解析出 `*.pages.dev` 地址
6. 连通性检查
7. 把凭据写到桌面并自动打开

跑完后会**自动打开桌面的 `作业同步凭据.txt`**，里面是你的登录口令和 10 个备用码。

> ⚠️ **把这两样存进密码管理器**（微信收藏 / 手机备忘录都行），然后**删掉桌面那个文件**。
> 服务端只有哈希，**丢了谁也找不回来**。

然后打开脚本输出的 `https://homework.<你的子域>.pages.dev`，点右上角「账号」，
粘贴口令登录即可（服务地址已自动填好，不用管）。


### 如果卡在「部署」这一步

Pages 部署不需要注册 workers.dev 子域名，一般不会卡。若报错，看脚本结尾给出的提示。

若提示项目不存在，先手动创建一次（脚本通常会自动处理）：

```powershell
npx wrangler pages project create homework --production-branch main
```

---

## 部署（手动，仅当脚本失败时）

<details>
<summary>展开手动步骤</summary>

### 1. 登录 Cloudflare

```powershell
cd "C:\Users\章陈镐\Desktop\self\vibecoding\homework\sync"
npx wrangler login
```

浏览器会打开授权页面，点 **Allow** 即可（免费账号就够，不用绑卡）。

### 2. 创建数据库

```powershell
npm run db:create
```

命令会输出一段包含 `database_id = "xxxx"` 的内容，把它填进 `wrangler.toml`。

### 3. 建表

```powershell
npm run db:remote
```

### 4. 创建账号（离线，不经过 HTTP）

```powershell
npm run bootstrap:remote
```

口令与 10 个备用码会写到你桌面的 `作业同步凭据.txt`。

### 5. 部署到 Pages

```powershell
npm run deploy
```

输出形如 `https://homework.<你的子域>.pages.dev` 的地址，那就是你的站点
（静态页与 API 同一域名，不再有独立的服务地址）。

### 6. 以后改了页面怎么发布

```powershell
npm run build     # 把最新 index.html 同步到 assets/
npm run deploy
```

</details>

---

## 开始使用

1. 打开脚本输出的站点地址：`https://homework.<你的子域>.pages.dev`
2. 点右上角 **账号**（或提示条上的"登录 / 开启同步"）
3. 填**账号 + 口令** → 登录（服务地址已自动填好）
4. 若本机和云端都有数据，会让你选**合并**（推荐，两边都不丢）或只用云端
5. 换新手机时：打开同一网址 → 账号 → 选「一次性备用码」，**不用填账号**（码本身能定位账号）

> 旧的 GitHub Pages 页面（`zhangchenhao2014.github.io/homework/`）仍然能打开，
> 但它没有后端，只能是"仅本机"。要同步请用 Pages 站点的地址。

---

## 给别人开账号（管理员操作）

公网上**没有注册入口**：`/api/bootstrap` 与 `/api/reset-credentials` 在未配置
`SETUP_TOKEN` 时一律返回 `setup_disabled`。建号只能在你自己电脑上、
用你的 Cloudflare 权限完成。

```powershell
cd "C:\Users\章陈镐\Desktop\self\vibecoding\homework\sync"

node admin.mjs create zhangsan 123456   # 建号（口令你定；不给则随机生成）
node admin.mjs list                     # 看所有账号：作业数/数据量/设备数/最后同步
node admin.mjs reset  zhangsan 654321   # 重置口令（作业数据保留）
node admin.mjs delete zhangsan          # 删号（连带其作业，需输入 yes 确认）
```

- `create` / `reset` 会把「账号 + 口令 + 10 个备用码」写到桌面 `账号-<名字>.txt`
  并打开。把内容发给对方，然后删掉本机这个文件。
- 加 `--no-file` 只打印不写文件；`--local` 操作本地测试库。
- `reset` 会让旧口令、旧备用码、该账号**所有已登录设备**立即失效，但**不会删作业数据**。
- `delete` 顺序是「子表 → users」，否则会触发外键约束失败。

### 共享一台电脑时

同一浏览器里换账号登录时，页面会提示：

> 这台设备上保存着「甲」的 3 项作业。现在要登录「乙」。

确认后才会清空本机数据再登录 —— 否则甲的作业会被上传进乙的账号。
换回甲登录时，甲的作业会从云端重新拉回来（云端没删）。

### 每个人能看到什么

| | 自己 | 别人 |
|---|---|---|
| 作业与计时记录 | ✅ | ❌ 完全看不到 |
| 账号、口令 | 只有自己知道口令 | 只有管理员（你）知道 |

> ⚠️ **作为管理员，你技术上能看到所有人的作业**：`sync_data.data` 在 D1 里是
> 明文 JSON，你有 wrangler 权限就等于有数据库权限。给同学用之前，这一点
> 你应该知情，最好也让他们知道。


---

## 安全设计要点

- 口令 / 令牌 / 备用码**一律只存哈希**（PBKDF2-SHA256 15 万次迭代 / SHA-256），数据库泄露也拿不到明文
- 令牌比较使用**定时安全比较**，避免通过响应时间推测
- **公网上没有任何初始化或重置入口**：`/api/bootstrap` 与 `/api/reset-credentials`
  都需要 `SETUP_TOKEN`，而 Pages 部署故意不配置它，因此一律返回 `setup_disabled`；
  建号与改口令只能在你本机经 wrangler 直连数据库完成
- 同步接口用 `baseUpdatedAt` 做**乐观并发控制**：两台设备同时改不会互相覆盖，
  冲突时自动合并后重试（最多 4 轮）
- CORS 只放行白名单来源；同源部署时其实用不到 CORS
- 怀疑泄露时：在账号面板点"在所有设备上退出登录"，所有令牌立即失效

## 常用运维命令

```powershell
npm test                      # 五套离线测试（185 项）
npm run test:e2e              # 对着本地运行的后端跑（45 项）
npm run smoke                 # 对线上站点做冒烟验收（只读，14 项）
npm run smoke -- --password '口令'   # 追加登录与读写链路验证
npm run deploy                # 改了页面后重新发布
npx wrangler pages deployment list
npx wrangler d1 execute homework-sync --remote --command "SELECT COUNT(*) FROM devices"
```

### 为什么必须有 npm run smoke

本地 Node 和本地 workerd **都不复现 Cloudflare 的平台限制**，例如
PBKDF2 迭代次数上限 100000。曾经因此出现：

- 本地 147 项测试全绿
- `npm run setup` 一路成功（建号只写哈希，不校验）
- **线上登录直接 500**：`Pbkdf2 failed: iteration counts above 100000 are not supported`

唯一可靠的办法是部署后对真实站点做一次黑盒验收。`npm run setup` 现在会自动
调用它，所以这类问题不会再"部署成功但用不了"。

现在 `npm test` 里也加了 `test/platform-limits.test.mjs`：它把 Cloudflare 的
限制**模拟**到 `globalThis.crypto` 上，在本地就能撞出这类 bug。

## 数据说明

- 云端每个账号存**一条 JSON 记录**（作业清单 + 计时记录），上限 1MB
- 单条计时记录约 200 字节，1MB 够存数千条，正常使用多年无压力
- Cloudflare 免费额度：D1 每天 500 万次读、10 万次写，Pages 每月 500 次构建，个人用远远够
- 登录接口要做 10 万次 PBKDF2 迭代（约十几毫秒 CPU），这是**有意为之**：
  宁可慢一点，也不降低口令哈希强度

