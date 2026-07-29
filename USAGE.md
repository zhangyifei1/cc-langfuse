# cc-langfuse 使用说明

> Claude Code 会话数据（token 用量、调用时序、工具调用、git 分支等）自动推送到 Langfuse 可观测平台。

---

## 一、这是什么

本探针会自动采集你使用 Claude Code 时的会话数据，推送到 Langfuse 可观测平台，用于：

- **Agent 可观测**：查看每次 LLM 调用的 token 用量、耗时、思考过程、工具调用
- **用户管理**：按用户聚合统计使用情况
- **操作审计**：记录操作内容（命令、文件读写、工具输出），供追溯

**安装后无需额外配置 hook**，Langfuse 连接信息随包分发，但需你填入自己的 Langfuse 公钥/私钥/地址（见下文）。

---

## 二、前置条件

- 已安装 **Claude Code**（自带 Node 运行时，无需单独装 Node）
- 有一个可访问的 Langfuse 实例（自建或 Langfuse Cloud），并拿到该项目的 Public Key / Secret Key

---

## 三、安装

### 标准安装（推荐）

```bash
npm i -g cc-langfuse
cc-langfuse install
```

两条命令执行完即完成。无需手动配 hook。

### 填入你自己的 Langfuse 配置

默认 `config/default.json` 中是占位符。请二选一填入真实配置：

**方式A：改包内配置**（适合全局统一）
编辑 `config/default.json`，把 `publicKey` / `secretKey` / `baseUrl` 改成你的 Langfuse 项目值，重新 `cc-langfuse install`。

**方式B：用环境变量覆盖**（适合个人自定义，不发包）
编辑 `~/.claude/settings.json`，在 `env` 中添加：

```json
"env": {
  "CC_LANGFUSE_PUBLIC_KEY": "pk-lf-xxxx",
  "CC_LANGFUSE_SECRET_KEY": "sk-lf-xxxx",
  "CC_LANGFUSE_BASE_URL": "https://your-langfuse-host"
}
```

### 离线安装（无私服访问时）

向发布者索取 `cc-langfuse-x.x.x.tgz` 文件（打包方式见[部署文档](./DEPLOY.md)），然后：

```bash
npm i -g /path/to/cc-langfuse-x.x.x.tgz
cc-langfuse install
```

---

## 四、验证安装

```bash
cc-langfuse status
```

看到如下输出即成功：

```
[cc-langfuse] 探针文件: 已安装
[cc-langfuse] settings.json Stop hook: 已配置
[cc-langfuse] Langfuse env 配置: 已配置
[cc-langfuse] Langfuse 地址: https://your-langfuse-host
[cc-langfuse] 状态: ✓ 就绪，会自动上送
```

之后，**每次 Claude Code 会话结束（Stop 事件）时**，数据会自动上送。正常使用 Claude Code 即可，无需任何额外操作。

---

## 五、命令一览

| 命令 | 作用 |
|---|---|
| `cc-langfuse install` | 安装探针（默认命令，可省略 `install`） |
| `cc-langfuse status` | 查看安装状态 |
| `cc-langfuse uninstall` | 卸载探针（移除 hook 和配置，保留历史数据） |
| `cc-langfuse help` | 查看帮助 |

---

## 六、升级

发布新版后：

```bash
npm update -g cc-langfuse
cc-langfuse install
```

配置（Langfuse 地址、key 等）随包更新，无需手动改（前提是包内配置已填好）。

---

## 七、自定义用户标识

默认用**系统账号名**（Windows 的 `USERNAME`）作为 Langfuse 的用户标识。如需改成更易识别的名称，编辑 `~/.claude/settings.json`，在 `env` 中添加：

```json
"env": {
  "CC_LANGFUSE_USER_ID": "your-name"
}
```

