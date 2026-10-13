import { beforeEach, describe, expect, it, vi } from "vitest";

const PATCH = vi.fn();
vi.mock("../api", () => ({
  api: { PATCH },
  unwrap: (res: { data?: unknown; error?: unknown }) => {
    if (res.error) throw new Error("request failed");
    return res.data;
  },
  toErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

const { useShareStore } = await import("./shareStore");

describe("shareStore.updateAppChat", () => {
  beforeEach(() => PATCH.mockReset());

  it("sends only the settings that changed", async () => {
    PATCH.mockResolvedValue({ data: { success: true } });
    const result = await useShareStore
      .getState()
      .updateAppChat("ws", "sales", { modelId: "anthropic/fast" });
    expect(result.ok).toBe(true);
    expect(PATCH).toHaveBeenCalledWith(
      "/api/workspaces/{workspaceId}/apps/{id}/chat",
      {
        params: { path: { workspaceId: "ws", id: "sales" } },
        body: { modelId: "anthropic/fast" },
      },
    );
  });

  it("reports a refused model", async () => {
    PATCH.mockResolvedValue({ error: { error: "not available" } });
    const result = await useShareStore
      .getState()
      .updateAppChat("ws", "sales", { modelId: "nope" });
    expect(result.ok).toBe(false);
  });
});
