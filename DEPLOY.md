# cc-langfuse 部署文档

> 面向**部署者**的部署、发布、配置、运维指南。普通用户的安装使用见[使用说明](./USAGE.md)。

---

## 一、架构概述

### 探针工作原理

```
Claude Code 会话结束 (Stop 事件)
        │
        ▼
触发 ~/.claude/hooks/langfuse_hook.js   ← 探针主程序
        │
        ├─ 1. 增量读取会话 transcript (~/.claude/projects/.../*.jsonl)
        ├─ 2. 按 message.id 归并同一次 LLM 调用（token 不重复计算）
        ├─ 3. 提取审计字段（用户、git分支、cwd、工具调用等）
        ├─ 4. 构造 Langfuse Ingestion 事件
        └─ 5. POST /api/public/ingestion -> Langfuse
```

### 技术要点

- **零依赖**：仅用 Node 内置模块（http/https/fs/path/crypto/os/child_process）
- **直接调 REST API**：不走 Langfuse SDK/OTel，body 直接传 `startTime`/`endTime`，时间戳准确
- **确定性 ID**：trace/observation ID 用 sha256 生成，重复上送幂等
- **fail-open**：任何异常静默退出，不阻塞 Claude Code

### 配置流转

```
包内 config/default.json（源，部署者维护）
        │  install 时
        ▼
~/.claude/settings.json 的 env（CC_LANGFUSE_* 前缀）
        │  Claude Code 运行时注入子进程
        ▼
hook 读取 env（CC_LANGFUSE_* 优先）+ 包内默认兜底
```

---

## 二、包结构

```
cc-langfuse/

}
```

> **关于成本计算**：当前版本（1.0.4）**已移除成本上送**，原因是计费标准待明确（不同供应商计价单位"每千token"vs"每百万token"不统一，易导致成本虚高）。
> `modelPricing` 字段保留在 config 中备用，待计费标准明确后在 `src/hook.js` 的 `buildTokenDetails` 恢复成本逻辑即可启用。
> Langfuse 里 `costDetails` 为空，UI 不显示成本；token 用量（`usageDetails`）仍正常上送，可用于用量监控。

### 4.2 修改配置并发布新版

当 Langfuse 地址变更、key 轮换、需调整截断长度时：

```bash
cd cc-langfuse
# 1. 编辑 config/default.json
vim config/default.json

# 2. 升版本号
npm version patch      # 1.0.1 -> 1.0.2

# 3. 发布
npm publish

# 4. 通知用户升级
```

用户执行后配置即更新：
```bash
npm update -g cc-langfuse
cc-langfuse install
```

### 4.3 配置优先级

hook 运行时配置读取优先级（高到低）：

1. **环境变量 `CC_LANGFUSE_*` / `LANGFUSE_*`**（用户自定义用）
2. **包内 `config/default.json`**（默认配置）

`install` 写入 settings.json env 时用 `CC_LANGFUSE_*` 前缀。**重要行为**：`install` 会用包内配置**覆盖**用户已有的 `CC_LANGFUSE_*` 值（包内配置优先），但会打印 conflict 提示。这意味着：
- 用户若自定义了 `CC_LANGFUSE_BASE_URL` 等项，重装后会被覆盖回包内值
- `CC_LANGFUSE_USER_ID`（用户标识）install 不写入，不会被覆盖，可放心自定义

如需让用户自定义持久保留，可改造 install 为"仅缺失时写入，加 `--force` 强制覆盖"（当前未实现）。

---

## 五、上送数据字段

