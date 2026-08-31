# Codex × 飞书个人网关：安装与使用

Comers 是个人 Codex 移动端入口。Codex profile 默认保持常驻 App Server 连接，飞书侧操作的就是桌面端/CLI 使用的真实 task。

| 使用位置 | 命令 | 固定收件位置 |
|---|---|---|
| 飞书触发的 Codex 会话 | `lark-channel-artifact <文件>` | 触发当前 run 的飞书消息/话题 |
| Codex 桌面或普通 CLI 会话 | `lark-channel-send <文件>` | 所选 PersonalAgent 应用的 owner（你本人） |
| Codex 桌面或普通 CLI 会话 | `lark-channel-handoff` | 给 owner 发送当前 task 的飞书接管卡片 |

同时支持：已有任务列表和详情、置顶/归档、实时工具事件、审批卡片、运行中 steer/interrupt、语音输入、持久化定时任务、崩溃恢复与完成通知。

## 1. 安装

要求：Node.js 20.12+、`pnpm`、已登录的 `codex`、可用的 `lark-cli`。

在本目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build
npm install -g .
```

检查：

```bash
codex login status
lark-cli --version
comers --help
lark-channel-artifact --help
lark-channel-send --help
lark-channel-handoff --help
lark-channel-send --profile codex --check
lark-channel-handoff --profile codex --check
```

## 2. 首次启动并创建个人 bot

把 `/你的/项目目录` 换成只允许 Codex 工作的目录：

```bash
comers start \
  --profile codex \
  --agent codex \
  --workspace /你的/项目目录
```

首次启动会显示扫码向导。用飞书扫码创建并绑定 PersonalAgent，完成后执行：

```bash
comers status --profile codex
```

然后私聊新 bot，发送 `/status`。能看到 `agent: codex`、正确工作目录和可用状态后，再开始使用。

## 3. 会话管理

- 私聊和普通群各自维护独立会话。
- 话题群按每个 topic 独立维护会话。
- `/new`：新建会话。
- `/resume`：列出本机 Codex 桌面端/CLI 已有任务（跨项目），点选后自动切到任务原工作目录并继续。
- `/resume 20`：每页显示 20 条任务；卡片底部“下一页”继续翻页。`/resume search <标题关键词>`：按 Codex 任务标题搜索。
- `/task`：查看当前任务路径、状态和最近 turn。
- `/pin on|off`：置顶或取消置顶当前任务。
- `/archive`：二次确认后归档当前任务。
- `/handoff <thread-id>`：接管指定桌面端/CLI 任务。
- `/cd <路径>`：切换工作目录并重置当前会话。

任务列表来自 Codex 官方 app-server 的 `thread/list`，不是 bridge 自己维护的一小份会话清单。为避免把本机历史暴露到群里，任务标题和路径只允许在私聊中展示；Home 根目录、系统目录、已删除目录等不安全工作目录会显示为不可继续。
- `/ws save <名称>`、`/ws use <名称>`：保存和切换常用工作区。

## 4. 运行控制与审批

- `/steer <内容>` 会调用 Codex 原生 `turn/steer`，把新要求加进当前 turn，不会重开一次任务。
- `/stop` 会调用原生 `turn/interrupt`。
- 命令执行、文件修改、额外权限、Codex 选项题和 MCP elicitation 会显示为飞书审批卡片。
- 常用选项直接点按钮；自由文本问题用 `/answer <请求ID> <回答>`。
- 发语音消息时，bridge 下载音频并作为 `localAudio` 交给 Codex App Server。

## 5. 从飞书让 Codex 回传产物

直接对 bot 说：

> 生成 `./outputs/report.pdf`，完成后用 `lark-channel-artifact ./outputs/report.pdf` 发给我。

bridge 会把本轮消息 ID 注入 Codex 子进程。命令只接受当前工作目录内的相对文件路径，并用 bot 身份回复触发消息；话题群会留在原话题。

## 6. 从 Codex 桌面/CLI 主动发到飞书

在 Codex 中说：

> 完成后运行 `lark-channel-send --profile codex ./outputs/report.pdf`，把文件发到我的飞书。

这个命令会使用 `codex` profile 的 PersonalAgent 配置，调用“获取应用信息”接口解析应用 owner，再通过 bot 私信 owner。它不接受任意收件人参数。

要在手机继续当前桌面 task，在 Codex 中运行：

```bash
lark-channel-handoff --profile codex
```

命令默认读取当前 Codex task 环境里的 thread id，并只向应用 owner 发送接管卡片。点“在飞书继续”后，当前私聊会切到原 task 和原工作目录。

## 7. 定时任务和恢复

```text
/cron add in 10m 检查当前项目测试结果并汇报
/cron add every 2h 检查服务健康状态
/cron add daily 09:30 汇总今天待办
/cron add cron 0 9 * * 1-5 生成工作日晨报
/cron list
/cron pause|resume|run|history|remove <id>
```

定时任务和最近执行记录保存在 profile 的 `scheduled-jobs.json`，到点后先形成持久化 run，再发开始提示并沿用普通 Codex 执行链路，最终结果主动回到创建任务的私聊。同一任务有未完成 run 时不会重复派发；重启时会和 `message-ledger.json` 对账恢复，孤立派发会记录失败并进行有上限的退避重试。五段 cron 支持数字、`*`、列表、范围和步长。正常 WebSocket 重投会被去重，进程硬退出留下的未完成消息会在重连后恢复。

## 8. 个人使用的权限建议

上游新 profile 默认权限是 `full`，对应 Codex 的 `danger-full-access`。个人长期运行建议把 profile 中的权限收紧到：

```json
{
  "permissions": {
    "defaultAccess": "workspace",
    "maxAccess": "workspace"
  }
}
```

修改的是 `~/.lark-channel/config.json` 中 `profiles.codex.permissions` 这一段，不要整段覆盖文件；修改后重启：

```bash
comers restart --profile codex
```

`workspace` 对应 Codex `workspace-write`，适合改代码和生成产物；如果只需要问答和读代码，可改为 `read-only`。

## 9. 信任边界

- bot 默认仅应用 owner 可用；不要把个人 bot 随意开放给群成员。
- 两个文件回传命令都限制文件必须位于当前工作目录，拒绝绝对路径和 `..` 越界路径。
- `lark-channel-artifact` 是默认的路由绑定发送入口，`lark-channel-send` 固定发给应用 owner。
- 这不是独立容器级隔离。若给 Codex `full` 权限，它仍拥有本机 shell 和底层 `lark-cli` 的能力；需要强边界时应使用 `workspace`/`read-only`，并把 bot 运行在单独系统账号或容器中。

## 10. 最小验收清单

1. 飞书私聊 bot 发送“回复 `pong`”，收到 Codex 回复。
2. 发送 `/resume`，能看到 Codex 桌面端已有任务；选择一个其他项目的任务后，`/status` 能看到对应标题和原工作目录。
3. 让 bot 生成一个小文本文件并调用 `lark-channel-artifact`，附件回复在同一条消息下。
4. 在本机项目目录运行 `lark-channel-send --profile codex ./某个测试文件`，附件由同一个 PersonalAgent bot 私信给 owner。
5. `/status` 显示工作目录和权限符合预期。
6. 发一条语音，Codex 能理解内容；运行中发送 `/steer 补充……`，当前卡片继续而不是另起 task。
7. 触发一次需要审批的命令，卡片按钮能批准或拒绝；`/stop` 能中断当前 turn。
8. 创建 `/cron add in 1m 回复 scheduled-ok`，一分钟后收到主动回复，再删除测试任务。
