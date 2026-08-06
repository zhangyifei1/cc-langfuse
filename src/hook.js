#!/usr/bin/env node
/**
 * Claude Code -> Langfuse hook【Node.js 零依赖版】
 *
 * 用途：在 Claude Code 的 Stop 事件触发时，增量读取会话 transcript，
 * 按 message.id 归并同一次 LLM 调用（thinking/text/tool_use 共享 id+usage），
 * 还原真实时间戳与 token 用量，经 Langfuse Ingestion REST API 上送。
 *
 * 设计要点：
 * - 零 npm 依赖，仅用 Node 内置模块（装了 Claude Code 就有 Node，无需另装运行时）
 * - 直接调 /api/public/ingestion，body 传 startTime/endTime/completionStartTime，
 *   绕过 OTel span start_time 固化问题（Python SDK 版需 hack _start_time）
 * - 确定性 ID（sha256），重复上送幂等
 * - fail-open：任何异常静默退出，绝不阻塞 Claude Code
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { execSync } = require("child_process");

// --- 配置加载：包内默认（config/default.json）<- 环境变量覆盖 ---
// install.js 会把包内默认写入 settings.json 的 env（CC_LANGFUSE_*），hook 运行时
// Claude Code 注入 env，故 env 优先；包内默认作为兜底（开发/直接运行时）。
let loadConfig;
try {
  ({ loadConfig } = require("./config-loader"));
} catch (_) {
  // config-loader 不可用时退化为纯 env 读取
  loadConfig = () => ({
    traceToLangfuse: process.env.TRACE_TO_LANGFUSE || "false",
    publicKey: process.env.CC_LANGFUSE_PUBLIC_KEY || process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.CC_LANGFUSE_SECRET_KEY || process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.CC_LANGFUSE_BASE_URL || process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com",
    debug: (process.env.CC_LANGFUSE_DEBUG || "false").toLowerCase() === "true",
    maxChars: parseInt(process.env.CC_LANGFUSE_MAX_CHARS || "20000", 10),
    userIdOverride: process.env.CC_LANGFUSE_USER_ID,
    pkgDefaults: {},
  });
}

// --- 路径 ---
const STATE_DIR = path.join(os.homedir(), ".claude", "state");
const LOG_FILE = path.join(STATE_DIR, "langfuse_hook.log");
const STATE_FILE = path.join(STATE_DIR, "langfuse_state.json");
const LOCK_FILE = path.join(STATE_DIR, "langfuse_state.lock");

// MAX_CHARS 在模块加载时确定（供 truncateText 默认参数）；DEBUG 每次运行重读
const _cfg = loadConfig();
const MAX_CHARS = _cfg.maxChars;
let DEBUG = _cfg.debug;

// 探针版本号（从 package.json 读，写入 trace metadata 便于追溯"这条数据是哪版探针上送的"）
// 优先读 env（install 时写入 settings.json，hook 安装到 ~/.claude/hooks/ 后通过 env 传入，
// 因 ~/.claude/package.json 存在但非探针的，require('../package.json') 会误读）；
// env 无则尝试包内 package.json（开发环境）。
let PROBE_VERSION = process.env.CC_LANGFUSE_PROBE_VERSION || "";
if (!PROBE_VERSION) {
  try {
    const pkg = require(path.join(__dirname, "..", "package.json"));
    // 仅当 name 是本探针时才采信，避免误读 ~/.claude/package.json
    if (pkg && pkg.name === "cc-langfuse") PROBE_VERSION = pkg.version || "unknown";
    else PROBE_VERSION = "unknown";
  } catch (_) {
    PROBE_VERSION = "unknown";
  }
}
if (!PROBE_VERSION) PROBE_VERSION = "unknown";

// --- 日志（fail-open，写日志失败也不影响主流程）---
function log(level, message) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    fs.appendFileSync(LOG_FILE, `${ts} [${level}] ${message}\n`, "utf-8");
  } catch (_) {}
}
const debug = (m) => DEBUG && log("DEBUG", m);
const info = (m) => log("INFO", m);
const warn = (m) => log("WARN", m);

// --- 用户标识解析 ---
function resolveUserId(cwd) {
  const cfg = loadConfig();
  // 优先级：CC_LANGFUSE_USER_ID > USERNAME > USER > COMPUTERNAME
  const userId =
    cfg.userIdOverride ||
    process.env.USERNAME ||
    process.env.USER ||
    process.env.COMPUTERNAME ||
    null;
  const meta = {};
  if (process.env.COMPUTERNAME) meta.computer = process.env.COMPUTERNAME;
  // git 仓库则补充 name/email（best-effort，不作为 user_id 主键）
  if (cwd) {
    try {
      for (const field of ["name", "email"]) {
        const val = execSync(`git config --get user.${field}`, {
          cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"],
          timeout: 3000,
        }).trim();
        if (val) meta[`git_${field}`] = val;
      }
    } catch (_) {}
  }
  return { userId, meta };
}

// --- git 分支解析（兜底）---
// Claude Code 在某些环境（如 Windows cmd）下获取分支会失败，transcript 的 gitBranch
// 字段会被写成字面量 "HEAD" 或为空。此时用 cwd 主动调 git 命令兜底取真实分支名。
// 优先 rev-parse --abbrev-ref（短名，如 main）；失败再试 symbolic-ref；都失败返回 null。
function resolveGitBranch(cwd) {
  if (!cwd) return null;
  const tryCmd = (cmd) => {
    try {
      const out = execSync(cmd, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 3000,
      }).trim();
      // 排除空值、字面量 "HEAD"、 detached 时 rev-parse 返回的 commit sha（含 "HEAD" 则丢弃）
      if (out && out !== "HEAD") return out;
    } catch (_) {}
    return null;
  };
  // 短分支名（在 detached HEAD 状态下返回 "HEAD"，此时再试 symbolic-ref 拿不到，最终兜底 null）
  let branch = tryCmd("git rev-parse --abbrev-ref HEAD");
  if (branch) return branch;
  // 兜底：symbolic-ref 取完整 ref 名（如 refs/heads/main），取末段
  const ref = tryCmd("git symbolic-ref --quiet HEAD");
  if (ref) {
    const short = ref.split("/").pop();
    if (short && short !== "HEAD") return short;
  }
  return null;
}

// --- 跨平台文件锁（.lock 文件 + 排他打开重试）---
class FileLock {
  constructor(lockPath, timeoutMs = 2000) {
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
    this._fd = null;
  }
  acquire() {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      try {
        // 'wx' 排他创建：文件已存在则抛错，实现互斥
        this._fd = fs.openSync(this.lockPath, "wx");
        return true;
      } catch (e) {
        // 文件已存在，等待重试
        try {
          fs.closeSync(this._fd);
        } catch (_) {}
        this._fd = null;
        // 清理可能残留的孤儿锁（超过 30s 视为死锁）
        try {
          const stat = fs.statSync(this.lockPath);
          if (Date.now() - stat.mtimeMs > 30000) {
            fs.unlinkSync(this.lockPath);
          }
        } catch (_) {}
        const start = Date.now();
        while (Date.now() - start < 50) {} // 短暂自旋等待
      }
    }
    return false; // 超时未获取锁，fail-open 继续
  }
  release() {
    if (this._fd !== null) {
      try {
        fs.closeSync(this._fd);
      } catch (_) {}
      this._fd = null;
    }
    try {
      fs.unlinkSync(this.lockPath);
    } catch (_) {}
  }
}

// --- 状态持久化（原子写入）---
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch (_) {
    return {};
  }
}
function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmp, STATE_FILE); // 原子替换
  } catch (e) {
    debug(`save_state failed: ${e.message}`);
  }
}
function stateKey(sessionId, transcriptPath) {
  return crypto
    .createHash("sha256")
    .update(`${sessionId}::${transcriptPath}`)
    .digest("hex");
}

// --- Hook payload 读取（stdin）---
function readHookPayload() {
  try {
    // stdin 同步读取（hook 场景输入量小）
    const fd = 0;
    const chunks = [];
    const buf = Buffer.alloc(65536);
    while (true) {
      let n;
      try {
        n = fs.readSync(fd, buf, 0, buf.length, null);
      } catch (_) {
        break;
      }
      if (n <= 0) break;
      chunks.push(Buffer.from(buf.slice(0, n)));
      if (n < buf.length) break; // 读完了
    }
    const data = Buffer.concat(chunks).toString("utf-8").trim();
    if (!data) return {};
    return JSON.parse(data);
  } catch (_) {
    return {};
  }
}
function extractSessionAndTranscript(payload) {
  const sessionId =
    payload.sessionId ||
    payload.session_id ||
    (payload.session && payload.session.id) ||
    null;
  const transcript =
    payload.transcriptPath ||
    payload.transcript_path ||
    (payload.transcript && payload.transcript.path) ||
    null;
  let transcriptPath = null;
  if (transcript) {
    try {
      transcriptPath = path.resolve(transcript);
    } catch (_) {}
  }
  return { sessionId, transcriptPath };
}

// --- transcript 解析辅助 ---
function getContent(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (msg.message && typeof msg.message === "object") return msg.message.content;
  return msg.content;
}
function getRole(msg) {
  const t = msg && msg.type;
  if (t === "user" || t === "assistant") return t;
  const m = msg && msg.message;
  if (m && typeof m === "object") {
    const r = m.role;
    if (r === "user" || r === "assistant") return r;
  }
  return null;
}
function isToolResult(msg) {
  if (getRole(msg) !== "user") return false;
  const c = getContent(msg);
  if (Array.isArray(c)) {
    return c.some((x) => x && typeof x === "object" && x.type === "tool_result");
  }
  return false;
}
function iterToolResults(content) {
  const out = [];
  if (Array.isArray(content)) {
    for (const x of content) {
      if (x && typeof x === "object" && x.type === "tool_result") out.push(x);
    }
  }
  return out;
}
function iterToolUses(content) {
  const out = [];
  if (Array.isArray(content)) {
    for (const x of content) {
      if (x && typeof x === "object" && x.type === "tool_use") out.push(x);
    }
  }
  return out;
}
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const x of content) {
      if (x && typeof x === "object" && x.type === "text") parts.push(x.text || "");
      else if (typeof x === "string") parts.push(x);
    }
    return parts.filter(Boolean).join("\n");
  }
  return "";
}
function iterThinking(content) {
  const out = [];
  if (Array.isArray(content)) {
    for (const x of content) {
      if (x && typeof x === "object" && x.type === "thinking") {
        const t = x.thinking || x.text;
        if (t) out.push(t);
      }
    }
  }
  return out;
}
function truncateText(s, maxChars = MAX_CHARS) {
  if (s == null) return { text: "", meta: { truncated: false, orig_len: 0 } };
  const origLen = s.length;
  if (origLen <= maxChars) return { text: s, meta: { truncated: false, orig_len: origLen } };
  const head = s.slice(0, maxChars);
  return {
    text: head,
    meta: {
      truncated: true,
      orig_len: origLen,
      kept_len: head.length,
      sha256: crypto.createHash("sha256").update(s, "utf-8").digest("hex"),
    },
  };
}
function getModel(msg) {
  const m = msg && msg.message;
  if (m && typeof m === "object") return m.model || "claude";
  return "claude";
}
function getMessageId(msg) {
  const m = msg && msg.message;
  if (m && typeof m === "object") {
    const mid = m.id;
    if (typeof mid === "string" && mid) return mid;
  }
  return null;
}
function getUsage(msg) {
  const m = msg && msg.message;
  if (m && typeof m === "object") return m.usage || null;
  return null;
}
function getStopReason(msg) {
  const m = msg && msg.message;
  if (m && typeof m === "object") return m.stop_reason || null;
  return null;
}
function getTimestamp(msg) {
  const ts = msg && msg.timestamp;
  if (!ts || typeof ts !== "string") return null;
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    return d;
  } catch (_) {
    return null;
  }
}
function isoOrNone(d) {
  return d ? d.toISOString() : null;
}

// --- 增量读取 jsonl（offset + buffer，与 Python 版一致）---
function readNewJsonl(transcriptPath, ss) {
  if (!fs.existsSync(transcriptPath)) return { msgs: [], ss };
  let chunk;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    const stat = fs.fstatSync(fd);
    const len = Math.max(0, stat.size - ss.offset);
    if (len > 0) {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, ss.offset);
      chunk = buf;
    }
    const newOffset = stat.size;
    fs.closeSync(fd);
    ss.offset = newOffset;
  } catch (e) {
    debug(`read_new_jsonl failed: ${e.message}`);
    return { msgs: [], ss };
  }
  if (!chunk) return { msgs: [], ss };
  const text = chunk.toString("utf-8");
  const combined = (ss.buffer || "") + text;
  const lines = combined.split("\n");
  ss.buffer = lines[lines.length - 1]; // 最后一段可能不完整，留到下次
  const msgs = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      msgs.push(JSON.parse(line));
    } catch (_) {}
  }
  return { msgs, ss };
}

// --- 时序单元组装：按 message.id 归并同一次 LLM 调用 ---
// 一次 LLM 调用在 transcript 中被拆成多条 assistant 行（thinking/text/tool_use），
// 它们共享同一个 message.id 和 usage。必须归并，否则 token 成倍重复计算。
function buildTaskTraces(messages) {
  const traces = [];
  let activeTrace = null;
  let currentStep = null;

  const closeStep = () => {
    if (currentStep && activeTrace) activeTrace.llmSteps.push(currentStep);
    currentStep = null;
  };

  for (const msg of messages) {
    const role = getRole(msg);

    // 审计字段捕获：transcript 每条消息带 gitBranch/cwd/version/entrypoint/userType/isSidechain，
    // 取当前 trace 内第一个非空值（人员审查、agent 可观测用）
    if (activeTrace && msg) {
      if (msg.gitBranch && !activeTrace.gitBranch) activeTrace.gitBranch = msg.gitBranch;
      if (msg.cwd && !activeTrace.cwd) activeTrace.cwd = msg.cwd;
      if (msg.version && !activeTrace.claudeVersion) activeTrace.claudeVersion = msg.version;
      if (msg.entrypoint && !activeTrace.entrypoint) activeTrace.entrypoint = msg.entrypoint;
      if (msg.userType && !activeTrace.userType) activeTrace.userType = msg.userType;
      // isSidechain：当前 trace 内只要有一条是 sidechain 则标记为子 agent 会话
      if (msg.isSidechain) activeTrace.isSidechain = true;
    }

    // tool_result
    if (isToolResult(msg)) {
      for (const tr of iterToolResults(getContent(msg))) {
        const tid = tr.tool_use_id;
        if (tid && activeTrace) {
          activeTrace.toolResultMap[String(tid)] = {
            content: tr.content,
            timestamp: getTimestamp(msg),
            // is_error：工具执行是否报错（审查异常操作）
            isError: tr.is_error === true,
          };
        }
      }
      continue;
    }

    if (role === "user") {
      closeStep();
      if (activeTrace) traces.push(activeTrace);
      activeTrace = {
        userMsg: msg,
        llmSteps: [],
        toolResultMap: {},
        gitBranch: (msg && msg.gitBranch) || null,
        cwd: (msg && msg.cwd) || null,
        claudeVersion: (msg && msg.version) || null,
        entrypoint: (msg && msg.entrypoint) || null,
        userType: (msg && msg.userType) || null,
        isSidechain: !!(msg && msg.isSidechain),
      };
      continue;
    }

    if (role === "assistant") {
      if (!activeTrace) continue;
      const msgId = getMessageId(msg);
      if (currentStep && msgId && msgId === currentStep.messageId) {
        // 同一次调用：归并
        currentStep.assistantMsgs.push(msg);
        currentStep.toolUses.push(...iterToolUses(getContent(msg)));
      } else {
        closeStep();
        currentStep = {
          assistantMsgs: [msg],
          toolUses: iterToolUses(getContent(msg)),
          messageId: msgId,
        };
      }
      continue;
    }
  }
  closeStep();
  if (activeTrace) traces.push(activeTrace);
  return traces;
}

// step 辅助
function stepFirstMsg(step) {
  return step.assistantMsgs[0] || {};
}
function stepExtractText(step) {
  return step.assistantMsgs
    .map((m) => extractText(getContent(m)))
    .filter(Boolean)
    .join("\n");
}
function stepExtractThinking(step) {
  const parts = [];
  for (const m of step.assistantMsgs) parts.push(...iterThinking(getContent(m)));
  return parts.filter(Boolean).join("\n");
}

// --- 确定性 ID 生成（幂等）---
function deterministicId(...parts) {
  return crypto
    .createHash("sha256")
    .update(parts.join("::"))
    .digest("hex")
    .slice(0, 32);
}



// --- token 用量构造（token 用量、服务端工具调用、缓存明细；不含成本计算）---
// 成本计算已移除：计费标准待供应商明确，暂不上送 costDetails。Langfuse 里 costDetails 为空，UI 不显示成本。
// token 用量(usageDetails)仍上送，可用于用量监控。后续恢复计价时在此重新加回成本逻辑。
function buildTokenDetails(usage, model) {
  if (!usage || typeof usage !== "object") return { usageDetails: null, extraMeta: null };
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  // 缓存写入时效明细（5分钟/1小时）
  const cacheWrite5m =
    (usage.cache_creation && (usage.cache_creation.ephemeral_5m_input_tokens || 0)) || 0;
  const cacheWrite1h =
    (usage.cache_creation && (usage.cache_creation.ephemeral_1h_input_tokens || 0)) || 0;
  // 服务端工具调用（外部数据外发行为，敏感审查关键）
  const serverToolUse = usage.server_tool_use || {};
  const webSearchReqs = serverToolUse.web_search_requests || 0;
  const webFetchReqs = serverToolUse.web_fetch_requests || 0;

  // usageDetails：只放 input / output 两个标准字段。
  // 【关键】Langfuse v4 会把 usageDetails 内所有数值字段按字段名归类并相加得到 Total usage：
  //   字段名含 "input"  -> Input usage
  //   字段名含 "output" -> Output usage
  //   其余            -> Other usage（仍计入 Total）
  // 因此【绝对不能】把 total 放进来（= input+output 会被重复算），也【不能】把
  //   inputCacheReads/inputCacheCreation 放进来（字段名含 "input" 会被并入 Input 再加一次）。
  // 【Claude 口径】usage.input_tokens 只含本次新读取 token，缓存部分单独统计于
  //   cache_read_input_tokens / cache_creation_input_tokens。真实输入 =
  //   input_tokens + cache_read_input_tokens + cache_creation_input_tokens。
  //   故 input 字段需把缓存 token 计入，否则 Total 偏小。
  const fullInput = inputTokens + cacheRead + cacheCreation;
  const usageDetails = {
    input: fullInput,
    output: outputTokens,
  };

  // 额外维度（放 Generation metadata，便于监控/审查）。成本计算已移除，不含 cost_*/pricing_* 字段
  // 缓存明细放 metadata，仅展示不参与 Langfuse token 加总。
  const extraMeta = {
    service_tier: usage.service_tier || null,
    speed: usage.speed || null,
    inference_geo: usage.inference_geo || null,
    web_search_requests: webSearchReqs,
    web_fetch_requests: webFetchReqs,
    cache_write_5m: cacheWrite5m,
    cache_write_1h: cacheWrite1h,
    input_tokens: inputTokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    total_tokens: fullInput + outputTokens,
  };

  return { usageDetails, extraMeta };
}

