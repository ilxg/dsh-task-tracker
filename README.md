# dsh-task-tracker

给 **DeepSeek Harness** 的任务追踪插件：输入框左侧多一个按钮，点开是一扇独立的任务窗口，
实时显示任务进度；**任务跑完 / 出错 / 需要你选择**时弹一条原生 Windows 通知。

```
┌ 输入框工具行 ────────────────────────────────────────────┐
│ ＋   [权限] [计划]   ☑ 3/5 ●            …   [模型]  发送  │
│                      ↑ 本插件                             │
└──────────────────────────────────────────────────────────┘
```

它由两半组成：**浏览器半侧**（`lib/client.js`，注册按钮与通知监视器、组装窗口内容）和
**host 半侧**（`lib/window.js`，一个只绑 `127.0.0.1` 的本机服务：开窗、发原生通知、读会话日志）。
两半零外部依赖，没有构建步骤。

---

## 功能

### 1. 输入框左侧的按钮

插槽 `conversation.input.left` 是 **list** 类型，官方占用者为空，本插件用新 `id = task-tracker`
占一格，不会顶掉旁边的「＋ / 权限 / 计划」。按钮上直接显示 `已完成/总数` 徽标，有任务在跑时
多一个脉动圆点。

点击是**开关**：开着就关、关着就开。（`window.open(url, "同名")` 对一个已存在的名字会返回
一扇**新的空白窗**，所以"每次点击都开"会叠出一堆空窗。）

### 2. 任务窗口：两级列表 + 详情

```
① 项目列表（每次打开都在这里）
   示例工作区        3 个会话 · 1 个等你回复 · 1 个在跑
   demo-project      2 个会话 · 空闲
   归档项目          4 个会话            ← 单独一个门，点进去才展开
        ↓ 点某个项目
② 该项目的会话列表（‹ 返回项目列表）
   重构导出逻辑…    当前会话 · 运行中 · 已运行 12 秒 · 3/5 已完成
   另一个会话        空闲 · 3 天前
        ↓ 点某一行
③ 详情（当前状态 / Token 用量 / 任务清单），‹ 逐级返回
```

- **项目级只显示汇总**（`N 个会话 · N 个等你回复 · N 个在跑`），点进去才列会话；项目内不重复项目名。
- **每一行都带 token 用量与缓存命中率**：项目行是该项目所有会话的合计，会话行是各自的用量。
  合计的命中率按 **billed token 加权**重算，不是把百分比平均。
- **归档单独成门**：按 `useWorkspaces()` 快照里的 `archivedSessionIds` 判定，归档会话不与在线会话混排。
- **会话行 meta** 带相对时间，需要区分时再带项目名。
- **打开时总是回到①**：`openWindow()` 会把位置重置到项目列表；窗口开着的时候位置照常保留。

**两类会话不显示**（都会挤占列表，而且都不是你发起的对话）：

| 类型 | 判定 | 为什么隐藏 |
| --- | --- | --- |
| 子会话 | `parentId` / `parentSessionId` / `origin: 'subagent'` | 工作流派生的子会话可能一次几十个，描述还都一样 |
| 空会话 | 会话行的 `blank` 标记 | 没有首条消息 → 标题回退成**目录名**，看着像"多出来的项目" |

**这两类也不会触发系统通知**：否则一次 `task` 工具派生的子 agent 结束就会弹一条「任务已完成」
—— 只有**整个任务**结束才该弹。两级的计数都不含它们。

**会话作用域的投影只属于本页打开的那个会话**。看别的会话时：

| 看的是哪个会话 | 标题 | Token 用量 | 任务清单 / 进度线 |
| --- | --- | --- | --- |
| 应用当前打开的那个 | 它自己 | 权威投影：总量 / 输入 / 输出 / 缓存命中 | 有 |
| 别的会话 | 它自己 | **它自己会话行上的**总量与缓存命中（标注「本会话」） | 没有，只有一行说明 |

进度线用的是同一个 todo 投影，所以遵守同一条规则：不属于本页打开的会话时，它显示
「任务清单只在打开该会话时可见」，而不是借一个数字。

### 3. 通知

系统通知**标题就是任务状态**，正文是会话名与状态：