> ⚠️ 注意：重新执行 `cc-langfuse install` 时，包内默认配置会覆盖回 settings.json 中它负责写入的项（key/地址等）。若你用方式B自定义了 `CC_LANGFUSE_*`，重装后会被覆盖（仅 `CC_LANGFUSE_USER_ID` 这类 install 不写入的项不受影响）。详见[部署文档 - 配置优先级](./DEPLOY.md#七配置优先级)。

---

## 八、查看数据

安装并正常使用 Claude Code 后，前往 Langfuse 平台查看：

- **Traces 视图**：查看每次会话的完整调用链（Generation / Thinking / Tool）
- **Users 视图**：按用户聚合查看 token 用量、trace 数
- **按标签筛选**：`git:<分支>`（按 git 分支）、`sidechain`（子 agent 会话）

---

## 九、采集了哪些数据

每次用户指令生成一条 Trace，包含：

### Trace 级（会话元信息）

| 字段 | 说明 |
|---|---|
| `userId` | 用户标识（默认系统账号名） |
| `sessionId` | Claude Code 会话 ID |
| `tags` | `claude-code` + `git:<分支>` + `sidechain`（子 agent 时） |
| `metadata.cwd` | 工作目录（定位在哪个项目操作） |
| `metadata.git_branch` | git 分支名（非 git 目录为 `HEAD`） |
| `metadata.claude_version` | Claude Code 版本 |
| `metadata.entrypoint` | 调用入口（cli / sdk） |
| `metadata.user_type` | 用户类型 |
| `metadata.is_sidechain` | 是否子 agent 会话 |
| `metadata.probe_version` | 探针版本号 |
| `metadata.git_name` / `git_email` | git 配置的用户名/邮箱（git 仓库时） |
| `metadata.computer` | 机器名 |
| `metadata.trace_total_usage` | **本指令级用量汇总**（见下表） |
| `input` / `output` | 用户输入 / 最终回复 |

#### trace_total_usage 字段（指令级汇总，便于用量监控）

| 字段 | 说明 |
|---|---|
| `input_tokens` / `output_tokens` / `total_tokens` | 本指令累计 token |
| `cache_read_tokens` | 缓存读取 token |
| `web_search_requests` / `web_fetch_requests` | 服务端外部搜索/抓取次数 |
| `tool_call_count` / `tool_error_count` | 工具调用数 / 失败数 |
| `llm_call_count` | LLM 调用轮数 |

> 注：成本（cost）字段已移除，计费标准待明确，暂不上送。Langfuse 里不显示成本，仅上送 token 用量。

### Generation 级（每次真实 LLM 调用）

| 字段 | 说明 |
|---|---|
| `model` | 模型名 |
| `startTime` / `endTime` | 真实起止时间 |
| `completionStartTime` | 模型开始生成时间 |
| `usageDetails` | token 用量（input/output/cacheReads/cacheCreation） |
| `metadata.stop_reason` | 停止原因（end_turn / tool_use 等） |
| `metadata.message_id` | LLM 调用 ID（归并键） |
| `metadata.merged_line_count` | 合并的 transcript 行数 |
| `metadata.service_tier` / `speed` | 服务等级 / 速度等级 |
| `metadata.inference_geo` | 推理地域（合规审查） |
| `metadata.web_search_requests` / `web_fetch_requests` | 服务端外部搜索/抓取次数 |
| `metadata.cache_write_5m` / `cache_write_1h` | 5分钟/1小时缓存写入 token |

### Tool 级（工具调用）

| 字段 | 说明 |
|---|---|
| `name` | `Tool: <工具名>`（Bash / Edit / Read 等） |
| `input` | 工具输入（如 Bash 命令、Edit 的文件内容） |
| `output` | 工具输出（结果） |
| `metadata.tool_name` | 工具名 |
| `metadata.is_error` | 工具是否报错 |
| `metadata.tool_duration_ms` | **工具纯执行耗时（毫秒）**，扣除模型思考时间 |
| `level` | 报错时为 `WARNING`（UI 标黄） |

### Thinking 级

模型思考过程，作为 Generation 的子 span 记录，不占用 token 统计。

---

## 十、数据量说明

- 工具输入/输出内容截断到 **20000 字符**（超长保留前 20000 字 + sha256 摘要）
- 数据**原样上送**，不做内容检测或脱敏。所有 Bash 命令、文件内容、工具输出完整保留在 Langfuse，可检索。
- 增量上送：已上送的内容不会重复上送（基于 transcript 文件 offset 去重）。

---

## 十一、常见问题

### Q1：`cc-langfuse` 命令找不到？

全局 npm bin 目录未加入 PATH。可：
- 重开终端
- 或直接用 `node $(npm root -g)/cc-langfuse/src/install.js install`

### Q2：装完后 Claude Code 没数据上送？

1. 运行 `cc-langfuse status` 确认状态为"就绪"
2. 确认 Langfuse 地址可访问
3. 查看日志：`~/.claude/state/langfuse_hook.log`
4. 确认本机时间正常（时间戳取自 transcript）

### Q3：探针会影响 Claude Code 使用吗？

不会。探针是 fail-open 设计：
- 在 Stop 事件（会话结束）时才运行，不阻塞交互
- 任何异常都静默退出，绝不影响 Claude Code 正常工作
- 上送失败也不报错，仅记日志

### Q4：卸载会删除我的历史数据吗？

不会。`uninstall` 只移除本机的探针 hook 和配置，已上送到 Langfuse 的历史数据保留。

### Q5：如何临时关闭上送？

编辑 `~/.claude/settings.json`，把 `env.TRACE_TO_LANGFUSE` 改为 `"false"`，或直接卸载：`cc-langfuse uninstall`。

---

## 十二、获取帮助

- 查看本机日志：`~/.claude/state/langfuse_hook.log`
- 完整技术文档：见[部署文档](./DEPLOY.md)
