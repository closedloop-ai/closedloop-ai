import { LoopStatus } from "@repo/api/src/types/loop.js";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerCompleteLoop } from "../tools/complete-loop.js";
import { registerGetLoop } from "../tools/get-loop.js";
import {
  createToolHarness,
  parseToolPayload,
} from "./fixtures/tool-harness.js";

describe("complete-loop MCP tool", () => {
  it("sends manual-events POST with default summary/tokens when all three are omitted", async () => {
    const post = vi.fn().mockResolvedValue({});
    const patch = vi.fn();
    const handler = createToolHarness(registerCompleteLoop, {
      post,
      patch,
    } as unknown as ApiClient);

    await handler({ loopId: "loop-abc" });

    expect(post).toHaveBeenCalledWith(
      "/loops/loop-abc/manual-events",
      expect.objectContaining({
        type: "completed",
        data: expect.objectContaining({
          result: expect.objectContaining({
            summary: "Manual loop completed",
          }),
          tokensUsed: { input: 0, output: 0 },
        }),
      })
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it("sends manual-events POST with provided summary and tokens", async () => {
    const post = vi.fn().mockResolvedValue({});
    const patch = vi.fn().mockResolvedValue({});
    const handler = createToolHarness(registerCompleteLoop, {
      post,
      patch,
    } as unknown as ApiClient);

    await handler({
      loopId: "loop-abc",
      summary: "Finished the feature",
      tokensInput: 100,
      tokensOutput: 200,
    });

    expect(post).toHaveBeenCalledWith(
      "/loops/loop-abc/manual-events",
      expect.objectContaining({
        data: expect.objectContaining({
          result: expect.objectContaining({ summary: "Finished the feature" }),
          tokensUsed: { input: 100, output: 200 },
        }),
      })
    );
  });

  it("omits PATCH when none of prUrl/branchName/summary are supplied", async () => {
    const post = vi.fn().mockResolvedValue({});
    const patch = vi.fn();
    const handler = createToolHarness(registerCompleteLoop, {
      post,
      patch,
    } as unknown as ApiClient);

    await handler({ loopId: "loop-abc" });

    expect(patch).not.toHaveBeenCalled();
  });

  it("sends PATCH with only prUrl when only prUrl is supplied", async () => {
    const post = vi.fn().mockResolvedValue({});
    const patch = vi.fn().mockResolvedValue({});
    const handler = createToolHarness(registerCompleteLoop, {
      post,
      patch,
    } as unknown as ApiClient);

    await handler({
      loopId: "loop-abc",
      prUrl: "https://github.com/org/repo/pull/1",
    });

    expect(patch).toHaveBeenCalledWith("/loops/loop-abc", {
      prUrl: "https://github.com/org/repo/pull/1",
    });
  });

  it("sends PATCH with only branchName when only branchName is supplied", async () => {
    const post = vi.fn().mockResolvedValue({});
    const patch = vi.fn().mockResolvedValue({});
    const handler = createToolHarness(registerCompleteLoop, {
      post,
      patch,
    } as unknown as ApiClient);

    await handler({ loopId: "loop-abc", branchName: "feat/my-feature" });

    expect(patch).toHaveBeenCalledWith("/loops/loop-abc", {
      branchName: "feat/my-feature",
    });
  });

  it("sends PATCH with only summary when only summary is supplied", async () => {
    const post = vi.fn().mockResolvedValue({});
    const patch = vi.fn().mockResolvedValue({});
    const handler = createToolHarness(registerCompleteLoop, {
      post,
      patch,
    } as unknown as ApiClient);

    await handler({ loopId: "loop-abc", summary: "Done" });

    expect(patch).toHaveBeenCalledWith("/loops/loop-abc", {
      summary: "Done",
    });
  });

  it("sends PATCH with all three metadata fields when all are provided", async () => {
    const post = vi.fn().mockResolvedValue({});
    const patch = vi.fn().mockResolvedValue({});
    const handler = createToolHarness(registerCompleteLoop, {
      post,
      patch,
    } as unknown as ApiClient);

    await handler({
      loopId: "loop-abc",
      prUrl: "https://github.com/org/repo/pull/7",
      branchName: "feat/thing",
      summary: "All done",
    });

    expect(patch).toHaveBeenCalledWith("/loops/loop-abc", {
      prUrl: "https://github.com/org/repo/pull/7",
      branchName: "feat/thing",
      summary: "All done",
    });
  });

  it("returns completed status in the response payload", async () => {
    const post = vi.fn().mockResolvedValue({});
    const patch = vi.fn().mockResolvedValue({});
    const handler = createToolHarness(registerCompleteLoop, {
      post,
      patch,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ loopId: "loop-abc", summary: "Done" })
    ) as Record<string, unknown>;

    expect(payload.status).toBe(LoopStatus.Completed);
    expect(payload.loopId).toBe("loop-abc");
  });
});

describe("get-loop MCP tool", () => {
  it("uses response id for webUrl when the API returns an id", async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ id: "server-id", status: "RUNNING" });
    const handler = createToolHarness(registerGetLoop, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ loopId: "input-id" })
    ) as Record<string, unknown>;

    expect(get).toHaveBeenCalledWith("/loops/input-id");
    expect(payload.id).toBe("server-id");
    expect(typeof payload.webUrl).toBe("string");
    expect(String(payload.webUrl)).toContain("server-id");
    expect(String(payload.webUrl)).not.toContain("input-id");
  });

  it("falls back to input loopId in webUrl when the API response has no id", async () => {
    const get = vi.fn().mockResolvedValue({ status: "RUNNING" });
    const handler = createToolHarness(registerGetLoop, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ loopId: "input-id" })
    ) as Record<string, unknown>;

    expect(String(payload.webUrl)).toContain("input-id");
  });
});
