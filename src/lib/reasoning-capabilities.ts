import type { LlmConfig, ReasoningConfig, ReasoningMode } from "@/stores/wiki-store"

export interface ReasoningCapabilities {
  modes: readonly ReasoningMode[]
  customBudgetRange: { min: number; max: number }
  /** A saved mode can outlive a model/provider change. Normalize it before
   * building the wire payload so stale settings cannot create invalid calls. */
  normalize(requested: ReasoningConfig): ReasoningConfig
}

/**
 * 2026-10-22 咩咩拍板（C.0）：档位选择器统一全集，不再按模型裁剪。
 * 某模型某档「能不能关、服务端怎么映射」是 wire 层与各家协议的事——
 * modes 恒为全集，模型差异转移到 llm-providers 的映射层做最佳努力，
 * UI 旁挂一行「档位实际效果因模型而异，见各家文档」。custom
 * [budgetTokens] 仅 budget 系 provider（Anthropic / Gemini 2.5 Pro /
 * OpenRouter）附加。
 */
const FULL_LEVELS = ["auto", "off", "low", "medium", "high", "max"] as const
const FULL_BUDGET_LEVELS = ["auto", "off", "low", "medium", "high", "max", "custom"] as const
const AUTO_ONLY = ["auto"] as const

function capabilities(
  modes: readonly ReasoningMode[],
  customBudgetRange: { min: number; max: number } = { min: 1, max: 32_768 },
): ReasoningCapabilities {
  return {
    modes,
    customBudgetRange,
    normalize(requested) {
      if (requested.mode !== "custom") return { mode: requested.mode }
      if (!modes.includes("custom")) return { mode: "auto" }
      const budget = Math.min(customBudgetRange.max, Math.floor(requested.budgetTokens ?? 0))
      if (budget > 0 && budget < customBudgetRange.min) {
        return { mode: "custom", budgetTokens: customBudgetRange.min }
      }
      return budget > 0 ? { mode: "custom", budgetTokens: budget } : { mode: "auto" }
    },
  }
}

function isClaude46OrLater(model: string): boolean {
  return /claude-(?:opus|sonnet|haiku)-4[-_.]?(?:[6-9]|\d{2,})(?:[-_.]|$)/i.test(model)
}

function isGemini25Pro(model: string): boolean {
  return /gemini[-_.]?2\.5[-_.]?pro(?:[-_.]|$)/i.test(model)
}

function isGemini3(model: string): boolean {
  return /gemini[-_.]?3(?:[-_.]|$)/i.test(model)
}

function isOpenAiReasoningModel(config: LlmConfig): boolean {
  if (config.provider === "azure" && config.azureModelFamily === "gpt5") return true
  const model = config.model.trim().toLowerCase()
  return /^(?:gpt-(?:[5-9]|\d{2,})|o\d+)(?:[.\-_]|$)/.test(model)
}

function isOpenAiFutureReasoningModel(config: LlmConfig): boolean {
  return /^gpt-(?:[6-9]|\d{2,})(?:[.\-_]|$)/.test(config.model.trim().toLowerCase())
}

/**
 * GPT-5.1 (Nov 2025) added `reasoning_effort: "none"` — a real "no
 * reasoning" mode. Only 5.1-and-later accept it: gpt-5/gpt-5-codex/
 * gpt-5-mini (5.0 family) and the whole o-series answer 400 for it,
 * so the off toggle must not be offered there. gpt-6+ is assumed to
 * keep the value (removing a released effort level would break every
 * API client).
 */
export function isGpt51OrLater(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return /^gpt-5[._-]?[1-9]/.test(normalized) || /^gpt-(?:[6-9]|\d{2,})/.test(normalized)
}

/**
 * MiniMax thinking behavior per model family (official Anthropic-wire
 * docs, platform.minimax.cn/docs/api-reference/text-anthropic-api):
 *   - MiniMax-M3: thinking off by default, `thinking:{"type":"disabled"}`
 *     honored → the off toggle is real.
 *   - MiniMax-M3.1-Flash: forced thinking; sending `disabled` is a 400.
 *   - M2.x: `disabled` is accepted but thinking cannot be turned off.
 * Only the models where "off" actually does something get the toggle.
 */
export function supportsMiniMaxThinkingOff(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return /^minimax-m3(?:[-_.]|$)/.test(normalized) && !/flash/.test(normalized)
}

/**
 * MiniMax first-party Anthropic-compatible endpoints (global .io,
 * mainland .minimaxi.com) reached through the custom provider. Keep in
 * sync with isMiniMaxAnthropicHost in llm-providers.ts (duplicated
 * here to avoid a circular import, mirroring the DeepSeek endpoint
 * regex which also lives in both files).
 */
export function isMiniMaxAnthropicEndpoint(endpoint: string): boolean {
  return /api\.minimax\.(?:io|com)(?:[:/]|$)/i.test(endpoint)
    || /api\.minimaxi\.com(?:[:/]|$)/i.test(endpoint)
}