| 触发 | 标题 | 说明 |
| --- | --- | --- |
| 会话从「运行中」变成不再运行，**且是跑完的** | 任务已完成 | 只对**整个会话**报一次 |
| 同上，但那一轮**是自己按停的** | *（不弹）* | 只写进诊断记录，方便回答"为什么没弹" |
| 同上，原因是 `error` / 其他 | 任务失败 / 任务未跑完 | 出错与"跑了一半停下"用不同文案 |
| 出现 `pendingInteraction`（提问 / 计划待审 / 待授权） | 需要你的选择 | 同一会话同一事件只报一次 |

#### 「跑完」和「按停」为什么能分开

插槽快照只给 `running` 布尔值：`useSessionStatus` 交出来的就是
`{ running, pendingInteraction, completionUnread }`，里面**没有原因**，所以"我按了停止"和
"它跑完了"在页面上长得一模一样。可用的投影也没有这个信息（`sessionStats` 只有轮数/步数/耗时，
`turnOutline` 只有提问与回答的预览）。

**唯一记录原因的是会话日志**：每一轮都以 `turn/end { data: { reason: { kind } } }` 收尾。
所以 host 半侧读它（`POST /turn`），客户端只负责按结果决定说不说、怎么说。实际会出现的取值：

```
completed    跑完了            → 任务已完成
error        出错了            → 任务失败
max-tokens   上下文用尽等停下   → 任务未跑完
aborted      你自己按的停止     → 不播报
```

**读日志的坑**：会话日志是**追加写的 zstd 流，一次写一个 frame**。`zstdDecompressSync` 一次只解出
**第一个 frame**（那行会话头），于是整段对话看起来是空的 —— 必须按 frame 魔数切开逐个解。
`tools/turn-ends.mjs` 把这个技巧做成了一个小工具，可以先把真实取值数出来再信任它。

**原因读不到时照样报**（日志没落盘、会话不在本机、host 半侧没起来）：一律按「任务已完成」播报。
宁可多报一次，也不能把真正的完成悄悄吞掉。

#### 通道

走 **host 侧的原生 Windows toast**：浏览器 `Notification` API 在这个桌面构建上「权限 granted、
构造成功、但什么都不进通知中心」（注册表 `LastNotificationAddedTime` 不更新、`onshow` 从不触发），
所以由 host 用 PowerShell 5.1 的 WinRT 投影发一条归属本应用 AUMID 的 toast —— 用法是
「临时 `.ps1` + 环境变量传 payload」，**且不能 `detached`**（detached 启动时 PowerShell 静默失败）。
服务不可用时才回落到浏览器 API。

host 的 `/notify` **250 ms 只放一条**，而一个 tick 里很容易有两个事件（一个会话结束、另一个开始
等你）；被拒会**重试一次**再回落 —— 否则第二条会交给一个根本送不到的通道，静默消失。

### 4. 任务运行时间

会话详情的「当前状态」里显示这一轮的运行时间：

```
● 重构导出页                运行中 · 已运行 1 分 23 秒
● 重构导出页                空闲 · 上次运行 2 分 10 秒
```

`running` 是布尔值，它不说这一轮**什么时候开始的**，所以读数由两个来源合起来：

1. **页面看到的边沿**：会话从「不在跑」变成「在跑」的那一刻（一秒 tick 里顺带记录，不新增订阅）；
2. **会话日志的 `turn/start`**：`time` 是 **epoch 毫秒**，可以直接和页面时钟比 —— 这一条覆盖了
   页面看不见起点的情况（面板打开时任务已经在跑、页面刚刷新过）。

关键在区分这两者：页面第一次看到某个会话时它可能已经跑了十分钟，此时自己起一个秒表会把它
报成「3 秒」。所以运行记录里有一个 `certain`：

| 情况 | 显示 |
| --- | --- |
| 看着它开始的（或日志已给出 `turn/start`） | `已运行 12 秒` |
| 第一次看到时它已经在跑、日志还没回答 | `已运行 ≥12 秒` —— **下限**，不是假数 |
| 跑完了 | `上次运行 2 分 10 秒`（冻结，不再跳动） |

时长按人读的方式取舍：`12 秒` / `1 分 23 秒` / `2 小时 5 分`（过了小时不再报秒）。读数是按会话 id
记的，所以**别的会话的详情也有** —— 这一项不像 `todos` / `tokenUsage` 那样是"本页打开才有"的投影。

---

## 安装

### 一般用户：在插件管理器里填地址

DSH 的插件管理器接受**托管仓库地址**，所以把这一行贴进去即可：

```
https://github.com/ilxg/dsh-task-tracker
```

