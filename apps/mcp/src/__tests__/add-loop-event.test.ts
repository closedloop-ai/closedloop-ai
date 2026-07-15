import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../tools/tool-utils.js", () => ({
  buildLoopUrl: (loopId: string) => `https://app.example/loops/${loopId}`,
  encodePathSegment: (id: string) => encodeURIComponent(id),
  withErrorHandling: (fn: () => Promise<unknown>) => fn(),
}));

import { registerAddLoopEvent } from "../tools/add-loop-event.js";

const registerTool = vi.fn();
const apiClient = {
  post: vi.fn(),
};

function registeredHandler() {
  return registerTool.mock.calls[0]?.[2] as
    | ((input: Record<string, unknown>) => Promise<{
        content: { type: string; text: string }[];
      }>)
    | undefined;
}

async function callHandler(input: Record<string, unknown>) {
  const result = await registeredHandler()?.(input);
  return JSON.parse(result?.content[0]?.text ?? "{}") as Record<
    string,
    unknown
  >;
}

describe("add-loop-event MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerAddLoopEvent({ registerTool } as never, apiClient as never);
  });

  it("posts the message as an output event to the loop", async () => {
    apiClient.post.mockResolvedValue({ id: "event-1" });
    await callHandler({ loopId: "loop-1", message: "Investigating codebase" });

    expect(apiClient.post).toHaveBeenCalledWith(
      "/loops/loop-1/manual-events",
      expect.objectContaining({
        type: "output",
        data: expect.objectContaining({ chunk: "Investigating codebase" }),
      })
    );
  });

  it("normalizes the response to the shared {loopId, ...event, webUrl} contract", async () => {
    // Shape mirrors the manual-events route's LoopEventReceivedResponse.
    apiClient.post.mockResolvedValue({ received: true });
    const payload = await callHandler({ loopId: "loop-1", message: "hi" });

    expect(payload).toMatchObject({
      loopId: "loop-1",
      received: true,
      webUrl: "https://app.example/loops/loop-1",
    });
  });

  it("always surfaces webUrl and loopId even when the API returns a non-object", async () => {
    apiClient.post.mockResolvedValue(null);
    const payload = await callHandler({ loopId: "loop-1", message: "hi" });

    expect(payload).toEqual({
      loopId: "loop-1",
      webUrl: "https://app.example/loops/loop-1",
    });
  });
});