/**
 * Volcengine Ark (Volcano Ark), including the Coding Plan endpoint
 * (ark.cn-beijing.volces.com/api/coding, Anthropic wire) and the
 * OpenAI-compatible /api/v3. Official deep-thinking docs: most
 * thinking models accept thinking.type=enabled(默认)/disabled/auto;
 * glm-5-3-flash on Ark "always thinks and no longer supports
 * disabling" — it must not be offered the off toggle.
 */
export function isArkEndpoint(endpoint: string): boolean {
  return /ark\.[a-z0-9-]+\.volces\.com(?::|\/|$)/i.test(endpoint)
}

export function supportsArkThinkingOff(model: string): boolean {
  return !/glm[-_.]?5[-_.]?3[-_.]?flash/i.test(model.trim())
}

export function isOpenRouterEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase()
    return hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai")
  } catch {
    return false
  }
}

/**
 * Loopback endpoints are the user's own inference server (llama.cpp
 * llama-server, LM Studio, vLLM, ...), not a third-party aggregator, so
 * sending llama.cpp-family thinking controls cannot break someone else's
 * contract. Qwen3-style GGUF chat templates think by default and eat the
 * whole `max_tokens` budget as `reasoning_content`; without this gate the
 * UI offers only "auto" and the user has no way to turn thinking off.
 */
export function isLocalInferenceEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase()
    return (
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname === "0.0.0.0"
    )
  } catch {
    return false
  }
}

/**
 * Zhipu BigModel first-party endpoints (open.bigmodel.cn mainland,
 * api.z.ai international). GLM-4.5+ models expose the documented
 * `thinking: { type: "enabled" | "disabled" }` switch, so the toggle
 * levels are safe to offer — unlike an unknown aggregator gateway.
 */
export function isBigModelEndpoint(endpoint: string): boolean {
  return /(?:^|\/\/)(?:open\.bigmodel\.cn|api\.z\.ai)(?:[:/]|$)/i.test(endpoint)
}

/**
 * Resolve the wire contract's reasoning capabilities.
 *
 * 2026-10-22 拍板后 modes 恒为全集（见文件头注释）——本函数剩下的职责是
 * custom budget 档的归属（仅 budget 系 provider）与 normalize 边界。各
 * 模型某档的真实效果由 llm-providers 的映射层负责，UI 提示行兜底说明。
 */
export function resolveReasoningCapabilities(config: LlmConfig): ReasoningCapabilities {
  if (config.provider === "claude-code" || config.provider === "codex-cli") {
    // Subprocess CLIs: off/low/medium/high/max map onto
    // MAX_THINKING_TOKENS (claude, documented env var) /
    // model_reasoning_effort (codex, ReasoningEffort enum; codex has no
    // "max" — it degrades to "high" in the CLI transport).
    return capabilities(FULL_LEVELS)
  }
  if (config.provider === "ollama") return capabilities(FULL_LEVELS)
  if (config.provider === "google") {
    if (isGemini3(config.model)) return capabilities(FULL_LEVELS)
    if (isGemini25Pro(config.model)) {
      return capabilities(FULL_BUDGET_LEVELS, { min: 128, max: 32_768 })
    }
    return capabilities(FULL_BUDGET_LEVELS)
  }
  if (config.provider === "anthropic") {
    return capabilities(FULL_BUDGET_LEVELS, { min: 1024, max: 32_768 })
  }
  if (config.provider === "minimax") return capabilities(FULL_LEVELS)
  if (config.provider === "openai" || config.provider === "azure") {
    return capabilities(FULL_LEVELS)
  }
  if (config.provider === "custom") {
    const endpoint = config.customEndpoint.toLowerCase()
    if (isOpenRouterEndpoint(endpoint)) return capabilities(FULL_BUDGET_LEVELS)
    return capabilities(FULL_LEVELS)
  }
  // Unreachable for known providers (the switch in getProviderConfig is
  // exhaustive); a stale persisted provider string has no wire contract
  // to translate modes onto, so auto is the only honest mode.
  return capabilities(AUTO_ONLY)
}

export function normalizeReasoningForProvider(
  config: LlmConfig,
  requested: ReasoningConfig,
): ReasoningConfig {
  return resolveReasoningCapabilities(config).normalize(requested)
}

/**
 * Reasoning for ingest's structured calls. Ingest hardcodes `{ mode: "off" }`
 * at every call site, which is the right default — thinking buys little on
 * structured extraction and a model that spends its budget on chain-of-thought
 * can return empty `content`, losing the page — but it is wrong as a *rule*:
 * some models reject disabling reasoning outright and answer 400, so every
 * ingest call fails with no way to fix it from the UI. Making it settable is
 * what lets those providers be used; "off" stays the default so existing
 * setups behave exactly as before.
 *
 * Keep this helper provider-agnostic. The provider layer normalizes the saved
 * value once when it builds the wire payload, including stale settings left by
 * a provider or model change.
 */
export function resolveIngestReasoning(config: LlmConfig): ReasoningConfig {
  return config.ingestReasoning ?? { mode: "off" }
}

export function isAdaptiveAnthropicModel(config: LlmConfig): boolean {
  return config.provider === "anthropic" && isClaude46OrLater(config.model)
}

export function isGeminiThinkingLevelModel(config: LlmConfig): boolean {
  return config.provider === "google" && isGemini3(config.model)
}
