"use strict";
/**
 * 配置加载器：包内默认配置（config/default.json）<- 环境变量覆盖
 *
 * 优先级（高到低）：
 *   1. 环境变量 CC_LANGFUSE_* / LANGFUSE_* / TRACE_TO_LANGFUSE（用户自定义用）
 *   2. 包内 config/default.json（默认配置，随 npm 包分发）
 *
 * 这样用户零配置即用包内配置；需自定义时在 settings.json 的 env 用 CC_LANGFUSE_* 覆盖。
 */

const path = require("path");

let pkgConfig = {};
try {
  // 相对于本文件：src/config-loader.js -> ../config/default.json
  pkgConfig = require(path.join(__dirname, "..", "config", "default.json"));
} catch (_) {
  // 包内配置缺失时退化为空，由 env 兜底
  pkgConfig = {};
}

function env(name) {
  return process.env[name] || undefined;
}

function loadConfig() {
  // 环境变量优先，回退包内默认
  const traceToLangfuse =
    env("TRACE_TO_LANGFUSE") ||
    env("CC_TRACE_TO_LANGFUSE") ||
    pkgConfig.traceToLangfuse ||
    "false";

  const publicKey =
    env("CC_LANGFUSE_PUBLIC_KEY") ||
    env("LANGFUSE_PUBLIC_KEY") ||
    pkgConfig.publicKey ||
    undefined;

  const secretKey =
    env("CC_LANGFUSE_SECRET_KEY") ||
    env("LANGFUSE_SECRET_KEY") ||
    pkgConfig.secretKey ||
    undefined;

  const baseUrl =
    env("CC_LANGFUSE_BASE_URL") ||
    env("LANGFUSE_BASE_URL") ||
    pkgConfig.baseUrl ||
    "https://cloud.langfuse.com";

  const debug =
    (env("CC_LANGFUSE_DEBUG") || pkgConfig.debug || "false").toLowerCase() === "true";

  const maxChars = parseInt(
    env("CC_LANGFUSE_MAX_CHARS") || pkgConfig.maxChars || "20000",
    10
  );

  // 自定义 user_id（可选，未设则用系统账号名）
  const userIdOverride =
    env("CC_LANGFUSE_USER_ID") || undefined;

  // 模型计价表（元/百万token）。【当前未启用】1.0.4 已移除成本计算，此字段加载了但 hook.js 不读取。
  // 保留备用：待计费标准明确、在 hook.js 恢复成本逻辑后，此加载即生效。
  // env CC_LANGFUSE_MODEL_PRICING（JSON 字符串）可覆盖包内配置，便于不发包临时调价。
  let modelPricing = pkgConfig.modelPricing || {};
  const pricingEnv = env("CC_LANGFUSE_MODEL_PRICING");
  if (pricingEnv) {
    try {
      modelPricing = JSON.parse(pricingEnv);
    } catch (_) {
      // env 解析失败则忽略，用包内默认
    }
  }

  return {
    traceToLangfuse,
    publicKey,
    secretKey,
    baseUrl,
    debug,
    maxChars,
    userIdOverride,
    modelPricing,
    // 暴露包内原始配置，供 install.js 写入 settings.json env 时使用
    pkgDefaults: pkgConfig,
  };
}

module.exports = { loadConfig };
