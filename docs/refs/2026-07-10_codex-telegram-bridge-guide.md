---
date: 2026-07-10
type: reference
tags: [codex, telegram, bridge, self-hosting, app-server]
source: codex
related: []
visibility: public
status: sanitized-reference
---

# 自托管 Telegram ↔ Codex Bridge：架构、权限与部署指南

> 这是一份可以转发给朋友和其他 AI 的脱敏说明。它总结了一套已经在线运行并经过真实故障检验的实现，但不包含生产源码、服务器身份、用户名、bot、chat ID、token、私人记忆、日志或真实目录。

## 先说结论

我们搭的是一个轻量、自托管的 **Telegram ↔ Codex 适配层**：Telegram 负责聊天入口，Codex 负责 agent runtime，中间由一个常驻 Node.js bridge 处理身份校验、会话映射、权限、状态和消息格式。

它不是 OpenAI 官方 Telegram 插件，也还不是一个已经公开发布、下载即用的 npm 包。更准确的定位是：

> 一套从生产环境提炼出来、已验证可行的 reference implementation；架构可以复用，但分享前仍需要把生产配置参数化并补齐安装脚本。

整体链路如下：

```text
Telegram 用户
    │
    ▼
Telegram Bot API
getUpdates long polling
    │
    ▼
自建 Node.js bridge
鉴权 · 命令 · 队列 · 状态 · 权限 · 分泡
    │ JSON-RPC over stdio
    ▼
常驻 codex app-server
thread · turn · events · approvals
    │
    ▼
服务器 workspace / vault / tools
    │
    └────────── final answer ──────────► Telegram
```

不需要开放公网入站端口，也不依赖 webhook。bridge 作为 `systemd --user` 服务常驻，通过 Telegram long polling 收消息，通过 stdio 维持一个长期运行的 Codex app-server 子进程。

参考实现启动的核心进程形态是：

```bash
codex app-server --listen stdio://
```

## 哪些是官方能力，哪些是自建层

| 层 | 来源 | 负责什么 |
|---|---|---|
| Codex CLI / `codex app-server` | OpenAI | agent thread、turn、工具执行、事件、sandbox、approval 协议 |
| Telegram Bot API | Telegram | `getUpdates`、`sendMessage`、bot 身份与消息传输 |
| Node.js bridge | 自建 | 把 Telegram chat 映射到 Codex thread，处理权限、状态、指令、队列与输出分泡 |
| systemd | Linux | 管理该 unit 的常驻、重启、日志与生命周期；仍需防止其他 unit 或手工进程使用同一 token |

