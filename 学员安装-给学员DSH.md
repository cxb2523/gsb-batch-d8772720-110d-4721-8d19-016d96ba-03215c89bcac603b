# 闲鱼自动化 · 安装任务书

> **交给：学员电脑上的 AI agent（DSH）执行。**
> 这份文件**不含任何密钥**，可以直接转发、截图、丢群里。
> 请**从头读完再动手**。带 👤 的步骤必须由**人**操作 —— 到那一步就停下来，告诉人要做什么，做完再继续。

---

## 0. 给你（AI）的四条铁律

1. **👤 的步骤不要替人做** —— 扫码、过滑块、输短信验证码、点浏览器里的确认，都等人。
2. **每一步都要回读验证**，不要拿「命令没报错」当成功。验收那一段的输出要原样贴给管理员。
3. **卡住就停下来问，不要自己猜着改代码。** 把**完整原始输出**贴出来（不要只贴最后一行）。
4. **不要改 `lib/` 里的东西**，那是代码不是配置；配置一律走 `config.local.json` / `service.local.json`。

---

## 1. 先查这台机器（不满足就先装）

| 项 | 要求 | 怎么查 |
|---|---|---|
| 系统 | Windows 10 / 11 | —— |
| **Node.js** | **18 或更高** | 命令行跑 `node -v` |
| 磁盘 | 留 **3 GB**（Chromium 约 1.5 GB） | —— |
| 网络 | 能访问 `www.goofish.com` 与管理员给的地址 | —— |
| 三个目录 | 要放在**同一个盘**的**同一个文件夹**下（见第 3 步） | —— |

**没有 Node.js** → 去 <https://nodejs.org> 下 **LTS** 版装上，装完**重开命令行**（否则 `node` 还是找不到）。

---

## 2. 从一个包开始（自己下载）

**下载页（国内直连）**：<https://achun1107.github.io/xianyu-project/>
最新版的直链和 sha256 都印在那一页上。**不要用 GitHub Release 的链接** ——
`github.com/.../releases/download/...` 会跳到 `release-assets.githubusercontent.com`，
那个域国内网络连不上（实测 HTTP 000），你会以为包是坏的。

| 你需要的 | 从哪来 |
|---|---|
| `xianyu-install-<版本>.zip` | 上面那个下载页。**一个包就够** —— 三个仓都在里面 |
| 它的 sha256 | 下载页上就写着，或同目录的 `.zip.sha256` |
| `service.local.json` | **不用等人发** —— 包里自带模板 `service.local.json.example`，你自己复制一份填（见 §2.1） |
| 闲鱼账号的**登录方式** | 管理员给；等下要扫码，人得在场 |

**先校验再解压**（防下载不完整；哈希以下载页上的为准，别抄聊天记录里的旧值）：

```powershell
Get-ChildItem .\xianyu-install-*.zip | ForEach-Object {
  $h = Get-FileHash $_.FullName -Algorithm SHA256
  "$($h.Hash.ToLower())  $($_.Name)"
}
# 与下载页上那串逐字对比（大小写都行）；不一致就是没下全，重下一次
```

### 2.1 自己写 `service.local.json`（包里自带模板）

**目标位置**：`xianyu-playwright-service\service.local.json`（和 `server.js` 同目录）。
这个文件决定**你这台机器上能看到哪个店**，所以只能放你自己的账号。

```powershell
# ① 复制模板（在 xianyu-achun 目录里跑）
copy service.local.json.example ..\xianyu-playwright-service\service.local.json

# ② 生成一个 id —— 只生成一次，填好【永不再改】
node -e "console.log(require('crypto').randomUUID())"
```

③ 记事本打开那个文件，改 **`localAccounts` 里那一个对象**（不是外面的 `_说明`）：

```json
{
  "_说明": [ ... 五段中文，是给你看的，别动 ... ],
  "localAccounts": [
    {
      "id":       "<上一步生成的那串 UUID>",
      "name":     "<你的店铺名>",
      "username": "<可留空>",
      "password": "<可留空>"
    }
  ]
}
```

**别把尖括号 `< >` 一起留下** —— `<你的店铺名>` 要改成真名，不是原样保留。

