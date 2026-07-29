#!/usr/bin/env node
/**
 * cc-langfuse 安装器 / 卸载器（CLI）
 *
 * 用法：
 *   cc-langfuse            安装探针（默认）
 *   cc-langfuse install    安装探针
 *   cc-langfuse uninstall   卸载探针
 *   cc-langfuse status      查看安装状态
 *
 * 安装即用：配置随 npm 包分发，用户可在 settings.json 的 env 中用 CC_LANGFUSE_* 覆盖。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const HOOKS_DIR = path.join(CLAUDE_DIR, "hooks");
const SETTINGS_FILE = path.join(CLAUDE_DIR, "settings.json");
const HOOK_FILE = path.join(HOOKS_DIR, "langfuse_hook.js");
// hook 运行时 require config-loader 和 config/default.json，故一并复制到 hooks 目录
const COPIED_FILES = [
  { src: path.join(__dirname, "hook.js"), dst: HOOK_FILE },
  { src: path.join(__dirname, "config-loader.js"), dst: path.join(HOOKS_DIR, "langfuse_config_loader.js") },
  { src: path.join(__dirname, "..", "config", "default.json"), dst: path.join(HOOKS_DIR, "langfuse_config_default.json") },
];

// 加载包内配置
let pkgConfig = {};
try {
  pkgConfig = require(path.join(__dirname, "..", "config", "default.json"));
} catch (_) {}

// 探针版本号（从 package.json 读，写入 settings.json env，hook 运行时据此上送 probe_version）
let PROBE_VERSION = "unknown";
try {
  PROBE_VERSION = require(path.join(__dirname, "..", "package.json")).version || "unknown";
} catch (_) {}

// 安装后写入 settings.json env 的配置（CC_ 前缀，hook 读取时优先级最高）
function envToWrite() {
  return {
    TRACE_TO_LANGFUSE: pkgConfig.traceToLangfuse || "true",
    CC_LANGFUSE_DEBUG: pkgConfig.debug || "false",
    CC_LANGFUSE_PUBLIC_KEY: pkgConfig.publicKey,
    CC_LANGFUSE_SECRET_KEY: pkgConfig.secretKey,
    CC_LANGFUSE_BASE_URL: pkgConfig.baseUrl,
    // 探针版本号：hook 安装到 ~/.claude/hooks/ 后读不到 package.json，故通过 env 传入
    CC_LANGFUSE_PROBE_VERSION: PROBE_VERSION,
  };
}

function log(msg) { console.log(`[cc-langfuse] ${msg}`); }
function warn(msg) { console.warn(`[cc-langfuse] WARN: ${msg}`); }
function err(msg) { console.error(`[cc-langfuse] ERROR: ${msg}`); }

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch (_) { return fallback; }
}
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

function hookCommand() {
  return `node "${HOOK_FILE}"`;
}

// 步骤1：复制 hook 及其依赖文件到 ~/.claude/hooks/
function installHookFiles() {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  for (const { src, dst } of COPIED_FILES) {
    if (!fs.existsSync(src)) {
      err(`找不到安装源 ${src}`);
      process.exit(1);
    }
    const srcContent = fs.readFileSync(src, "utf-8");
    if (fs.existsSync(dst)) {
      if (fs.readFileSync(dst, "utf-8") === srcContent) {
        continue; // 已是最新
      }
      fs.copyFileSync(dst, dst + ".bak");
      log(`已备份旧版 ${path.basename(dst)} -> ${path.basename(dst)}.bak`);
    }
    fs.writeFileSync(dst, srcContent, "utf-8");
  }
  // 关键：hook.js 里 require('./config-loader')，但复制时改了文件名，
  // 需修正 hook.js 内的 require 路径指向复制后的文件名。
  patchHookRequirePaths();
  log(`已安装探针文件到 ${HOOKS_DIR}`);
}

// 修正 hook.js 内对 config-loader 的 require 路径
// hook.js 原本 require('./config-loader')，复制后文件名改为 langfuse_config_loader.js
function patchHookRequirePaths() {
  let content = fs.readFileSync(HOOK_FILE, "utf-8");
  // config-loader.js 复制为 langfuse_config_loader.js
  content = content.replace(/require\(["']\.\/config-loader["']\)/g, 'require("./langfuse_config_loader")');
  // config-loader 内 require('../config/default.json') 复制后路径需改为 './langfuse_config_default.json'
  // 但 config-loader 是独立复制的，其内部 require 路径需单独处理
  fs.writeFileSync(HOOK_FILE, content, "utf-8");

  // 同样修正 config-loader 副本内的 default.json 路径
  const clPath = path.join(HOOKS_DIR, "langfuse_config_loader.js");
  if (fs.existsSync(clPath)) {
    let cl = fs.readFileSync(clPath, "utf-8");
    cl = cl.replace(
      /require\(path\.join\(__dirname, "\.\.", "config", "default\.json"\)\)/g,
      'require(path.join(__dirname, "langfuse_config_default.json"))'
    );
    fs.writeFileSync(clPath, cl, "utf-8");
  }
}

// 步骤2：patch settings.json 的 hooks.Stop
function patchSettings() {
  const settings = readJSON(SETTINGS_FILE, {});
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];

  const cmd = hookCommand();
  for (const entry of settings.hooks.Stop) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    for (const h of entry.hooks) {
      if (h && h.command === cmd) {
        log("settings.json 中已存在探针 Stop hook，跳过");
        return;
      }
    }
  }

  // 检测旧 Python 版 hook
  const pythonCmds = [];
  for (const entry of settings.hooks.Stop) {
    if (!entry || !Array.isArray(entry.hooks)) continue;
    for (const h of entry.hooks) {
      if (h && typeof h.command === "string" && /langfuse_hook\.py/.test(h.command)) {
        pythonCmds.push(h.command);
      }
    }
  }

  settings.hooks.Stop.push({
    matcher: "",
    hooks: [{ type: "command", command: cmd }],
  });
  writeJSON(SETTINGS_FILE, settings);
  log("已在 settings.json 的 hooks.Stop 追加探针 hook");

  if (pythonCmds.length > 0) {
    warn("检测到已有 Python 版 langfuse hook，会重复上送。建议运行 cc-langfuse uninstall 移除旧的，或手动删除：");
    for (const c of pythonCmds) warn("  - " + c);
  }
}

// 步骤3：写入公司统一配置到 env
function ensureEnv() {
  const settings = readJSON(SETTINGS_FILE, {});
  if (!settings.env) settings.env = {};
  let changed = false;
  const conflicts = [];
  for (const [key, value] of Object.entries(envToWrite())) {
    const cur = settings.env[key];
    if (cur === value) continue;
    if (cur !== undefined) conflicts.push(`${key}: ${cur} -> ${value}`);
    settings.env[key] = value;
    changed = true;
  }
  // 清理旧的无前缀配置
  for (const k of ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"]) {
    if (settings.env[k] !== undefined) { delete settings.env[k]; changed = true; }
  }
  if (changed) {
    writeJSON(SETTINGS_FILE, settings);
    // log("已写入公司统一 Langfuse 配置到 settings.json 的 env");
    if (conflicts.length > 0) {
      warn("以下配置已覆盖原有值（公司统一配置优先）：");
      for (const c of conflicts) warn("  - " + c);
    }
  } else {
    // log("Langfuse 配置已是最新，跳过");
  }
  // log(`Langfuse 地址: ${pkgConfig.baseUrl}`);
}

// --- 安装 ---
function doInstall() {
  // log(`Claude 目录: ${CLAUDE_DIR}`);
  // log(`操作系统: ${process.platform}`);
  if (!fs.existsSync(CLAUDE_DIR)) {
    err(`未找到 Claude 目录 ${CLAUDE_DIR}，请确认已安装 Claude Code。`);
    process.exit(1);
  }
  installHookFiles();
  patchSettings();
  ensureEnv();
  // log("安装完成。无需额外配置，下次 Claude Code 会话结束时自动上送数据到 Langfuse。");
  // log(`查看数据: ${pkgConfig.baseUrl}`);
  const uid = process.env.USERNAME || process.env.USER || "未知";
  // log(`用户标识: 默认 ${uid}（可在 settings.json env 用 CC_LANGFUSE_USER_ID 自定义）`);
}

// --- 卸载 ---
function doUninstall() {
  log("开始卸载探针...");
  // 1. 移除 settings.json 里的 hook 和 env
  if (fs.existsSync(SETTINGS_FILE)) {
    const settings = readJSON(SETTINGS_FILE, {});
    if (Array.isArray(settings.hooks && settings.hooks.Stop)) {
      const before = settings.hooks.Stop.length;
      settings.hooks.Stop = settings.hooks.Stop.filter((e) => {
        if (!e || !Array.isArray(e.hooks)) return true;
        // 移除指向本探针 hook 文件的 entry
        return !e.hooks.some((h) => h && typeof h.command === "string" && h.command.includes("langfuse_hook.js"));
      });
      if (settings.hooks.Stop.length < before) log("已从 settings.json 移除探针 Stop hook");
    }
    if (settings.env) {
      const keys = ["TRACE_TO_LANGFUSE", "CC_LANGFUSE_DEBUG", "CC_LANGFUSE_PUBLIC_KEY", "CC_LANGFUSE_SECRET_KEY", "CC_LANGFUSE_BASE_URL", "CC_LANGFUSE_PROBE_VERSION"];
      for (const k of keys) {
        if (settings.env[k] !== undefined) { delete settings.env[k]; }
      }
      log("已从 settings.json 移除探针 env 配置");
    }
    writeJSON(SETTINGS_FILE, settings);
  }
  // 2. 删除探针文件
  const files = [HOOK_FILE, path.join(HOOKS_DIR, "langfuse_config_loader.js"), path.join(HOOKS_DIR, "langfuse_config_default.json")];
  for (const f of files) {
    if (fs.existsSync(f)) { fs.unlinkSync(f); log(`已删除 ${path.basename(f)}`); }
  }
  log("卸载完成。已保留 .bak 备份文件（如有）和 state 数据。");
}

// --- 状态 ---
function doStatus() {
  log(`Claude 目录: ${CLAUDE_DIR}`);
  const hookInstalled = fs.existsSync(HOOK_FILE);
  log(`探针文件: ${hookInstalled ? "已安装" : "未安装"}`);
  const settings = readJSON(SETTINGS_FILE, {});
  const stopHooks = (settings.hooks && settings.hooks.Stop) || [];
  const hasHook = stopHooks.some((e) => (e.hooks || []).some((h) => h && typeof h.command === "string" && h.command.includes("langfuse_hook.js")));
  log(`settings.json Stop hook: ${hasHook ? "已配置" : "未配置"}`);
  const env = settings.env || {};
  const hasEnv = !!env.CC_LANGFUSE_PUBLIC_KEY;
  log(`Langfuse env 配置: ${hasEnv ? "已配置" : "未配置"}`);
  if (env.CC_LANGFUSE_BASE_URL) log(`Langfuse 地址: ${env.CC_LANGFUSE_BASE_URL}`);
  const ready = hookInstalled && hasHook && hasEnv;
  // log(`状态: ${ready ? "✓ 就绪，会自动上送" : "✗ 未就绪"}`);
}

function main() {
  const cmd = (process.argv[2] || "install").toLowerCase();
  switch (cmd) {
    case "install":
    case "":
      doInstall();
      break;
    case "uninstall":
    case "remove":
      doUninstall();
      break;
    case "status":
      doStatus();
      break;
    case "help":
    case "-h":
    case "--help":
      console.log("用法: cc-langfuse [install|uninstall|status|help]");
      console.log("  install (默认)  安装探针，配置随包走，无需手动配 key");
      console.log("  uninstall       卸载探针");
      console.log("  status          查看安装状态");
      break;
    default:
      err(`未知命令: ${cmd}`);
      console.log("运行 cc-langfuse help 查看用法");
      process.exit(1);
  }
}

try {
  main();
} catch (e) {
  err(`执行失败: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}
