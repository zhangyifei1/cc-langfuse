# cc-langfuse

Claude Code -> Langfuse 探针。一键安装，自动把 Claude Code 会话数据（token 用量、调用时序、工具调用、git 分支等）推送到 Langfuse 可观测平台。

## 文档

- **[使用说明（USAGE.md）](./USAGE.md)** -- 安装与使用指南
- **[部署文档（DEPLOY.md）](./DEPLOY.md)** -- 部署、发布、配置、运维指南

## 快速开始

```bash
npm i -g cc-langfuse
cc-langfuse install
```

完成。下次 Claude Code 会话结束时，数据自动上送到 Langfuse。

> 首次使用前，请在 `config/default.json`（或安装后通过环境变量 `CC_LANGFUSE_*`）填入你自己的 Langfuse 公钥/私钥/地址。

## 特性

- **一键安装**：自动配好 Stop hook，配置随 npm 包分发
- **零依赖**：仅用 Node 内置模块（装了 Claude Code 就有 Node）
- **准确归并**：按 `message.id` 归并同一次 LLM 调用，token 不重复计算
- **真实时序**：还原每次调用的真实起止时间与耗时
- **用户追踪**：自动按系统账号聚合（Users 视图）
- **git 分支**：自动记录会话所在 git 分支，便于按分支筛选

## 安装

```bash
npm i -g cc-langfuse
cc-langfuse install
```

完成。下次 Claude Code 会话结束时，数据自动上送到 Langfuse。

## 升级

发布新版后：

```bash
npm update -g cc-langfuse
cc-langfuse install
```

> 无 npm registry 的内网/离线环境，可用本地打包 `.tgz` 分发，见[部署文档 - 本地打包分发](./DEPLOY.md#34-本地打包分发无需-npm-registry)。完整发布流程见[部署文档 - 升级流程](./DEPLOY.md#七升级流程)。

## 命令

| 命令 | 说明 |
|---|---|
| `cc-langfuse install` | 安装探针（默认） |
| `cc-langfuse uninstall` | 卸载探针 |
| `cc-langfuse status` | 查看安装状态 |
| `cc-langfuse help` | 帮助 |

## 自定义用户标识

默认用系统账号名（如 Windows 的 USERNAME）作为 Langfuse user_id。如需自定义，在 `~/.claude/settings.json` 的 `env` 中添加：

```json
"CC_LANGFUSE_USER_ID": "your-name"
```

## 数据上送内容

每个用户指令生成一条 Trace，包含：

- **Generation**：每次真实 LLM 调用（token 用量、缓存命中、起止时间、stop_reason）
- **Thinking**：模型思考过程（子 span）
- **Tool**：工具调用及结果
- **metadata**：git 分支、session_id、transcript 路径、合并行数等
- **tags**：`claude-code` + `git:<分支>`

## 配置优先级

hook 运行时配置读取优先级（高到低）：

1. 环境变量 `CC_LANGFUSE_*` / `LANGFUSE_*`（自定义用）
2. 包内 `config/default.json`（默认配置，install 时写入 settings.json env）

> 首次使用需填入 Langfuse 公钥/私钥/地址；配置字段、轮换与覆盖行为详见[部署文档 - 配置说明](./DEPLOY.md#四配置说明)。

## License

MIT