| 字段 | 填什么 |
|---|---|
| `id` | 上一步生成的那串 UUID。**登录态就存在 `browser-profiles\<id>\` 下**，改了等于退出登录，要重新扫码 |
| `name` | 你的店铺名 —— 后面所有命令都用它，**别再用别的写法** |
| `username` / `password` | 可留空。扫码登录用不到；只有密码登录才需要 |

④ **重启 8093**：双击 `xianyu-playwright-service\start.bat`。
**这个文件只在服务启动时读一次**，改完不重启不生效。

⑤ 确认读到了：`node tools\store-new.js --list-accounts` 应该能看到你的店。

> ⚠️ 店铺名不能用 `湖畔暴富的蓝环章鱼` / `追梦的镇宇` / `casa家居` —— 这三个是服务端内置的排除项，配了也不会出现。
> ⚠️ 这个文件里是**明文密码**：别发群、别进 git（代码包里本来就不含它，安装器也不会生成它）。

> **⚠️ `xianyu-monitor` 不是可选的。** 8093 服务运行时**要读它里面**的
> `publish.js` / `publish_ui.js` / `address_db.js` / `native_host.py` / `publish_dashboard.js`。
> 少了它的症状非常坑：**服务能起来、`/health` 正常、界面能开，但发布和广告全都不工作，而且不报任何错。**

---

## 3. 解压：三个目录**必须并排**

把那个包解压到一个固定位置（示例用 `D:\`）。**包已经按正确布局打好了**，解开就是：

```
<你解压到的位置>\xianyu-install-<版本>\
  ├─ xianyu-achun\                 ← 主控仓（第 4 步在这里跑）
  ├─ xianyu-playwright-service\    ← 8093 浏览器服务
  ├─ xianyu-monitor\               ← 桌面发布台（⚠️ 不是可选的）
  ├─ install.cmd                   ← 双击就开始装
  └─ install-guide.html            ← 中文图文说明（浏览器双击打开）
```

- **一个目录都不用改名、不用搬动。** 安装器按「achun 的上一级 + 固定名字」去找另外两个。
- 只解压其中一个、或把某个目录拖到别处，结果都是预演报「找不到依赖仓」。
- 这个包**不含 .git**，所以不需要 git 也不需要翻墙；解压完就能装。

**解压完先自查**：先 `cd` 到你**解压出来的那个文件夹**（里面有三个 `xianyu-*` 目录），然后跑下面三条，都应是 `True`：

```powershell
Test-Path .\xianyu-achun\install.ps1
Test-Path .\xianyu-playwright-service\server.js
Test-Path .\xianyu-monitor\publish.js
```

（用相对路径是有意的：不管你解压到 `D:\` 还是 `E:\软件\`，这三条都对。别照抄带盘符的绝对路径。）

---

## 4. 装（别跳预演）

**最省事：双击解压目录里的 `install.cmd`。** 它会先跑预演、停下来让你看两行路径，再正式装。

想手动跑，就在 `xianyu-achun` 目录里开命令行（资源管理器地址栏输 `cmd` 回车）：

```powershell
cd <你解压出来的那个文件夹>\xianyu-achun

# ① 先预演：什么都不改，只看它打算做什么、认到的路径对不对
powershell -ExecutionPolicy Bypass -File install.ps1 -DryRun

# ② 按 §2.1 自己填好 service.local.json（必须在正式装之前）
#    目标位置：<解压目录>\xianyu-playwright-service\service.local.json

