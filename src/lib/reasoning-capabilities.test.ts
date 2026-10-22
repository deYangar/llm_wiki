import { describe, expect, it } from "vitest"
import type { LlmConfig } from "@/stores/wiki-store"
import { normalizeReasoningForProvider, resolveReasoningCapabilities } from "./reasoning-capabilities"

function config(provider: LlmConfig["provider"], model: string): LlmConfig {
  return {
    provider,
    model,
    apiKey: "key",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "https://gateway.example/v1",
    maxContextSize: 128_000,
  }
}

/**
 * 2026-10-22 咩咩拍板（C.0）：档位选择器统一全集，不再按模型裁剪。
 * 此前按能力裁剪 modes 的矩阵（MiniMax auto-only、glm-5-3-flash
 * auto-only、OpenAI 按模型分 4 组、Gemini/Claude thinking-required
 * 无 off）全部退役——模型差异由 wire 映射层做最佳努力，UI 提示行
 * 说明「档位实际效果因模型而异，见各家文档」。
 */
const FULL = ["auto", "off", "low", "medium", "high", "max"] as const
const FULL_BUDGET = ["auto", "off", "low", "medium", "high", "max", "custom"] as const

describe("reasoning capabilities — unified full mode set (C.0, 2026-10-22)", () => {
  it("offers the full set on every provider regardless of model", () => {
    const cases: Array<[LlmConfig, readonly string[]]> = [
      // CLI subprocess transports
      [config("claude-code", "claude-sonnet-4-6"), FULL],
      [config("codex-cli", "gpt-5.1-codex"), FULL],
      // MiniMax — M2.x/M3.1-Flash 的 off 无效是模型行为，不再是裁剪理由
      [config("minimax", "MiniMax-M3"), FULL],
      [config("minimax", "MiniMax-M2.7"), FULL],
      [config("minimax", "MiniMax-M3.1-Flash-Preview"), FULL],
      // OpenAI — 非推理/5 前/5.1+/未来系全部同一全集
      [config("openai", "gpt-4o"), FULL],
      [config("openai", "gpt-5"), FULL],
      [config("openai", "gpt-5.1"), FULL],
      [config("openai", "gpt-6-luna"), FULL],
      [config("openai", "o4"), FULL],
      [config("azure", "gpt-5.1"), FULL],
      // Google / Anthropic — budget 系带 custom；gemini3 全集无 custom
      [config("google", "gemini-2.5-pro"), FULL_BUDGET],
      [config("google", "gemini-3-pro"), FULL],
      [config("google", "gemini-2.5-flash"), FULL_BUDGET],
      [config("anthropic", "claude-sonnet-4-5"), FULL_BUDGET],
      [config("anthropic", "claude-opus-4-7"), FULL_BUDGET],
      [config("ollama", "qwen3"), FULL],
    ]
    for (const [cfg, expected] of cases) {
      expect(resolveReasoningCapabilities(cfg).modes, `${cfg.provider}/${cfg.model}`).toEqual(expected)
    }
  })

  it("offers the full set on every custom endpoint flavor", () => {
    const cases: Array<[string, string, readonly string[]]> = [
      ["https://gateway.example/v1", "Qwen3-thinking-only", FULL],
      ["https://api.minimax.io/anthropic", "MiniMax-M2.7", FULL],
      ["https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-2-1-pro-260915", FULL],
      ["https://ark.cn-beijing.volces.com/api/coding", "doubao-seed-2-1-lite", FULL],
      // Ark glm-5-3-flash off 无真关闭——wire 映射为 effort minimal，不裁剪
      ["https://ark.cn-beijing.volces.com/api/v3", "glm-5-3-flash-260828", FULL],
      ["https://api.deepseek.com/v1", "deepseek-v4", FULL],
      ["https://open.bigmodel.cn/api/paas/v4", "GLM-5.3-Flash", FULL],
      ["http://127.0.0.1:18200/v1", "Qwen3.8-27B.gguf", FULL],
      ["https://openrouter.ai/api/v1", "vendor/reasoning-model", FULL_BUDGET],
    ]
    for (const [endpoint, model, expected] of cases) {
      const cfg = { ...config("custom", model), customEndpoint: endpoint }
      expect(resolveReasoningCapabilities(cfg).modes, `${endpoint} ${model}`).toEqual(expected)
    }
  })

  it("normalizes custom budgets to positive integer values", () => {
    const cfg = config("anthropic", "claude-sonnet-4-5")
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 2048.9 }))
      .toEqual({ mode: "custom", budgetTokens: 2048 })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 10 }))
      .toEqual({ mode: "custom", budgetTokens: 1024 })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 99_999 }))
      .toEqual({ mode: "custom", budgetTokens: 32_768 })
    expect(normalizeReasoningForProvider(cfg, { mode: "custom", budgetTokens: 0 }))
      .toEqual({ mode: "auto" })
  })

  it("custom is only honored where the budget wire exists; other modes pass through", () => {
    // 非 budget 系 provider 的 custom 归 auto（wire 层没有 budget 合同）
    const openai = config("openai", "gpt-5.1")
    expect(normalizeReasoningForProvider(openai, { mode: "custom", budgetTokens: 2048 }))
      .toEqual({ mode: "auto" })
    // 全集内的档位全部透传——不再按模型归一回 auto
    expect(normalizeReasoningForProvider(openai, { mode: "max" })).toEqual({ mode: "max" })
    const glmFlash = {
      ...config("custom", "glm-5-3-flash-260828"),
      customEndpoint: "https://ark.cn-beijing.volces.com/api/v3",
    }
    expect(normalizeReasoningForProvider(glmFlash, { mode: "off" })).toEqual({ mode: "off" })
  })
})
