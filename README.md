# dsh-qq

把一个 OneBot 实现的 QQ 接成一条能进来的路：主人的私聊就地开一段会话，回答发回 QQ，文件能送出去，要提权的工具调用能发到手机上批。

## 它做什么

OneBot 实现（NapCat、SnowLuma 之类）本身只是管道：消息能进能出，但那条线上说话的还不是 agent。这个插件补的是中间那一截——只认一个主人的私聊，就地（或复用）在 DSH 里开一段会话，挂上和别的会话一样的 preset，把私聊内容当 user 消息喂进去；agent 说出来的话攒够一段安静时间，就切块发回 QQ。

它顺手做三件通常需要的事：

- **进来的图/语音/文件**：向 OneBot 实现索取原文件（`get_image` / `get_record` / `get_file`），落到本地目录留一份副本，路径以 `[图片] <路径>` 的形式缀在正文后面交给模型。以前只认文字段，纯图消息整条被吃掉。
- **出站文件**：回答里单独一行 `[SEND_FILE: <绝对路径>]` 会被剥出来（正文照旧发），按扩展名走语音条 / 图片 / 文件三种消息段。
- **审批**：需要提权的工具调用会被抢先接到审批瀑布上，发到主人的 QQ 里——回 `1` 放行，回 `0` 不批；到点没动静就先催一句，再没动静就交还给别的应答者（比如桌面端那张卡）。

## 装

```
dsh plugin add hzh5021/dsh-qq
```

手工四步：

1. 把包放进 `~/.dsh/plugins/dsh-qq/`。
2. profile 的 `package.json` 里 `dependencies` 加一条（本机口径：`"dsh-qq": "file:../../plugins/dsh-qq"`），并在 profile 的 `node_modules/` 下留一个同名联接。
3. 同一份 `package.json` 的 `dsh.profile.bundles` 里加上 `"dsh-qq"`。
4. 重启 DSH。

插件行（含 `config`）由本包自己的 `cordis.patch.yml` 插进 profile 花名册。`wsUrl` 里如果带 token，注意那份 yml 会跟着仓库走——提交前先把它换成占位符。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `wsUrl` | `"ws://127.0.0.1:3001"` | OneBot 正向 WebSocket 地址；带 token 就写在 URL 的 query 里 |
| `ownerId` | `0` | 唯一放行的 QQ 号。`0` = 谁都不放行（私聊一律丢掉，启动时大声报一次）——必须配 |
| `cwd` | `~/.dsh/dsh-qq/workspace` | 会话的工作目录（写进 session meta），启动时自动建出来；不建的话工作区按路径认不到人，会话会落在未分组里 |
| `agentPreset` | 未设 | 要挂到会话上的 preset id |
| `settleMs` | `2000` | 回答停顿这么久没有新内容，就当它说完了 |
| `maxChars` | `1700` | 一条消息最多多少字，长了切开 |
| `idleResetMs` | `21600000` | 隔这么久没说话，下一条消息当新话题；`0` = 关掉 |
| `approvalTimeoutMs` | `300000` | 等主人批/不批最多这么久，到点还给下一个应答者 |
| `approvalRemindMs` | `90000` | 到点先催一句；`0` = 不催 |
| `reconnectMaxMs` | `30000` | 重连退避的上限 |
| `httpPort` | `3002` | 只监听本机的小状态口，读的是 JSON |
| `logFile` | `~/.dsh/dsh-qq/dsh-qq.log` | 日志文件 |
| `qrPath` | `""` | OneBot 实现落的登录二维码图片路径（状态口 `/qr` 会把它吐出来） |
| `napCatLog` | `""` | 解码 URL 所在的日志（二维码图扫不动时可以手敲那个 URL） |
| `mediaDir` | `~/.dsh/dsh-qq/media` | 进来的图/语音/文件落这儿 |

一处要留意：会话的 provider/model 取自宿主的默认选择（`ctx.agentDefaultModel.currentSelection()`），插件不提供这两个配置项。另外 `httpPort` 不在 `DEFAULTS` 里，是读的时候带上的默认值（`Number(opts.httpPort) || 3002`）。

```yaml
- id: qq
  name: dsh-qq
  config:
    wsUrl: ws://127.0.0.1:3001/?access_token=<YOUR_TOKEN>
    ownerId: <your-qq-number>
    cwd: <a scratch directory>
    agentPreset: <preset id>
```

## 怎么工作

**服务**：`inject = ["agents", "agentDefaultModel", "agentPresets", "workspaceRegistry"]`。

**开会话**（`convFor`）：session id 取 `qq-<userId>`。三样都不能省——provider/model 从 `agentDefaultModel.currentSelection()` 取（不给会话醒不来）；`cwd` 放进 meta（不给的话会话落在 `_no-cwd`）；`setup` 里 `agentPresets.mount()` 把 preset 挂上去，这一步就是「把 agent 自己装进这段会话」。撞名（`already exists`）时退化成 `qq-<userId>-<时间戳>`，**真名必须从 `handle.agent.session.id` 反取**，记错名字回话就对不上号。开完还要 `workspaceRegistry.resolveByPath(cwd)` 拿到工作区并 `attachSession(realId)`，否则会话只在侧栏「未分组」里躺着。