// --- Langfuse Ingestion REST API ---
function postIngestion(host, publicKey, secretKey, batch) {
  return new Promise((resolve) => {
    const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
    const body = JSON.stringify({ batch, metadata: { sdk: "cc-node-hook" } });
    const isHttps = host.startsWith("https://");
    const lib = isHttps ? https : http;
    const urlObj = new URL(host + "/api/public/ingestion");
    const req = lib.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Basic ${auth}`,
        },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const resp = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            resolve({
              ok: (resp.successes || []).length > 0 && (resp.errors || []).length === 0,
              successes: (resp.successes || []).length,
              errors: resp.errors || [],
              status: res.statusCode,
            });
          } catch (e) {
            resolve({ ok: false, successes: 0, errors: [], status: res.statusCode, parseError: e.message });
          }
        });
      }
    );
    req.on("error", (e) => resolve({ ok: false, successes: 0, errors: [{ error: e.message }], status: 0 }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, successes: 0, errors: [{ error: "timeout" }], status: 0 });
    });
    req.write(body);
    req.end();
  });
}

// --- 构造一个 trace 的全部 ingestion 事件 ---
function buildEventsForTrace(sessionId, traceIndex, trace, transcriptPath, userId, userMeta) {
  const userTextRaw = extractText(getContent(trace.userMsg));
  const { text: userText, meta: userTextMeta } = truncateText(userTextRaw);

  const traceStart = getTimestamp(trace.userMsg);
  let traceEnd = null;
  if (trace.llmSteps.length > 0) {
    const lastStep = trace.llmSteps[trace.llmSteps.length - 1];
    if (lastStep.assistantMsgs.length > 0) {
      traceEnd = getTimestamp(lastStep.assistantMsgs[lastStep.assistantMsgs.length - 1]);
    }
  }

  const userMsgUuid = trace.userMsg.uuid || "";
  const traceId = deterministicId(sessionId, traceIndex, userMsgUuid);
  const nowIso = new Date().toISOString();
  const events = [];

  // 顶层 Trace 事件
  // git_branch 兜底：transcript 的 gitBranch 在 cmd 等环境下会被写成 "HEAD" 或为空，
  // 此时用 cwd 主动调 git 命令取真实分支名，避免分支信息丢失。
  let gitBranch = trace.gitBranch || null;
  if (!gitBranch || gitBranch === "HEAD") {
    const fallback = resolveGitBranch(trace.cwd);
    if (fallback) gitBranch = fallback;
  }
  const topMetadata = {
    source: "claude-code",
    session_id: sessionId,
    task_index: traceIndex,
    transcript_path: String(transcriptPath),
    user_text_meta: userTextMeta,
    llm_step_count: trace.llmSteps.length,
    transcript_start_time: isoOrNone(traceStart),
    transcript_end_time: isoOrNone(traceEnd),
    git_branch: gitBranch,
    // 审计字段（人员审查 / agent 可观测）
    cwd: trace.cwd || null,
    claude_version: trace.claudeVersion || null,
    entrypoint: trace.entrypoint || null,
    user_type: trace.userType || null,
    is_sidechain: trace.isSidechain === true,
    probe_version: PROBE_VERSION,
  };
  if (userId) topMetadata.user_id = userId;
  Object.assign(topMetadata, userMeta || {});

  // 顶层 trace 的 output 取最后一轮 assistant 文本
  let traceOutput = null;
  if (trace.llmSteps.length > 0) {
    const { text } = truncateText(stepExtractText(trace.llmSteps[trace.llmSteps.length - 1]));
    traceOutput = { role: "assistant", content: text };
  }

  // 本 trace 级用量汇总（该用户指令内所有 LLM 调用累计）
  // 会话级(session)汇总由 Langfuse 后端按 sessionId 聚合，这里只做 trace 级
  let traceInputTokens = 0,
    traceOutputTokens = 0,
    traceCacheRead = 0,
    traceWebSearch = 0,
    traceWebFetch = 0,
    traceToolCount = 0,
    traceToolErrorCount = 0;
  for (const step of trace.llmSteps) {
    const u = getUsage(stepFirstMsg(step));
    if (u) {
      // 【Claude 口径】真实输入 = input_tokens + cache_read + cache_creation（缓存 token 不含在 input_tokens 内）
      const stepCacheRead = u.cache_read_input_tokens || 0;
      const stepCacheCreation = u.cache_creation_input_tokens || 0;
      const stepInput = (u.input_tokens || 0) + stepCacheRead + stepCacheCreation;
      traceInputTokens += stepInput;
      traceOutputTokens += u.output_tokens || 0;
      traceCacheRead += stepCacheRead;
      traceWebSearch += (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
      traceWebFetch += (u.server_tool_use && u.server_tool_use.web_fetch_requests) || 0;
    }
    traceToolCount += step.toolUses.length;
    // 工具错误数：需查 toolResultMap，但这里 step 维度没有，用简化（在 Tool 循环里已标 is_error）
  }
  // 工具错误数：遍历 toolResultMap
  for (const k of Object.keys(trace.toolResultMap)) {
    if (trace.toolResultMap[k] && trace.toolResultMap[k].isError) traceToolErrorCount++;
  }
  topMetadata.trace_total_usage = {
    input_tokens: traceInputTokens,
    output_tokens: traceOutputTokens,
    cache_read_tokens: traceCacheRead,
    total_tokens: traceInputTokens + traceOutputTokens,
    web_search_requests: traceWebSearch,
    web_fetch_requests: traceWebFetch,
    tool_call_count: traceToolCount,
    tool_error_count: traceToolErrorCount,
    llm_call_count: trace.llmSteps.length,
  };

  // tags：claude-code 固定 + git 分支 + 子 agent 标记（便于在 Langfuse 筛选聚合）
  const tags = ["claude-code"];
  if (gitBranch && gitBranch !== "HEAD") {
    tags.push("git:" + gitBranch);
  }
  if (trace.isSidechain === true) {
    tags.push("sidechain");
  }

  events.push({
    id: crypto.randomUUID(),
    timestamp: nowIso,
    type: "trace-create",
    body: {
      id: traceId,
      name: `Claude Code - UserTask ${traceIndex}`,
      userId: userId || undefined,
      sessionId: sessionId,
      timestamp: isoOrNone(traceStart) || nowIso,
      input: { role: "user", content: userText },
      output: traceOutput,
      metadata: topMetadata,
      tags: tags,
    },
  });

  // 每个 LlmStep = 一次真实 LLM 调用 = 一条 Generation
  for (let stepIdx = 0; stepIdx < trace.llmSteps.length; stepIdx++) {
    const step = trace.llmSteps[stepIdx];
    const firstMsg = stepFirstMsg(step);
    const lastMsg = step.assistantMsgs[step.assistantMsgs.length - 1] || firstMsg;
    const { text: assistText, meta: assistMeta } = truncateText(stepExtractText(step));
    const thinkingRaw = stepExtractThinking(step);
    const { text: thinkingText, meta: thinkingMeta } = thinkingRaw
      ? truncateText(thinkingRaw)
      : { text: "", meta: null };
    const model = getModel(firstMsg);
    const usage = getUsage(firstMsg);
    const stopReason = getStopReason(firstMsg);
    const messageId = step.messageId;

    const stepStart = getTimestamp(firstMsg);
    const stepEnd = getTimestamp(lastMsg);
    const { usageDetails, extraMeta } = buildTokenDetails(usage, model);

    // input：首轮是用户输入；后续轮是累积上下文
    let stepInput;
    if (stepIdx === 0) {
      stepInput = { role: "user", content: userText };
    } else {
      stepInput = {
        role: "user",
        content: "<accumulated conversation context incl. prior turns & tool results>",
        note: "本轮模型输入为累积上下文，transcript未单独记录完整请求体",
      };
    }

    const genId = deterministicId(traceId, "gen", stepIdx);
    const genMetadata = {
      assistant_meta: assistMeta,
      step_index: stepIdx,
      message_id: messageId,
      stop_reason: stopReason,
      merged_line_count: step.assistantMsgs.length,
      transcript_start_time: isoOrNone(stepStart),
      transcript_end_time: isoOrNone(stepEnd),
      // 用量扩展维度（成本/服务端工具调用/缓存明细/服务等级）
      ...(extraMeta || {}),
    };
    if (thinkingMeta) genMetadata.thinking_meta = thinkingMeta;

    events.push({
      id: crypto.randomUUID(),
      timestamp: nowIso,
      type: "observation-create",
      body: {
        id: genId,
        traceId: traceId,
        type: "GENERATION",
        name: `Generation step ${stepIdx + 1}`,
        startTime: isoOrNone(stepStart),
        endTime: isoOrNone(stepEnd),
        completionStartTime: isoOrNone(stepStart),
        model: model,
        input: stepInput,
        output: { role: "assistant", content: assistText },
        usageDetails: usageDetails || undefined,
        metadata: genMetadata,
      },
    });

    // thinking 子 span
    if (thinkingText) {
      events.push({
        id: crypto.randomUUID(),
        timestamp: nowIso,
        type: "observation-create",
        body: {
          id: deterministicId(genId, "thinking"),
          traceId: traceId,
          parentObservationId: genId,
          type: "SPAN",
          name: "Thinking",
          startTime: isoOrNone(stepStart),
          input: { role: "assistant", content: thinkingText },
          metadata: thinkingMeta ? { thinking_meta: thinkingMeta } : null,
        },
      });
    }

    // 工具调用子 observation
    for (const tc of step.toolUses) {
      const tid = String(tc.id || "");
      const toolName = tc.name || "unknown";
      const inPayload = tc.input;
      let inStr, inMeta;
      if (typeof inPayload === "string") {
        const r = truncateText(inPayload);
        inStr = r.text;
        inMeta = r.meta;
      } else {
        inStr = inPayload;
        inMeta = null;
      }

      const toolResult = trace.toolResultMap[tid];
      let outStr = "";
      let outMeta = {};
      let toolEndDt = null;
      let toolIsError = false;
      if (toolResult) {
        const rawOut =
          typeof toolResult.content === "string"
            ? toolResult.content
            : JSON.stringify(toolResult.content);
        const r = truncateText(rawOut);
        outStr = r.text;
        outMeta = r.meta;
        toolEndDt = toolResult.timestamp;
        toolIsError = toolResult.isError === true;
      }

      // 工具纯执行耗时（毫秒）：tool_result 时间 - 工具调用发起时间(stepStart)
      // 用于监控"哪个工具慢"，扣除模型思考时间后的真实执行耗时
      let toolDurationMs = null;
      if (toolEndDt && stepStart) {
        toolDurationMs = Math.max(0, toolEndDt.getTime() - stepStart.getTime());
      }

      const toolBody = {
        id: deterministicId(genId, "tool", tid),
        traceId: traceId,
        parentObservationId: genId,
        // 本 Langfuse 实例 ingestion 端点 type 仅接受 GENERATION/SPAN/EVENT（不接受 TOOL）。
        // 工具调用用 SPAN 承载，name 标 Tool: 以便 UI 区分。
        type: "SPAN",
        name: `Tool: ${toolName}`,
        startTime: isoOrNone(stepStart),
        endTime: isoOrNone(toolEndDt),
        input: inStr,
        output: outStr || undefined,
        // 工具报错时 level=WARNING，Langfuse UI 会标黄/标红，便于审查异常操作
        level: toolIsError ? "WARNING" : "DEFAULT",
        metadata: {
          tool_id: tid,
          tool_name: toolName,
          input_meta: inMeta,
          output_meta: outMeta,
          tool_result_time: isoOrNone(toolEndDt),
          is_error: toolIsError,
          tool_duration_ms: toolDurationMs,
        },
      };
      events.push({
        id: crypto.randomUUID(),
        timestamp: nowIso,
        type: "observation-create",
        body: toolBody,
      });
    }
  }

  return { traceId, events };
}

// --- 主流程 ---
async function main() {
  const cfg = loadConfig();
  // 每次运行重读 DEBUG（便于调试切换）
  DEBUG = cfg.debug;

  if ((cfg.traceToLangfuse || "").toLowerCase() !== "true") return 0;

  const publicKey = cfg.publicKey;
  const secretKey = cfg.secretKey;
  const host = cfg.baseUrl;
  if (!publicKey || !secretKey) return 0;

  const payload = readHookPayload();
  const { sessionId, transcriptPath } = extractSessionAndTranscript(payload);
  if (!sessionId || !transcriptPath) {
    debug("Missing session_id or transcript_path; exiting.");
    return 0;
  }
  if (!fs.existsSync(transcriptPath)) {
    debug(`Transcript path does not exist: ${transcriptPath}`);
    return 0;
  }

  let langfuse;
  // host 校验
  try {
    new URL(host);
  } catch (_) {
    return 0;
  }

  const lock = new FileLock(LOCK_FILE);
  let success = 0;
  let failed = 0;
  const gotLock = lock.acquire();
  if (!gotLock) debug("FileLock acquire timeout, proceeding without lock (best-effort)");

  try {
    const state = loadState();
    const key = stateKey(sessionId, transcriptPath);
    const ss = Object.assign({ offset: 0, buffer: "" }, state[key] || {});
    const { msgs, ss: newSs } = readNewJsonl(transcriptPath, ss);
    Object.assign(ss, newSs);

    if (msgs.length === 0) {
      state[key] = { offset: ss.offset, buffer: ss.buffer, updated: new Date().toISOString() };
      saveState(state);
      return 0;
    }

    const taskTraces = buildTaskTraces(msgs);
    if (taskTraces.length === 0) {
      state[key] = { offset: ss.offset, buffer: ss.buffer, updated: new Date().toISOString() };
      saveState(state);
      return 0;
    }

    // 解析 cwd（用于 git 邮箱补充）+ user_id
    let cwd = null;
    for (const m of msgs) {
      if (m && m.cwd) {
        cwd = m.cwd;
        break;
      }
    }
    const { userId, meta: userMeta } = resolveUserId(cwd);
    debug(`user_id=${userId} user_meta=${JSON.stringify(userMeta)}`);

    // 构造所有 trace 的事件，合并成一个大 batch 上送
    const allEvents = [];
    for (let i = 0; i < taskTraces.length; i++) {
      const trace = taskTraces[i];
      try {
        const { events } = buildEventsForTrace(sessionId, i + 1, trace, transcriptPath, userId, userMeta);
        allEvents.push(...events);
        success++;
      } catch (e) {
        failed++;
        debug(`buildEventsForTrace failed: ${e.message}`);
      }
    }

    // 分批上送（Langfuse 单 batch 限制 3.5MB，这里按事件数分片，保守 200 条/批）
    const BATCH_SIZE = 200;
    for (let i = 0; i < allEvents.length; i += BATCH_SIZE) {
      const slice = allEvents.slice(i, i + BATCH_SIZE);
      try {
        const resp = await postIngestion(host, publicKey, secretKey, slice);
        if (!resp.ok) {
          debug(`ingestion partial fail: status=${resp.status} errors=${JSON.stringify(resp.errors).slice(0, 300)}`);
        }
      } catch (e) {
        debug(`postIngestion failed: ${e.message}`);
      }
    }

    state[key] = { offset: ss.offset, buffer: ss.buffer, updated: new Date().toISOString() };
    saveState(state);
  } catch (e) {
    debug(`Unexpected failure: ${e.message}`);
  } finally {
    if (gotLock) lock.release();
  }

  info(`Processed ${success} user task traces (failed=${failed}) (session=${sessionId})`);
  return 0;
}

// Export for testing; only run main when executed directly (not when require'd)
module.exports = {
  buildTaskTraces,
  buildEventsForTrace,
  buildTokenDetails,
  deterministicId,
  resolveUserId,
  stepExtractText,
  stepExtractThinking,
  getUsage,
  getModel,
  getStopReason,
  getTimestamp,
};

if (require.main === module) {
  main()
    .then((code) => process.exit(code || 0))
    .catch(() => process.exit(0));
}