详见[使用说明 - 采集了哪些数据](./USAGE.md#九采集了哪些数据)。关键字段分类：

### 审计相关（人员审查 / agent 可观测）
- `userId` / `git_name` / `git_email` / `computer`：谁、在哪台机器
- `cwd` / `git_branch`：在哪个项目、哪个分支操作
- `claude_version` / `entrypoint` / `user_type`：客户端信息
- `is_sidechain` / `probe_version`：会话类型、探针版本
- `tool_name` / `is_error` / `level`：工具调用及是否异常
- `inference_geo`：推理地域（合规审查）

### 用量监控
- `usageDetails`：token 用量（input/output/total/inputCacheReads/inputCacheCreation）
- `trace_total_usage`：指令级用量汇总（token/缓存/工具数/外发数/调用轮数）
- `service_tier` / `speed`：服务等级、速度等级
- `cache_write_5m` / `cache_write_1h`：5分钟/1小时缓存写入（缓存策略优化）

> **成本计算已移除**：当前版本不上送 `costDetails`，Langfuse 不显示成本。
> 原因是计费标准待明确（火山方舟等供应商计价单位"每千token"与"每百万token"不统一，
> 易导致成本虚高 1000 倍）。`modelPricing` 配置保留备用，待明确后在 `src/hook.js` 恢复。

### 外部数据外发追踪（敏感审查）
- `web_search_requests` / `web_fetch_requests`：服务端外部搜索/抓取次数（trace 级和 Generation 级都有）
- `tool_duration_ms`：工具纯执行耗时（监控哪个工具慢）

### 可观测相关
- `usageDetails`：token 用量（input/output/cacheReads/cacheCreation）
- `startTime` / `endTime` / `completionStartTime`：真实时序
- `stop_reason` / `merged_line_count`：调用行为

### Langfuse tags（便于筛选聚合）
- `claude-code`（固定）
- `git:<分支名>`（按 git 分支筛选）
- `sidechain`（子 agent 会话）

---

## 六、运维与监控

### 6.1 探针运行日志

用户机器：`~/.claude/state/langfuse_hook.log`

```bash
# 查看最近的运行情况
tail -20 ~/.claude/state/langfuse_hook.log
```

典型日志：
```
2026-07-24 09:06:36 [INFO] Processed 5 user task traces (failed=0) in 1.64s (session=xxx)
2026-07-24 09:06:35 [DEBUG] user_id=60472 user_meta={"computer":"PC-001",...}
```

### 6.2 状态文件

`~/.claude/state/langfuse_state.json`：记录每个 session 的 transcript 读取 offset，用于增量去重。

**排查重复/漏送问题时**：可删除该文件中对应 session 的 key，强制重新读取（会因确定性 ID 幂等，不会产生重复 trace）。

### 6.3 Langfuse 端验证

```bash
# 查询某用户最近的 trace
curl -u "<publicKey>:<secretKey>" \
  "https://your-langfuse-host/api/public/traces?limit=5&userId=<用户标识>"
```

### 6.4 探针覆盖率排查

若某用户未上送数据，按序排查：
1. `cc-langfuse status` 是否就绪
2. `~/.claude/settings.json` 的 `env` 是否有 `CC_LANGFUSE_*`
3. `~/.claude/hooks/langfuse_hook.js` 是否存在
4. `langfuse_hook.log` 有无错误
5. 该用户能否访问 Langfuse 地址

---

## 七、升级流程

### 7.1 探针版本升级（改代码）

```bash
cd cc-langfuse
# 改 src/ 下代码
npm version patch    # 或 minor / major
npm publish
# 通知用户：npm update -g cc-langfuse && cc-langfuse install
```

### 7.2 仅改配置（不改代码）

同上，但只改 `config/default.json`。版本号仍需升（否则 npm 不会接受同名同版本发布）。

### 7.3 回滚

```bash
npm publish           # 发布旧版本号（需高于当前 latest，或用 npm dist-tag）
# 用户：npm i -g cc-langfuse@<旧版本> && cc-langfuse install
```

---

## 八、卸载

### 单台机器卸载

```bash
cc-langfuse uninstall
npm uninstall -g cc-langfuse
```

卸载会：
- 移除 `~/.claude/settings.json` 中的探针 hook 和 env 配置
- 删除 `~/.claude/hooks/langfuse_hook.js` 等探针文件
- 保留 `.bak` 备份和 state 数据
- **不删除**已上送到 Langfuse 的历史数据

---

## 九、安全说明

### 9.1 上送内容

探针**原样上送**工具输入输出，包括：
- Bash 命令全文
- Read / Write / Edit 的文件内容
- 工具执行结果

截断到 20000 字符，超长部分保留 sha256 摘要。**不做内容检测或脱敏**。

### 9.2 凭证安全

- Langfuse key 存放在 `config/default.json`（源）和用户 `settings.json`（env）
- `.npmrc` 含私服凭证，勿提交 git
- 若把 key 写进 npm 包公开发布，等同于公开。如需限制访问，应在 Langfuse 端按项目/环境隔离 key，或让用户各自填 env 而不写入包内配置

### 9.3 敏感信息审查

审查员可在 Langfuse 按以下维度检索：
- `tool_name = Bash`：查看所有命令执行
- `is_error = true` / `level = WARNING`：查看失败操作
- `git:<分支>` tag：按分支筛选
- `userId`：按人员审查

如需探针端自动检测敏感模式（密钥/危险命令）并打标，可在 `src/hook.js` 的 Tool 事件构造处扩展，当前未实现。

---

## 十、常见问题排查

### Q1：npm publish 报 403

- 检查是否已登录（`npm whoami`）
- 确认账号有发布权限
- 确认版本号已升级（同名同版本不允许覆盖发布）
- 若发私服，检查 `.npmrc` 认证配置

### Q2：用户 `npm i -g` 报找不到包

- 确认已 `npm publish`
- 确认用户的 registry 指向正确：`npm config get registry`
- 若用私服，确认用户能访问私服地址

### Q3：用户装了但没数据

见 [6.4 探针覆盖率排查](#64-探针覆盖率排查)。

### Q4：Langfuse 里 trace 时间戳不对

探针从 transcript 读取真实时间戳。若用户机器时间异常，时间戳会异常。检查用户机器系统时间。

### Q5：`probe_version` 显示 unknown

用户未执行最新版 `install`（旧版 install 不写 `CC_LANGFUSE_PROBE_VERSION` env）。让用户升级包并重新 `cc-langfuse install`。

---

## 十一、版本记录

| 版本 | 主要变更 |
|---|---|
| 1.0.0 | 初始版本：归并、真实时间戳、usage、user_id |
| 1.0.1 | 加 git 分支、npm 私服支持、审计字段（cwd/version/is_sidechain 等）、probe_version |
| 1.0.2 | 加成本计算（costDetails + MODEL_PRICING）、服务端工具调用追踪（web_search/fetch）、service_tier/speed/inference_geo、缓存写入明细（5m/1h）、tool_duration_ms、trace_total_usage 指令级汇总 |
| 1.0.3 | 模型计价表外置到 config；加 cost_currency=CNY 标注（提醒 Langfuse UI 按美元显示的误解）；文档补充成本计算口径说明 |
| 1.0.4 | **移除成本计算**（计费标准待明确，避免成本虚高误导）。costDetails 不再上送，Langfuse 不显示成本。token 用量(usageDetails)仍上送。modelPricing 配置保留备用 |

---

## 附录：npm 私服发布（可选）

如需发布到内部 npm 私服（Nexus / Verdaccio / cnpm 等），参考 `.npmrc.example`：

```ini
registry=http://<私服地址>/repository/npm-hosted/
# 认证（二选一）：
#   npm adduser --registry=http://<私服地址>/repository/npm-hosted/
# 或直接写 _auth（base64 of username:password）
_auth=<BASE64_CREDENTIALS>
email=you@example.com
always-auth=true
```

用户安装时，私服地址需在全局/项目 .npmrc 配置为 registry，或直接：
```bash
npm i -g cc-langfuse --registry=http://<私服地址>/repository/npm-group/
```

---

## 附录：相关文件路径

| 路径 | 说明 |
|---|---|
| `~/.claude/hooks/langfuse_hook.js` | 探针主程序（用户机器） |
| `~/.claude/hooks/langfuse_config_loader.js` | 配置加载器 |
| `~/.claude/hooks/langfuse_config_default.json` | 配置副本 |
| `~/.claude/settings.json` | hook 注册 + env 配置 |
| `~/.claude/state/langfuse_hook.log` | 运行日志 |
| `~/.claude/state/langfuse_state.json` | 增量读取 offset 状态 |
| `~/.claude/projects/<项目>/<sessionId>.jsonl` | Claude Code 会话原始记录 |
