import { beforeEach, describe, expect, it, vi } from "vitest"

const { streamChatMock } = vi.hoisted(() => ({
  streamChatMock: vi.fn(),
}))

vi.mock("@/lib/llm-client", () => ({
  streamChat: streamChatMock,
}))

import { streamChatWithContinuation } from "./ingest"
import type { ReasoningConfig } from "@/stores/wiki-store"

const llmConfig = {
  provider: "custom",
  model: "qwen3.8",
  apiKey: "",
  customEndpoint: "http://127.0.0.1:18200",
} as never

const overrides = {
  temperature: 0.1,
  reasoning: { mode: "off" } as ReasoningConfig,
  max_tokens: 10_500,
}

/** Drive one streamChat round: deliver tokens, then finish with the given
 *  completion state. */
function round(tokens: string, truncated: boolean) {
  return (_cfg: unknown, _messages: unknown, callbacks: {
    onToken: (t: string) => void
    onDone: (c: { truncated: boolean }) => void
  }) => {
    for (const token of tokens) callbacks.onToken(token)
    callbacks.onDone({ truncated })
  }
}

beforeEach(() => {
  streamChatMock.mockReset()
})

describe("streamChatWithContinuation", () => {
  it("returns the text untouched when the first round completes", async () => {
    streamChatMock.mockImplementationOnce(round("analysis body", false))

    const result = await streamChatWithContinuation(
      llmConfig, "system", "user", overrides, () => {}, undefined,
    )

    expect(result).toEqual({ text: "analysis body", truncated: false })
    expect(streamChatMock).toHaveBeenCalledTimes(1)
  })

  it("continues from the cut point and concatenates the parts", async () => {
    streamChatMock
      .mockImplementationOnce(round("part-one-", true))
      .mockImplementationOnce(round("part-two", false))

    const result = await streamChatWithContinuation(
      llmConfig, "system", "user", overrides, () => {}, undefined,
    )

    expect(result).toEqual({ text: "part-one-part-two", truncated: false })
    expect(streamChatMock).toHaveBeenCalledTimes(2)

    // The continuation round must see the partial assistant text and an
    // instruction to resume — otherwise the model would restart the answer.
    const secondMessages = streamChatMock.mock.calls[1][1] as Array<{
      role: string
      content: string
    }>
    expect(secondMessages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"])
    expect(secondMessages[2].content).toBe("part-one-")
    expect(secondMessages[3].content).toMatch(/Continue EXACTLY/i)
  })

  it("gives up after the continuation budget is exhausted", async () => {
    streamChatMock
      .mockImplementationOnce(round("a", true))
      .mockImplementationOnce(round("b", true))
      .mockImplementationOnce(round("c", true))

    const result = await streamChatWithContinuation(
      llmConfig, "system", "user", overrides, () => {}, undefined, 2,
    )

    // 1 initial round + 2 continuations; the third truncation is final.
    expect(streamChatMock).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ text: "abc", truncated: true })
  })
})