OpenAI 的 [`codex app-server` 官方文档](https://developers.openai.com/codex/app-server/)把它定位为将 Codex 嵌入其他产品时使用的协议层，包含认证、会话历史、审批与流式 agent 事件。它提供 `thread/start`、`thread/resume` 和 `turn/start` 等生命周期方法，并允许 turn 级的 model、reasoning effort、cwd 与 sandbox 覆盖。

这正好适合 bridge：Telegram 只是一种 UI，不需要每条消息重新 spawn 一个短命的 `codex exec` 进程，也不需要自己伪造 agent 的内部会话语义。

需要分清：app-server 提供 approval 协议，但 Telegram 按钮、slash commands、chat/thread 映射和具体审批 handler 都属于自建层。当前 reference implementation 尚未接通 app-server v2 的新 approval methods，不能把“官方协议存在”理解成“Telegram 交互审批已经可用”。

## 一条消息具体怎么走

1. bridge 用 `getUpdates` 长轮询 Telegram，并持久化 update offset。
2. user ID 必须命中 allowlist；如果另外配置了 chat allowlist，则 chat ID 也必须命中。其他消息在进入 Codex 前就被拒绝。
3. bridge 解析 `/new`、`/effort`、`/write` 等控制指令；普通文本则进入当前 chat 的任务队列。
4. 每个 Telegram chat 绑定一个 Codex thread ID。已有 thread 时调用 `thread/resume`；没有时调用 `thread/start`。
5. bridge 用 `turn/start` 发起本轮任务，并显式传入全局配置的 model、这一 chat 当前的 effort、cwd 与 sandbox 策略。
6. app-server 持续发回事件；当前实现聚合最终答案，不把工具过程逐条刷进 Telegram。
7. 最终答案经 Markdown-structure-aware 的纯文本分泡器处理，再用 `sendMessage` 发回 Telegram。
8. thread ID、offset 和每个 chat 的运行设置写入 bridge 自己的 state 目录；Codex 的 thread 内容还依赖 service user 的 `$CODEX_HOME` session storage。两边都保留时，服务重启不等于丢会话。

同一个 chat 内必须串行执行，避免两轮同时修改同一 thread。不同 chat 可以按实现选择并发，但需要同时考虑 app-server 容量、共享文件写入和速率限制。

## 当前参考实现已经具备的能力

### 会话与运行状态

- 一 Telegram chat 对应一 Codex thread。
- thread ID 跨 bridge 重启保留。
- Telegram update offset 持久化，避免重启后从头重放消息。
- model 可从 Telegram 查询；当前实现通过服务配置切换 model，而不是按 chat 切换。
- reasoning effort 可从 Telegram 查询、按 chat 切换并持久化。
- effort 按 chat 保存，并在每个 turn 显式覆盖，避免“配置文件改了但旧 thread 仍沿用旧状态”。
- app-server thread 失效时可清除旧映射并自动新建，使服务恢复；原 thread 的上下文不会凭空迁移到新 thread。
- 单轮默认 15 分钟超时，可中断正在运行的 turn。

### Telegram 命令

| 命令 | 用途 |
|---|---|
| `/new` | 清除当前 chat 的 thread 映射，使下一条消息新建 thread |
| `/session` | 查看当前 thread/session 信息 |
| `/model` | 查看 configured model 与当前 thread model |
| `/effort` | 查看或切换 reasoning effort |
| `/status` | 查看 bridge 与当前运行状态 |
| `/stop` | 中断正在运行的任务；当前实现对多 chat 并发还不够精确，见“仍然存在的边界” |
| `/write <任务>` | 仅给这一轮授予指定 workspace 的写权限 |
| `/log` | 查看当前 chat 的近期 gateway transcript，其中可能包含用户与 assistant 文本 |
| `/help` | 查看命令说明 |

effort 选项优先以 app-server 的 `model/list` 返回值为准。当前实现为了兼容查询失败，仍保留一份硬编码 fallback；更严格的公开版本应把 fallback 状态显示出来，避免把兼容值误报成模型已确认支持。某次已验证的模型组合支持：

```text
low · medium · high · xhigh · max · ultra
```

不同模型和不同 Codex CLI 版本不保证提供完全相同的档位；bridge 应动态展示当前模型真正支持的选项，并拒绝无效值。`/effort default` 是 bridge 自建的“清除覆盖、恢复模型默认值”语义，不是 app-server 返回的官方 effort 档位。

### 权限模型

- 普通消息：`read-only`，默认关闭网络。这里的 read-only 是“禁止写入”，不是“只允许读取 workdir”；在当前 policy 下，读取范围仍受 Unix 文件权限约束，并可能覆盖同一用户可读的整个文件系统。
- `/write` 开头的消息：只对这一轮切换到 `workspace-write`，仍默认关闭网络。`writableRoots` 限制的是写边界，不会自动收窄读取边界。
- 可写根目录由部署者预先配置；命令不能靠文字要求自行扩大根目录。
- 下一条普通消息自动回到只读，不把写权限黏在 session 上。
- bridge 启动 app-server 时，从子进程环境中剥离 `TELEGRAM_*` 和 bridge 私有变量，减少工具误读 bot token 的机会。

这是一种好用的“单轮 capability”设计，但不是完整的强隔离：如果 bridge 与 Codex 运行在同一个 Unix 用户下，Codex 仍可能按文件路径读取 bridge 的 `.env`，环境变量清理阻止不了这一点。需要真正隔离 bot token，应让 Codex 运行在无法读取 bridge secret 的不同 UID/容器中，或通过专门的 secret broker / narrow IPC 让持有 token 的进程只负责 Telegram 收发。

### 记忆与项目指令

有两种互补机制：

1. 把项目规则放在 workspace 的 `AGENTS.md`，由 Codex 按目录语义读取；这是 Codex 原生机制。
2. bridge 可在每轮注入一份额外 memory 文件，提供跨 thread 的用户偏好或长期上下文；这是自建 bridge 行为。

memory 必须和 credentials 分开：人格、偏好、项目约定可以进入 memory；bot token、API key、SSH key 和 channel 配置不应该写进 memory 或 vault。

## 推荐的项目结构

```text
codex-tg-bridge/
├── src/
│   ├── index.js          # 生命周期与消息调度
│   ├── config.js         # 环境变量解析与校验
│   ├── telegram.js       # Bot API、long polling、分泡
│   ├── codex-app.js      # app-server JSON-RPC 客户端
│   ├── state.js          # session、offset、chat 设置
│   ├── prompts.js        # Telegram 输出约束
│   └── child-env.js      # 子进程环境清理
├── test/
│   └── telegram.test.js
├── deploy/
│   └── codex-tg-bridge.service
├── .env.example
├── package.json
└── README.md
```

生产目录不要整包发给别人。备份、state 和日志常常比源码更危险，因为里面可能保留 token、chat ID、thread ID、用户名、绝对路径和对话内容。

## 脱敏配置示例

下面这些变量属于 bridge 自己的配置接口，不是 Codex 官方规定的环境变量名：

```dotenv
TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_ALLOWED_USER_IDS=<telegram-user-id>
TELEGRAM_ALLOWED_CHAT_IDS=<optional-chat-id-list>

CODEX_BIN=/absolute/path/to/codex
CODEX_RUNNER=app
CODEX_WORKDIR=/srv/codex-workspace
CODEX_ADD_DIRS=/srv/knowledge-vault
CODEX_MCP_CWD=/srv/knowledge-vault

CODEX_READONLY_SANDBOX=read-only
CODEX_WRITE_SANDBOX=workspace-write
CODEX_TIMEOUT_MS=900000

BRIDGE_STATE_DIR=/srv/codex-tg-bridge/.bridge-state
BRIDGE_MEMORY_FILE=/srv/codex-memory/user.md
```

建议把真实 `.env` 放在 vault 和 Git 仓库之外，权限设为仅 service user 可读。公开分享时只发 `.env.example`。

## systemd user service 模板

先确认服务器上真正的 Node.js 可执行文件，再把 `<verified-node-path>` 换成它的绝对路径：

```ini
[Unit]
Description=Codex Telegram Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/codex-tg-bridge
EnvironmentFile=%h/.config/codex-tg-bridge.env
ExecStart=<verified-node-path> %h/codex-tg-bridge/src/index.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=default.target
```

不要为了“可移植”就盲目写裸 `node`，也不要盲目复制别人机器上的 `/usr/bin/node`。正确做法是部署时验证实际二进制，然后将验证过的绝对路径写入 unit。

```bash
command -v node
readlink -f "$(command -v node)"
node --version
```

如果服务器同时装了 Node、Bun、nvm、asdf 或自定义 wrapper，PATH 中的 `node` 不一定真是预期的 Node.js。

## 部署与验收清单

### 1. 安装并登录 Codex

```bash
codex --version
codex login
codex app-server generate-json-schema --out /tmp/codex-app-server-schema
```

确认 service user 自己能够启动 Codex，而不是只在管理员的交互 shell 中可用。以准备部署的 Codex CLI 版本重新核对 [app-server 协议](https://developers.openai.com/codex/app-server/)，并用该版本生成的 schema 对 bridge 做 method/field contract test，不要假定旧客户端永远兼容新事件名。

### 2. 验证 Node 运行时

不要直接拿 bridge 入口文件做第一次语法检查。先用一个无副作用的 smoke file 验证 `--check` 确实只检查、不执行：

```bash
NODE_BIN="$(command -v node)"
printf 'const runtimeProbe = 1;\n' > /tmp/node-check-probe.js
"$NODE_BIN" --check /tmp/node-check-probe.js
```

确认无误后，才对 bridge 源文件运行 syntax check 和测试。

### 3. 确认 Telegram 没有 webhook

long polling 与 webhook 不能同时作为同一 bot 的更新入口。下面的写法通过 stdin 传 curl 配置，避免展开后的 token 出现在 curl 的进程参数里：

```bash
printf 'url = "https://api.telegram.org/bot%s/getWebhookInfo"\nsilent\nshow-error\n' \
  "$TELEGRAM_BOT_TOKEN" | curl --config -
```

返回中的 `url` 应为空。若不为空，先确认没有其他生产系统依赖该 webhook，再调用 `deleteWebhook`。

### 4. 保证一个 token 只有一个 poller

同一 bot token 同时只能有一个活跃的 `getUpdates` long poller。部署前停止旧 tmux、旧 systemd unit、手工测试进程和残留进程。出现下面的错误时，第一嫌疑就是第二个 poller：

```text
409 Conflict: terminated by other getUpdates request
```

不要用反复重启掩盖它；先找到竞争者。生产上最好使用 systemd 管理唯一的正式 unit，并避免从入口文件做会执行顶层代码的“检查”。systemd 只能约束它管理的 unit，不能阻止另一个 unit、tmux 或手工命令再启动一个 poller。

### 5. 本地检查后再启动服务

```bash
"$NODE_BIN" --check src/index.js
"$NODE_BIN" --test

systemctl --user daemon-reload
systemctl --user enable --now codex-tg-bridge.service
systemctl --user status codex-tg-bridge.service
journalctl --user -u codex-tg-bridge.service -n 100 --no-pager
```

如果项目使用自定义测试脚本，以 `package.json` 为准。启动后检查进程树，确认只有一个 bridge 和一个由它管理的 app-server。

### 6. Telegram 端到端验收

至少测试：

- `/status` 能返回当前运行状态。
- `/model` 能看到 configured model 与当前 thread model。
- `/effort` 能显示当前模型支持的档位，并在切换后保持。
- 普通消息可以读取预期工作目录，但不能写文件；如果要求读隔离，还必须另外验证 Codex 无法读取同 UID 的敏感路径，不能把 read-only 当成 read allowlist。
- `/write` 可以在允许根内完成一次写入；下一轮自动恢复只读。
- `/stop` 能中断长任务。
- service 重启后 thread、effort 与 Telegram offset 仍在。
- Markdown、代码块、emoji 和长回复都能正确分泡。
- 日志中没有新的 `409 Conflict`、反复重启或未处理的 approval event。

## Telegram 的“自然分泡”怎么做

Telegram 单条文本有长度上限，但单纯每 4096 字硬切会非常不像聊天，也容易切坏 Markdown。参考实现采用两层策略：

1. 把代码围栏之外的空行视为自然气泡边界。
2. 日常短回复优先合并成 1–3 个气泡；遇到超长文本或大代码块时，允许超过三泡，以正确性优先。

分泡器还需要处理：

- fenced code block 不在中间失去开闭标记；必要时每个片段都单独闭合并重开。
- Telegram 4096 字符硬上限。
- Markdown 标题、段落与 fenced code；列表目前按普通文本处理，仍需补专项测试。
- CRLF 与多余空白行。
- emoji surrogate pair，避免切出乱码。

这部分目前有 15 项自动化测试，覆盖普通段落、代码围栏、长文本、标题、CRLF 和 emoji。当前 `sendMessage` 没有设置 Telegram `parse_mode`；所谓 Markdown-structure-aware 是为了识别并安全保留结构，不代表 Telegram 会把文本渲染成 Markdown。测试数量不是质量证明本身，但能防止“改了聊天观感却弄坏代码块”的回归。

## 今早两个值得记住的真实故障

### 故障 A：`node` 实际是 Bun，检查命令启动了第二个 bridge

一台服务器的 PATH 中，`node` 最终指向了 Bun wrapper。Bun 对 `node --check entry.js` 的行为不同，结果不是只检查语法，而是执行了入口文件。入口文件一执行，就启动了第二个 Telegram poller：

```text
误执行入口
  → 第二个 bridge 启动
  → 两个进程共用一个 bot token
  → 正式服务连续出现 409 Conflict
```

修复原则：

- 检查 `command -v`、真实链接和版本，不要只相信命令名。
- 用无副作用 probe 验证 runtime flags。
- service 固定到已验证的绝对路径。
- 任何可能执行 bridge 入口的命令，都先考虑“会不会产生第二个 poller”。

### 故障 B：AppArmor 的 user namespace 限制阻止了 Codex bubblewrap sandbox

症状是连 `pwd` 之类的只读命令都在 shell 启动前失败，并出现类似：

```text
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

最终根因不是 workspace 权限，而是主机启用了对 unprivileged user namespace 的 AppArmor 限制，bubblewrap 无法建立所需的 user/network namespace。

遇到同类问题时先诊断：

```bash
sysctl kernel.apparmor_restrict_unprivileged_userns
```

把该值在整台主机上改为 `0` 可以恢复功能，但会放宽全局 user namespace 安全策略，不应当作为不加判断的通用答案。单用户 VPS 可以在理解 trade-off 后采用；多租户或高安全环境优先考虑 scoped AppArmor policy/profile，或正确配置了 user namespace/capability 的容器，并在修复后验证网络 namespace 隔离仍然存在。专用 service user 有助于秘密隔离，但它本身不会绕过这项 AppArmor 限制。

共同教训很简单：报错发生在哪一层，不代表根因就在哪一层。先确认实际执行的是哪个二进制、哪个进程、哪个 token、哪个 sandbox，再改配置。

## 仍然存在的边界

截至 2026-07-10，这套参考实现的已验证基线是 Linux + systemd、Codex CLI 0.144.1、Node.js 18.19.1。版本数字只是一次可复现基线，不是永远固定的依赖声明。

当前限制：

- 支持 text 与 caption 中的文字；caption 所属的图片或文件本身不会上传或解析，语音也未接通。
- Telegram 只显示最终答案，没有流式展示 tool progress。
- 当前 reference implementation 的 approval adapter 仍只处理 legacy method，尚未适配当前的 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 与 `item/permissions/requestApproval`。因此 Telegram 的交互式 Allow/Deny 尚未真正接通；预配置 sandbox 内的 `/write` 正常，越出可写根的请求会 fail closed。升级 handler 前不应声称支持交互式越权放行。
- 当前 `/stop` 会遍历并 interrupt app-server 中所有 active turns，而不是只精确停止发命令 chat 的 turn；单 chat 使用无感，多 chat 并发时可能误停其他任务。
- 当前实现先持久化 Telegram offset，再异步处理和入队；per-chat queue 也只在内存中。服务若在 offset 提交后、任务完成前崩溃，该 update 不会重放，排队消息也可能丢失，语义更接近 at-most-once。`sessions.json` 与 offset 文件目前也不是全部用 temp + rename 原子写。公开版应采用 durable inbox，或在成功处理后提交 offset，并配套失败重试、幂等和 state 原子写入。
- 同一 Unix 用户不是秘密隔离边界。
- 多 agent 同时写同一个 vault 时，需要文件级协调或乐观锁。
- chat log 需要轮转、保留期与敏感信息处理策略。
- “优先最多三泡”是聊天体验目标，不是长代码和超长消息的绝对保证。
- app-server 是持续演进的集成接口，每次升级 Codex CLI 都应跑协议与端到端回归测试。

## 给另一个 AI 的实现规格

如果把这一段交给 coding agent，可以直接要求它按下面的验收条件实现：

```text
请实现一个 dependency-light 的 Telegram ↔ Codex bridge：

1. Telegram 使用 getUpdates long polling，不开放公网入站端口。
2. Codex 使用一个常驻 codex app-server 子进程，通过 stdio JSON-RPC 通信。
3. 每个 Telegram chat 映射到独立 Codex thread；thread ID、update offset 与
   effort 设置必须原子持久化并可跨服务重启恢复。model 先使用全局配置；
   如果扩展为 per-chat model，必须明确标成新增能力并单独持久化。
4. 同一 chat 的 turn 严格串行；支持超时和 interrupt。
5. allowlist 在消息进入 Codex 前执行。
6. 普通 turn 为 read-only；只有 /write 开头的一轮可 workspace-write，
   且只允许预配置 writable roots，下一轮自动恢复只读。明确记录：这只限制写，
   不构成 read allowlist。
7. 子进程环境移除 Telegram token 和 bridge 私有变量；这只是 defense in depth。
   若要隔离 token，Codex 进程必须在文件权限层也无法读取 bridge secret。
8. model 能力与 effort 档位从 app-server 动态查询；每轮显式传入 configured
   model 与当前 chat 的 effort。
9. 实现 /new /session /model /effort /status /stop /write /log /help；/model
   默认只读展示，/effort 支持按 chat 切换。
10. 处理当前 app-server approval methods，并做协议 contract test；未知或越权审批默认拒绝。
11. 最终回答按 Telegram 上限与 Markdown/代码围栏安全分泡；短回复优先 1–3 泡。
12. 为 offset 恢复、处理途中 crash、重复 update、幂等、stale thread、409、
    timeout、按 chat 精确 stop、代码块、列表、emoji、CRLF、超长文本与
    service restart 编写测试。
13. 提供 .env.example、systemd user unit、部署前 runtime identity 检查、
    单 poller 检查、回滚说明和秘密清单。回滚包应带完整文件 manifest，
    并在回滚后重新验证 runtime identity，避免恢复会命中错误 node 的旧脚本。
14. 不在源码、仓库、日志样例或 memory 中写入任何真实 token、ID 或私人路径。
```

## 对外分享前的最后检查

只分享这些：

- 架构说明、脱敏源码、测试、`.env.example`、systemd 模板。
- 已知限制、兼容版本、部署与回滚说明。

不要分享这些：

- `.env`、bot token、chat/user ID。
- `.bridge-state`、thread/session ID、Telegram offset。
- chat log、journal、memory、`AGENTS.md` 中的私人内容。
- 生产备份 tar、服务日志、真实主机名/IP/用户名/绝对路径。
- 整个生产目录的压缩包。

发布前至少跑一次：秘密模式扫描、私人关键词扫描、绝对路径扫描和 Git 历史扫描。只删当前文件里的 token 不够；token 如果曾经进过 Git 历史，应立即轮换。

## 参考资料

- [OpenAI Codex app-server](https://developers.openai.com/codex/app-server/)
- [OpenAI Codex CLI repository](https://github.com/openai/codex)
- [Telegram Bot API：getUpdates](https://core.telegram.org/bots/api#getupdates)
- [Telegram Bot API：getWebhookInfo](https://core.telegram.org/bots/api#getwebhookinfo)
