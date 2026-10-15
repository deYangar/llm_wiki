import { describe, it, expect, beforeEach } from "vitest"
import { useActivityStore } from "./activity-store"

function addItem(overrides: Partial<{ title: string; status: "running" | "done" | "error" }> = {}): string {
  return useActivityStore.getState().addItem({
    type: "ingest",
    title: overrides.title ?? "source.pdf",
    status: overrides.status ?? "done",
    detail: "3 files written",
    filesWritten: ["wiki/sources/source.md"],
  })
}

beforeEach(() => {
  useActivityStore.setState({ items: [] })
})

describe("activity-store item cap", () => {
  it("caps items at 100, keeping the newest at the head", () => {
    for (let i = 0; i < 150; i++) {
      addItem({ title: `source-${i}.pdf` })
    }
    const items = useActivityStore.getState().items
    expect(items).toHaveLength(100)
    expect(items[0].title).toBe("source-149.pdf")
    expect(items[99].title).toBe("source-50.pdf")
  })

  it("does not trim before the cap is reached", () => {
    for (let i = 0; i < 100; i++) {
      addItem({ title: `source-${i}.pdf` })
    }
    expect(useActivityStore.getState().items).toHaveLength(100)
  })

  it("updating an evicted item is a safe no-op", () => {
    const oldestId = addItem({ title: "oldest.pdf" })
    for (let i = 0; i < 150; i++) {
      addItem({ title: `source-${i}.pdf` })
    }
    expect(useActivityStore.getState().items.some((item) => item.id === oldestId)).toBe(false)

    expect(() =>
      useActivityStore.getState().updateItem(oldestId, { status: "done", detail: "late" }),
    ).not.toThrow()
    // Evicted item must not be resurrected by a late update.
    expect(useActivityStore.getState().items.some((item) => item.id === oldestId)).toBe(false)
  })

  it("clearDone keeps only running items", () => {
    addItem({ title: "a.pdf", status: "running" })
    addItem({ title: "b.pdf", status: "done" })
    addItem({ title: "c.pdf", status: "error" })
    useActivityStore.getState().clearDone()
    const items = useActivityStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe("a.pdf")
  })
})