（也接受 `github:ilxg/dsh-task-tracker`、`git+https://…`、`.tgz` 链接，以及 npm 包名。
它内部就是用 pnpm 装进当前 profile：包没有任何依赖、也没有安装脚本，所以不会要求你批准
`allowBuilds`。装完 bundle 会被自动选中。）

装进来的只有运行需要的东西 —— 8 个文件、约 55 KB：

```
package.json  cordis.patch.yml  icon.svg  LICENSE  README.md
lib/index.js  lib/host.js  lib/window.js  lib/client.js  locale/{en,zh}.json
```

> `tools/` 只在 git 仓库里，不随包安装 —— 那些是开发与取证工具，运行插件不需要它们。
> 想跑自检请 clone 仓库。

### 本机开发：junction + patch 行

桌面端 profile（`~/.dsh/profiles/desktop`）由 Electron 独占管理，`dsh plugin` 会拒绝操作，
所以本仓库自带一个挂载脚本 —— **不动 profile 的 `package.json` 与 lockfile**：

```powershell
node tools/install.mjs             # 查看状态
node tools/install.mjs --install   # 挂载（幂等；改动前会备份 cordis.patch.yml）
node tools/install.mjs --uninstall # 卸载
node tools/install.mjs --profile web --install   # 其他 profile
```

它做两件事：

1. 建 junction `<profile>/node_modules/dsh-task-tracker` → 本目录；
2. 在 `<profile>/cordis.patch.yml` 末尾追加一段带标记的 `insert`（两行：包入口 + `dsh-task-tracker/window`，
   后者是一个**从未导入过的模块 URL**，用来绕过 Node 的 ESM 缓存 —— 这样改完 host 半侧不必重启 DSH）。

**装完刷新页面即可**（F5）。DSH 的 profile 配置是活的：运行中增删该行，boot graph 会跟着变。

> 若某个 profile 的 pnpm 之后重装依赖，junction 可能被清掉，重跑一次 `--install` 即可。

### 跨平台

| 能力 | Windows | macOS / Linux |
| --- | --- | --- |
| 按钮、任务窗口、任务运行时间 | ✅ | ✅ |
| 通知 | 原生 Windows toast | 回落到浏览器的 `Notification` API |
| 独立窗口 | DSH 自己的窗口（打了外壳补丁）或 Edge/Chrome 应用窗口 | 浏览器应用窗口；没有则应用内浮层 |

host 半侧的 `/notify` **无论如何都回 200**，但它用响应体里的 `toast: true|false` 说清楚到底有没有
弹出来 —— 原生 toast 是 Windows 专有的，所以客户端在 `toast !== true` 时会**接着走浏览器通道**，
而不是把"host 回话了"当成"通知送达了"。

---

## 本机服务与安全边界

host 半侧只绑 `127.0.0.1`（17777 起，占用则顺延），端点：

| 端点 | 作用 |
| --- | --- |
| `GET /ping` | 发现服务；回带客户端心跳、窗口状态、最近一次 toast 结果与回合查询结果 |
| `POST /health` | 客户端自报（版本、级别、按钮的 DOM 矩形） |
| `POST /state` / `GET /state` | 推 / 读窗口快照 |
| `POST /nav` | 窗口页把行点击传回来 |
| `POST /turn` | 读会话日志：这一轮怎么结束的、什么时候开始的 |
| `POST /notify` | 发一条原生 toast |
| `POST /open` `/close` `/toggle` | 开关 Edge/Chrome 应用窗口 |
| `GET /` | 窗口页 |

一个监听 loopback 的 HTTP 服务，**任何网页都能对它发请求**，所以端点做了四道限制
（`tools/hostcheck.mjs` 里有对应的回归断言，改坏了会红）：

| 限制 | 挡住的攻击 |
| --- | --- |
| `Host` 必须是 `127.0.0.1` / `localhost` / `[::1]`（含端口） | **DNS rebinding**：公网域名解析到 127.0.0.1 时，Host 头仍是它自己的名字 |
| `Origin` 必须是 `dsh-app:`、`null`（个别构建下应用页是 opaque origin）或同端口 loopback | 普通网站直接读 `/state`（会话标题、项目路径）或伪造 `/notify` |
| 写端点**只接受 POST** | `<img src="http://127.0.0.1:17777/toggle">` 这类 **no-cors GET** —— 浏览器在这种请求上**不发 Origin**，只靠 Origin 门是挡不住的 |
| CORS 只回显被接受的那个 origin，并给 `vary: origin` | 任意站点读取响应体 |

