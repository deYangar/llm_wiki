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

describe("reasoning capabilities", () => {
  it("offers the off toggle on generic custom gateways without inferring vendor-private knobs", () => {
    const cfg = config("custom", "Qwen3-thinking-only")
    expect(resolveReasoningCapabilities(cfg).modes).toEqual(["auto", "off"])
    expect(normalizeReasoningForProvider(cfg, { mode: "off" })).toEqual({ mode: "off" })
    // Only generic disable fields go on the wire — the llama.cpp-private
    // chat_template_kwargs stays reserved for local endpoints.
    expect(resolveReasoningCapabilities(cfg).modes).not.toContain("low")
  })

  it("offers the off toggle on CLI providers (claude-code / codex-cli)", () => {
    for (const provider of ["claude-code", "codex-cli"] as const) {
      const cfg = config(provider, "claude-sonnet-4-6")
      expect(resolveReasoningCapabilities(cfg).modes).toEqual(["auto", "off"])
      expect(normalizeReasoningForProvider(cfg, { mode: "off" })).toEqual({ mode: "off" })
    }
  })

  it("offers off only where MiniMax can actually disable thinking", () => {
    expect(resolveReasoningCapabilities(config("minimax", "MiniMax-M3")).modes)
      .toEqual(["auto", "off"])
    // M2.x accepts the flag but keeps thinking on; M3.1-Flash 400s on it.
    expect(resolveReasoningCapabilities(config("minimax", "MiniMax-M2.7")).modes)
      .toEqual(["auto"])
    expect(resolveReasoningCapabilities(config("minimax", "MiniMax-M3.1-Flash-Preview")).modes)
      .toEqual(["auto"])
  })

  it("gates MiniMax custom-endpoint toggles by the same model rules", () => {
    const base = { ...config("custom", "MiniMax-M3"), customEndpoint: "https://api.minimax.io/anthropic" }
    expect(resolveReasoningCapabilities(base).modes).toEqual(["auto", "off"])
    const m2 = { ...base, model: "MiniMax-M2.7" }
    expect(resolveReasoningCapabilities(m2).modes).toEqual(["auto"])
  })

  it("offers the off toggle on Volcengine Ark endpoints except always-thinking GLM flash", () => {
    const doubao = {
      ...config("custom", "doubao-seed-2-1-pro-260915"),
      customEndpoint: "https://ark.cn-beijing.volces.com/api/v3",
    }
    expect(resolveReasoningCapabilities(doubao).modes).toEqual(["auto", "off"])
    const coding = {
      ...doubao,
      customEndpoint: "https://ark.cn-beijing.volces.com/api/coding",
    }
    expect(resolveReasoningCapabilities(coding).modes).toEqual(["auto", "off"])
    // Ark's glm-5-3-flash "始终启用思考,不再支持禁用"
    const glmFlash = {
      ...doubao,
      model: "glm-5-3-flash-260828",
    }
    expect(resolveReasoningCapabilities(glmFlash).modes).toEqual(["auto"])
  })

  it("offers OpenRouter's documented reasoning controls only on its endpoint", () => {
    const cfg = {
      ...config("custom", "vendor/reasoning-model"),
      customEndpoint: "https://openrouter.ai/api/v1",
    }

    expect(resolveReasoningCapabilities(cfg).modes)
      .toEqual(["auto", "off", "low", "medium", "high", "max", "custom"])
    expect(normalizeReasoningForProvider(cfg, { mode: "low" })).toEqual({ mode: "low" })
  })

  it("offers the thinking toggle on local inference endpoints (llama.cpp / vLLM / LM Studio)", () => {
    for (const endpoint of ["http://127.0.0.1:18200/v1", "http://localhost:1234/v1", "http://[::1]:8080/v1"]) {
      const cfg = {
        ...config("custom", "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf"),
        customEndpoint: endpoint,
      }
      expect(resolveReasoningCapabilities(cfg).modes).toEqual(["auto", "off"])
      expect(normalizeReasoningForProvider(cfg, { mode: "off" })).toEqual({ mode: "off" })
    }
  })

  it("offers the thinking toggle on Zhipu BigModel first-party endpoints", () => {
    for (const endpoint of ["https://open.bigmodel.cn/api/paas/v4", "https://api.z.ai/api/paas/v4"]) {
      const cfg = {
        ...config("custom", "GLM-5.3-Flash"),
        customEndpoint: endpoint,
      }
      expect(resolveReasoningCapabilities(cfg).modes).toEqual(["auto", "off"])
      expect(normalizeReasoningForProvider(cfg, { mode: "off" })).toEqual({ mode: "off" })
    }
  })

  it("does not offer off for thinking-required Gemini and Claude models", () => {
    expect(resolveReasoningCapabilities(config("google", "gemini-2.5-pro")).modes)
      .not.toContain("off")
    expect(resolveReasoningCapabilities(config("anthropic", "claude-opus-4-7")).modes)
      .not.toContain("off")
    expect(resolveReasoningCapabilities(config("anthropic", "claude-sonnet-4-6")).modes)
      .not.toContain("custom")
  })

  it("offers the off toggle on every OpenAI model, and effort levels only on reasoning models", () => {
    // Non-reasoning models never think; off is a legitimate no-op that
    // keeps saved/ingest "off" settings from being normalized away.
    expect(resolveReasoningCapabilities(config("openai", "gpt-4o")).modes)
      .toEqual(["auto", "off"])
    // GPT-5.1+ accepts the official reasoning_effort "none".
    expect(resolveReasoningCapabilities(config("openai", "gpt-5.1")).modes)
      .toEqual(["auto", "off", "low", "medium", "high"])
    // Pre-5.1 reasoning models (gpt-5, o-series) reject "none" with 400.
    expect(resolveReasoningCapabilities(config("openai", "gpt-5")).modes)
      .toEqual(["auto", "low", "medium", "high"])
    expect(resolveReasoningCapabilities(config("openai", "o4")).modes)
      .toEqual(["auto", "low", "medium", "high"])
    expect(normalizeReasoningForProvider(config("openai", "gpt-5"), { mode: "max" }))
      .toEqual({ mode: "auto" })
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
})