# ③ 正式装
powershell -ExecutionPolicy Bypass -File install.ps1
```

> 双击 `install.cmd` 的效果和上面三条一样（它自带 `Bypass`，省得被 PowerShell 执行策略挡住）。
>
> **安装码（`-InstallCode`）那条路现在还不能用** —— 中台 `/api/xianyu-install-config` 还没确认建好，
> 用了只会拿到一堆「拿不到配置」的缺失项。就走解压安装。

**预演那一步重点看这两行**，它们不对后面全白搭：

```
playwright-service 仓库：D:\xianyu\xianyu-playwright-service
xianyu-monitor 仓库：D:\xianyu\xianyu-monitor
```

显示「找不到」或指到别的路径 → **第 3 步目录放错了**，回去重放，别往下走。

安装器会自动：推导本机路径 → 写配置 → 起 8093 服务 → 建店铺骨架 → 自验收。
**中间任何一步失败都不会中断**，它会把缺的东西列成清单打给你 —— 那份清单原样贴给管理员。

---

## 5. 👤 三件只有人能做（安装器最后会把这三条打出来）

### ① 闲鱼扫码登录
浏览器窗口会弹出来（没弹就手动跑）：

```powershell
node tools\store-ready.js "你的店铺名"
node tools\store-login.js "你的店铺名" --wait=15     # 15 = 分钟（默认 10）
```

**人要做的**：按提示**扫码 + 过滑块 + 输短信验证码**。登录态存在本机，之后不用反复登。

### ② 主图（先看会发成什么样）
```powershell
$env:XY_STORE="你的店铺名"
node publish-one.js <城市> <明星> <首开/二开> --dry
```
`--dry` **只出图不发布**。不满意就换版式（改店铺档案里的 `主图.templates`），或找管理员要一个新版式。

### ③ 副图
把要用的副图丢进 `publish-assets\<你的店铺名>\副图\`，然后回来改店铺档案：

```powershell
node tools\store-new.js --list-accounts      # 看这台机器上有哪些闲鱼账号可用
node tools\store-init.js "你的店铺名" --apply --verify
```

---

## 6. 验收（装完**必须**跑，把输出贴给管理员）

```powershell
node tools\store-list.js          # 应列出你的店铺，"问题"列是 — 或只有 ⚠️
node tools\store-init.js --all    # 连网完整体检：账号 / 版式库 / 文案池 / 素材
node tools\selftest-lib.js        # 公共库自检
```

**通过标准**：`store-init.js --all` 里 **❌ 是 0 个**。
有 ❌ 就**把整段输出贴给管理员**，别自己猜。

---

## 7. 装完你应该有的能力（自查）

| 能力 | 命令 |
|---|---|
| 看这家店有哪些链接 | `node tools\list-onsale.js`（加关键词筛：`node tools\list-onsale.js 许嵩 王力宏`） |
| 出一张主图看看 | `$env:XY_STORE="店铺名"; node publish-one.js <城市> <明星> <首开/二开> --dry`（填一个**大麦上正在卖**的场次，否则会停在「大麦有X但没Y」） |
| 发一条链接 | `node tools\publish-group.js <方案文件>`（**先加 `--plan` 预演**） |
| 看推广计划 | `node tools\ad-review.js` / `node tools\ad-status.js` |
| 下架一条链接 | `node do-offshelf.js <itemId>`（**只点「下架」，永不点「删除」**） |
| 看整机体检 | `体检.cmd`（双击） |

---

## 8. 出问题了先看这几条

| 现象 | 怎么办 |
|---|---|
| `install.ps1 无法加载，因为在此系统上禁止运行脚本` | 用 `install.cmd`，或命令前加 `powershell -ExecutionPolicy Bypass -File` |
| 发布时报「店铺未就绪」 | 先 `node tools\store-ready.js "店铺名"` —— 浏览器上下文闲 20 分钟会被回收 |
| **服务起来了但发布/广告全不工作、也不报错** | 九成是 **`xianyu-monitor` 没放对位置**（见第 2 步的警告） |
| 出图失败 / 版式不对 | `node tools\store-init.js "店铺名"` 看版式库连不连得上 |
| 服务起不来 | 看 `xianyu-playwright-service\startup.log` 最后几十行 |
| 浏览器打不开闲鱼 / 连不上 | 检查这台机器有没有开系统代理（VPN）—— **代理会让闲鱼掐断连接**。关掉代理或让浏览器直连 |
| 想看某个店铺的完整配置 | `node tools\dump-store-config.js "店铺名"`（只读） |
| 想知道闲鱼某个接口能不能做 | `node tools\probe-mtop-apis.js --store="店铺名" --url="<页面>"`（抓它自己的请求，别猜） |

**任何时候卡住**：先看日志（`logs\` / `startup.log` / `ad-window.log`），再把**完整输出**贴给管理员。

---

## 9. 红线（违反了会出真事故）

1. **一个闲鱼账号，只能一台机器、一个店在用。** 两台机器登同一个号会互相踢、还会重复发布。
   装完先跟管理员确认**你这台是不是唯一的**。
2. **别把 `config.local.json` / `service.local.json` 发到群里。** 里面有密钥 —— 安装器只打掩码，文件本身是明文。
3. **别改 `lib/` 里的东西。** 那是代码，不是配置。
4. **别手写 JSON。** 档案用 `store-bulk.js`，本机配置用 `install-config.js` ——
   手写容易漏键、写坏编码（这个项目被 BOM 坑过好几次）。
5. **下架只能点「下架」，永远不要点「删除」。** 下架可逆，删除不可恢复。
6. **发布前先查重**：`node tools\probe-event-dup.js`（改里面的关键词）——
   同一个活动在店里已经有链接时别再发，会判「重复铺货」，可能连带把已有链接的推广也废掉。

---

## 10. 装完之后跟管理员回什么

```
① 预演输出的「两个依赖仓路径」两行
② store-init.js --all 的完整输出（要有 ❌ 的个数）
③ selftest-lib.js 的最后几行
④ 这台机器是不是这个闲鱼账号的唯一一台（红线 1）
```