**收话**：`ws.onmessage` 里先认回包（`echo` 匹配 `pending`，给上面的 `get_*` 请求用），再认 `post_type === "message"`、`message_type === "private"`、`user_id === ownerId`。纯媒体消息也收（不再要求必须有文字）。

**发话**：`session/event` 里只认 `assistant/message`，只取 `text` block（`reasoning` 不算），攒进 `chunks`，安静 `settleMs` 之后 `flush` 一次，按 `maxChars` 切块发出。

**名字漂移的兜底**：DSH 重启后，新壳里的 `session.id` 可能跟插件手里记的名字对不上（撞名时加过时间戳）。对不上时从 `qq-<userId>` 前缀反抠 userId 认人——认的是这条线，不会把别人的话发错人；顺手把记录里的名字更新掉，之后不再走兜底。这是栽过两次的地方：曾经回答在这里被静默丢掉，一条日志都不留。

**审批**：`ctx.on("approval/request", handler, { prepend: true })`。批准在宿主里是一条 waterfall，谁先给出结论谁说了算，桌面端那张卡也是链上的应答者，所以必须 prepend 抢在它前面。只接 `qq-<userId>` 打头的会话，别的会话一律 `next()`；一条会话同时只等一个；`request.signal` 一 abort 就当取消。答复词的判定**先看否、再看肯**——「不批」里也含「批」，顺序反了会把拒绝读成同意。

**换新会话**：主人发 `新对话`、`新会话`、`/new`、`/新对话`、`/新会话`、`换个话题`、`/clear`（不分大小写）就丢掉手里的会话，下一条消息就地开新的；`idleResetMs` 到了也会自行换新。

**状态口**：本机 `http://127.0.0.1:<httpPort>/status`（连接态、ownerId、会话数、工作目录、二维码、日志尾部）和 `/qr`（二维码原图）。只读、只监听 `127.0.0.1`，给脚本或自己写的客户端读。

**日志写不进去会出声**：`logFile` 曾经指着一个不存在的目录，写失败被 `catch` 吞掉，于是「日志里没有 connected」被当成了断线的证据——那是一条从来没有出口的证据。现在写不进去会打一行 `LOG FILE UNWRITABLE`，并说明从这行起文件里看不到日志。

**重连**：`ws.onclose` 后按 `min(reconnectMaxMs, 1000 × 2^min(attempts,5))` 退避重连；`dispose` 时不再重连。

## 边界

- 需要一个 OneBot 实现并提供正向 WebSocket；这个插件不带协议实现，也不是机器人框架。
- 只认一个 owner（`ownerId`）：群里、别人、机器人自己发的一律不理。**没配就是谁都不放行** —— 这是刻意的默认值，配好之前这条通道是哑的。
- 审批搬到 QQ 依赖宿主把批准做成 `approval/request` 瀑布；别的形态接不上（会退回 `next()`）。
- 出站文件按扩展名分三种段：`.silk/.amr/.slk` → 语音，`.png/.jpg/.jpeg/.gif/.webp/.bmp` → 图片，其余 → 文件。原生表情那类消息段不在支持范围。
- 这个包不带浏览器界面：状态只在 `http://127.0.0.1:<httpPort>/status` 那个 JSON 口上，要面板自己接。
- 进来的媒体靠向 OneBot 实现要原文件，拿不到就只在正文里留一行「（没取到原文件）」，不拦消息。
- 只用 Node 内置模块（内置 WebSocket、`node:http`、`node:fs`）。

## 冒烟测试

这个包没有自带 `test/`。手工验法：OneBot 实现起来之后重启 DSH，用主人的号发一条私聊，看会话有没有开出来、回答有没有发回 QQ；再看 `http://127.0.0.1:<httpPort>/status` 里的连接态和日志尾部。

## English

**What it does** — Bridges a OneBot QQ bot into DSH: the owner's private messages open (or reuse) a session on the same preset, replies are collected and sent back in chunks, incoming images/voice/files are fetched and materialized locally with their paths appended to the message, `[SEND_FILE: <abs path>]` lines are stripped and delivered as record/image/file segments, and pending permission requests are forwarded to QQ (`1` = allow once, `0` = reject) with a reminder and a hand-off back to other answerers on timeout.

**Install** — `dsh plugin add hzh5021/dsh-qq`, or drop the package into `~/.dsh/plugins/dsh-qq/`, register it in the profile `package.json` (`dependencies` + `dsh.profile.bundles`) and restart DSH.

**Config** — `wsUrl`, `ownerId` (`0` = nothing is accepted until you set it), `cwd` (`~/.dsh/dsh-qq/workspace`, created on start), `agentPreset`, `settleMs` (`2000`), `maxChars` (`1700`), `idleResetMs` (`21600000`), `approvalTimeoutMs` (`300000`), `approvalRemindMs` (`90000`), `reconnectMaxMs` (`30000`), `httpPort` (`3002`), `logFile`, `qrPath`, `napCatLog`, `mediaDir`.

**Requirements** — An OneBot v11 implementation exposing a forward WebSocket; DSH with `agents`, `agentDefaultModel`, `agentPresets` and `workspaceRegistry`; Node 18+; no external dependencies.

**License** — MIT.

MIT 许可。