另外：`/notify` 有最小间隔与 512 KB 体积上限；窗口页带 `default-src 'none'; frame-ancestors 'none'`
的 CSP；toast 用的 PowerShell 脚本**每次都在插件自己的私有目录里用随机名生成、用完即删**
（放在共享 `%TEMP%` 里的固定文件名会被同用户进程替换成任意脚本，而它是以
`-ExecutionPolicy Bypass` 跑的）；页面只接受**颜色字面量**作为 CSS 变量，避免快照让窗口去加载外部资源。

---

## 窗口怎么开

窗口由**输入框那个格子每秒把一份 view 推给 host 服务**（`POST /state`），窗口页只负责画。
这一条是必需的两半：格子是**会话作用域**的，回合进行中会被重挂载甚至不再渲染；而窗口页是纯 HTML，
读不到 app 的 store。所以「读快照」和「画窗口」被拆开：格子在自己的每次渲染里把最新快照交给
模块级单例（`globalThis.__dshTaskTrackerShared`，热更新换实例也不丢），模块级的**一秒 tick**
读它、组装 view、推给 host，并在同一个 tick 里判定通知。

窗口按可用性降级：

| 模式 | 机制 | 说明 |
| --- | --- | --- |
| `popup` | 外壳补丁放行的 `about:blank#dsh-task-tracker` | **DSH 自己的窗口**：同一任务栏条目、随应用退出、可缩放 |
| `host` | host 半侧 `POST /open` + Edge/Chrome `--app=` | 未打补丁时的窗口：独立进程的浏览器应用窗口 |
| `panel` | 应用内浮层 | 前两者都起不来时的兜底，保证点按钮不会毫无反应 |

窗口页是**哑渲染器**：它和面板渲染的是**同一份 view**（含 `mode` 与 `compact`），所以措辞与分段
不会分叉。

### 可选：让窗口变成「DSH 自己的窗口」

默认情况下 host 拉起的是 **Edge/Chrome 的应用窗口**（独立进程、独立任务栏分组）。要让它**属于
DeepSeek Harness 自己**，需要给桌面外壳打一个**外科式补丁** —— **可选、每台机器各自决定**的增强；
**插件本身不依赖它**（没打补丁时自动用 Edge 窗口，功能完全一样）。

```powershell
node tools/shell-patch.mjs --status   # 是否已打、是否有备份、应用是否在运行
node tools/shell-patch.mjs --build    # 只生成 app.asar.patched 并校验，不碰原文件
node tools/shell-patch.mjs --apply    # 替换（需要应用已关闭）
node tools/shell-patch.mjs --revert   # 还原
```

**改了什么**：主窗口的 `setWindowOpenHandler` 原本一律 `deny`，补丁只放行**一个**标记 URL
`about:blank#dsh-task-tracker`（并给该窗口设好尺寸/标题/不透明底色）；其余策略不变。

**为什么低风险**：不是重打包整个归档，而是把补丁版 `lib/main.js` **追加到 asar 末尾**，再把 header 里
**这一个条目**指向它；header JSON 用空格补齐到**完全相同的字节长度**，于是数据段不移动，
其余条目**逐字节不变**。替换前后各验证一次，**验证失败会自动回滚**。

**代价**：应用更新会覆盖 `app.asar`，补丁失效 → 重跑一次；失效期间插件自动回落 Edge 窗口。
`tools/apply-shell-patch.cmd` 与 `tools/revert-shell-patch.cmd` 是双击即可的包装脚本。

---

## 开发与验证

```powershell
node tools/selfcheck.mjs        # 浏览器半侧：桩 React + 桩 loader + 桩 DOM，加载真 bundle
node tools/hostcheck.mjs        # host 半侧：真起一次本机服务，走完所有端点与门禁
node --check lib/client.js      # 语法检查（window.js 同理）
node tools/turn-ends.mjs        # 数一遍会话日志里 turn/end 的真实取值
node tools/read-diagnostics.mjs # 解码出最新一条诊断记录（--all 看全部）
```

`selfcheck.mjs` 覆盖：加载器信封、`inject` 声明、三处版本一致、按钮注册进 `conversation.input.left`、
**钩子顺序不随数据变化**、view schema、不透明调色板、todos/token 分区、`POST /state`、
通知判定（跑完报一次 / 中断不报 / 子会话与空会话不报 / 四种结束原因各自的文案）、
**最新副本接管 tick**、重载后不重放旧点击、像真点击那样驱动窗口、被限流的 toast 会重试、
任务运行时间的四种文案与 `≥` 限定。

