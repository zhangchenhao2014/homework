# 账号与同步 · 部署指南

这个目录是作业记录网站的**账号与同步后端**（Cloudflare Workers + D1）。
部署一次即可，之后手机和电脑登录同一账号就能自动同步。

---

## 为什么需要后端

GitHub Pages 只能放静态文件，没有服务器和数据库。而"验证你是不是本人"这件事
**必须由服务端判断** —— 任何写在前端代码里的密码，别人按 F12 就能看到。
所以登录与数据同步放在 Cloudflare Workers 上。

### 登录机制（不依赖邮箱、不依赖域名）

| 机制 | 作用 |
|---|---|
| **登录口令** | 高熵随机口令，服务端只存 PBKDF2-SHA256 哈希（15 万次迭代 + 随机盐） |
| **设备令牌** | 登录一次后签发，存浏览器本地；平时免输口令，这就是"验证过的设备" |
| **10 个一次性备用码** | 换手机 / 清了浏览器缓存时用；用掉即作废，不可重用 |

> 为什么不用邮箱验证码：你没有自己的域名，免费邮件服务通常只能发信到
> "已验证的收件地址"；而且一旦收不到信就彻底进不去。口令 + 备用码不依赖任何第三方。

---

## 部署（推荐：一条命令）

前提：有个 Cloudflare 免费账号（不用绑卡）。

```powershell
cd "C:\Users\章陈镐\Desktop\self\vibecoding\homework\sync"
npm run setup
```

这个脚本会自动完成：登录检查 → 创建数据库 → 写入 `database_id` → 建表 →
生成并设置 `SETUP_TOKEN` → 部署 → 创建账号 → 把凭据写到桌面。

跑完后会**自动打开桌面的 `作业同步凭据.txt`**，里面是你的登录口令和 10 个备用码。

> ⚠️ **把这两样存进密码管理器**（微信收藏 / 手机备忘录都行），然后**删掉桌面那个文件**。
> 服务端只有哈希，**丢了谁也找不回来**。

然后打开 https://zhangchenhao2014.github.io/homework/ ，点右上角「账号」，
填上脚本输出的服务地址 + 口令即可。

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

命令会输出一段包含 `database_id = "xxxx"` 的内容，**把那一长串 ID 复制下来**，
粘贴替换 `wrangler.toml` 里的 `REPLACE_WITH_YOUR_D1_ID`。

### 3. 建表

```powershell
npm run db:remote
```

### 4. 设置初始化令牌（防止别人抢先初始化）

```powershell
npx wrangler secret put SETUP_TOKEN
```

按提示输入一串你自己想的随机字符（例如 32 位乱码）。**这个值不要告诉任何人**，
也不用记，它只在下一步用一次。

### 5. 部署

```powershell
npx wrangler deploy
```

完成后会输出你的服务地址，形如：

```
https://homework-sync.<你的子域>.workers.dev
```

**把这个地址记下来**，登录时要用。

### 6. 创建账号（只做一次）

把下面的地址换成上一步得到的：

```powershell
$api = "https://homework-sync.你的子域.workers.dev"
$setup = "你在第 4 步设置的 SETUP_TOKEN"

$resp = Invoke-RestMethod -Method Post -Uri "$api/api/bootstrap" `
  -ContentType "application/json" `
  -Body (@{ setupToken = $setup; username = "owner" } | ConvertTo-Json)

$resp | ConvertTo-Json -Depth 5 | Out-File -Encoding UTF8 "$env:USERPROFILE\Desktop\作业同步凭据.txt"
notepad "$env:USERPROFILE\Desktop\作业同步凭据.txt"
```

桌面文件里是 `password`（登录口令）和 `backupCodes`（10 个一次性备用码）。

### 7. 允许你的网页调用接口

`wrangler.toml` 里的 `ALLOWED_ORIGINS` 已经预填了
`https://zhangchenhao2014.github.io`。如果你换域名，记得改这里并重新 `npx wrangler deploy`。

</details>

---

## 开始使用

1. 打开 https://zhangchenhao2014.github.io/homework/
2. 点右上角 **账号**（或黄色提示条上的"登录 / 开启同步"）
3. 填服务地址 + 口令 → 登录
4. 若本机和云端都有数据，会让你选**合并**（推荐，两边都不丢）或只用云端
5. 换新手机时：打开同一网址 → 账号 → 用**口令**或任意一个没用过的**备用码**验证

---

## 安全设计要点

- 口令 / 令牌 / 备用码**一律只存哈希**，数据库泄露也拿不到明文
- 令牌比较使用**定时安全比较**，避免通过响应时间推测
- 同步接口用 `baseUpdatedAt` 做**乐观并发控制**：两台设备同时改不会互相覆盖，
  冲突时自动合并后重试（最多 4 轮）
- CORS 只放行白名单来源，别的网站无法盗用你的接口
- 怀疑泄露时：在账号面板点"在所有设备上退出登录"，所有令牌立即失效

## 常用运维命令

```powershell
npm test                                  # 跑后端测试（55 项）
npx wrangler tail                         # 实时看线上日志
npx wrangler d1 execute homework-sync --remote --command "SELECT COUNT(*) FROM devices"
```

## 数据说明

- 云端每个账号存**一条 JSON 记录**（作业清单 + 计时记录），上限 1MB
- 单条计时记录约 200 字节，1MB 够存数千条，正常使用多年无压力
- Cloudflare 免费额度：D1 每天 500 万次读、10 万次写，个人使用远远用不完