`hostcheck.mjs` 额外覆盖：`/turn` 读真实与合成会话日志（含"报的是最新那一轮"、`settled` 语义、
`session-` 前缀的目录回落）、点击回执作废、toast 的落定结果。
`--open` 会真开一次浏览器窗口再关掉，`--notify` 会真发一条原生 toast。

### 诊断记录（`dsh-task-tracker.diagnostics.v1`）

插件把「这个页面实际发生了什么」写进 localStorage，出问题时可直接从磁盘读出来：

| 字段 | 含义 |
| --- | --- |
| `appliedAt` / `version` | `apply()` 在本页运行的时刻与版本 |
| `tickOwner` | **哪个副本握着那个一秒 tick**。和 `version` 不一致就说明"新代码在页面里，但没在跑" |
| `entryInvokedAt` | 输入框左侧的按钮组件**被框架调用过** |
| `monitorRenderedAt` | 通知监视器真的被渲染过 |
| `notificationLog` | 最近 6 条通知：`kind`、`at`、`sessionId`、`reason`、`notified`、`channel`、`delivered`。**被故意跳过的中断也在里面**，所以"为什么没弹"有答案 |
| `lastNotificationAt` / `lastNotificationChannel` / `lastNotificationDelivered` | 最近一次通知的时刻、通道（`host` / `browser`）、是否真的送进系统 |
| `lastTurnReason` | 最近一次从会话日志读到的结束原因 |
| `openedAt` / `openMode` | 任务窗口被打开过，以及用了哪种模式 |
| `tickError` / `renderError` | tick 或窗口重绘抛出的异常（正常情况下不出现） |

桌面端 GUI 的 localStorage 落在 `%APPDATA%\@deepseek-ai\dsh-desktop\Local Storage\leveldb\`。
`read-diagnostics.mjs` 会把**最新那条**解码成 JSON 打印出来：Chromium 把值写成 UTF-16LE，
所以要按 UTF-16LE 解码再 `JSON.parse`，否则整条记录既花屏又被截断。

从外部确认它还活着：

```powershell
curl http://127.0.0.1:17777/ping
# health.version / health.owner / health.left.ids / health.button.found+clickable
# lastToast: 最近一次 toast 的落定结果
# lastTurn:  最近一次回合查询（sessionId / state / reason / startedAt）
```

### 改完客户端之后，页面怎么拿到新版本

改了 `lib/client.js`，宿主会算出新的 `rev`（sha1 over mtime+ctime+size），`/plugins/events` 上广播
`rebuilt`，页面会**重新抓取并执行**新 bundle。要注意两点：

1. 旧实例的 `setInterval` 不会自己消失。**`apply()` 会把现有 tick `clearInterval` 掉再装上自己的**，
   最新的副本因此一定接管（比当前 owner 旧的副本拒绝接管）；`/health.owner` 与诊断里的 `tickOwner`
   直接说出**现在跑的是哪一份**。
2. 插件自己也会刷新页面：监视器挂载时读 `__DSH_BOOT__` 里自己的 bundle URL，比对版本号与本模块版本，
   不一致就 `location.reload()` 一次（`sessionStorage` 标记防循环）。

`lib/window.js` 是 **host 半侧**，Node 按 URL 缓存 ES 模块 —— 改它要**重启 DSH** 才生效。
这是为什么每一条依赖 host 的行为都必须有降级路径，也是为什么窗口页有一道 `selfcheck` 门禁。

---

## 结构

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 包入口，转出 host 半侧 |
| `lib/host.js` | 极薄的再导出：让 `dsh-task-tracker/window` 与包入口指向**同一个 URL** |
| `lib/window.js` | **host 半侧**：本机 HTTP 服务（Host/Origin 门禁 + 仅 POST 的写端点）、原生 toast、会话日志读取器（`/turn`）、窗口与窗口页 |
| `lib/client.js` | **浏览器半侧**：输入框按钮 + 三态视图 + 不透明调色板 + 一秒 tick（推 view + 判通知）+ 自更新 |
| `cordis.patch.yml` | 本插件自己的 bundle patch（供 profile 层栈引用） |
| `tools/install.mjs` | 挂载 / 卸载 / 状态 |
| `tools/selfcheck.mjs` · `tools/hostcheck.mjs` | 浏览器半侧 / host 半侧的离线自检 |
| `tools/turn-ends.mjs` | 数会话日志里 `turn/end` 的真实取值（也是逐 frame 解 zstd 的最小示例） |
| `tools/read-diagnostics.mjs` · `rev-probe.mjs` · `scan-cache.mjs` · `feature-probe.mjs` | 取证：诊断记录 / 页面抓过的 rev / Code Cache / 浏览器能力探测 |
| `tools/screenshot.mjs` · `reload-window.mjs` | 截窗口 / 把刷新键发给窗口（仅诊断） |
| `tools/sessions-probe.mjs` · `session-detail.mjs` · `session-scan.mjs` · `session-search.mjs` | 从磁盘核对会话：列表、单个会话的 cwd 与来源、哪些是空会话、按内容全文检索 |
| `tools/shell-patch.mjs` · `apply-shell-patch.cmd` · `revert-shell-patch.cmd` | 可选的外壳补丁（原子替换 + 校验 + 自动回滚） |
| `tools/fuse-probe.mjs` · `fuse-dump.mjs` · `entry-check.mjs` · `asar-lib.mjs` | asar 结构 / Electron fuse / 归档条目核对（补丁链路用） |

---

## 实现要点

- **插槽**：`conversation.input.left`（会话作用域 list）放按钮 —— 该 list 的官方占用者为空
  （旁边的权限 / 计划是相邻的 `single` 槽），所以新 `id` 是**加一格**而不是顶掉谁；
  `shell.overlay`（root 作用域 list）放监视器：占住一个必然渲染的座位、把 root 作用域的 store
  快照交给 tick、把「按钮到底在不在」上报给 `/health`。
- **钩子顺序是契约**：`useProjection` / `useSessionStatus` / `useSessions` 都是
  `useSyncExternalStore` 选择器 hook，**调用本身就是 hook**。条件调用会让 React 抛
  minified #310 并**注销整个格子**（按钮永久消失），所以这些调用无条件、固定顺序，
  `selfcheck.mjs` 有一条专门的顺序断言。
- **快照与绘制分离**：格子每次渲染把快照写进模块级单例，一秒 tick 读它并组装 view。
  窗口开着时才 `POST /state` 推给 host；关掉窗口就不再发。
- **只有最新的副本拥有 tick**：热更新会把新 bundle 装进一个旧副本还在跑的页面里，
  该活下来的是**状态**（导航位置、窗口句柄、通知标记），从来不是定时器。
- **不透明**：应用自己的菜单底色是半透明的，面板此前继承它才会透出后面的内容。插件从当前文档
  解析出自己的调色板，把文字/背景/描边/悬停色全部**合成到不透明底色**上再使用，且不使用
  `backdrop-filter`；窗口页也把这套调色板作为 CSS 变量注入。发丝线只是暗示、不能是高光：
  候选色若几乎等于底色、或在深色主题上亮到 >0.85，就换成反向色调的低透明度中性色。
- **通知去重**：等待中的交互用框架自带的唯一 `key` 去重，并在交互消失时才忘掉它 ——
  按时长冷却不够（提示会被反复重新发布，措辞一变就换了键），那正是"提示一直弹"的成因。

---

## 已知边界

- **「中断」的判定依赖 host 半侧**：客户端问 `POST /turn`。host 半侧改了要重启 DSH。
  重启前后果不同但都不崩：`/turn` 不可用 → 结束原因读不到 → 按「已完成」报；
  **运行时间**退化成"从本页第一次看见它起算"，并带 `≥` 前缀说明这是下限。
- **通知需要页面处于打开状态**：桌面端关掉窗口后页面仍在（托盘常驻），此时通知照常；
  彻底退出应用则不会有人通知你。
- **独立窗口依赖外壳补丁**：没打补丁时 Electron 外壳拒绝 `window.open`，插件自动改用 host 的
  Edge 窗口（功能一样，只是任务栏是另一个条目）。
- **只在有会话时才有按钮**：`conversation.input.left` 是会话作用域的，新建会话的空态没有输入框，
  也就没有按钮。
- 该桌面壳没有绑定刷新快捷键，客户端更新靠「页面自更新」或手动 F5；应用更新会覆盖 `app.asar`，
  外壳补丁随之失效（失效期间自动回落 Edge 窗口）。

---

MIT License — 见 [LICENSE](LICENSE)。
