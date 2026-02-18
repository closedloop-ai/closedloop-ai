import { vi } from "vitest";

vi.mock("@/lib/auth/loop-runner-jwt", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/loop-runner-jwt")
  >("@/lib/auth/loop-runner-jwt");
  return {
    ...actual,
    verifyLoopRunnerToken: vi.fn(),
  };
});

vi.mock("@/lib/loop-orchestrator", () => ({
  handleLoopEvent: vi.fn(),
}));

vi.mock("@/lib/loop-event-bus", () => ({
  loopEventBus: { publish: vi.fn() },
}));

vi.mock("@/app/loops/service", async () => {
  const actual = await vi.importActual<typeof import("@/app/loops/service")>(
    "@/app/loops/service"
  );
  return {
    ...actual,
    loopsService: {
      ...actual.loopsService,
      findById: vi.fn(),
    },
  };
});

import { POST } from "@/app/loops/[id]/events/route";
import { loopsService, ReplayDetectedError } from "@/app/loops/service";
import { verifyLoopRunnerToken } from "@/lib/auth/loop-runner-jwt";
import { handleLoopEvent } from "@/lib/loop-orchestrator";

describe("POST /api/loops/[id]/events replay handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 409 when replay is detected", async () => {
    vi.mocked(verifyLoopRunnerToken).mockResolvedValue({
      loopId: "loop-123",
      organizationId: "org-123",
      tokenId: "token-123",
    });

    vi.mocked(loopsService.findById).mockResolvedValue({
      id: "loop-123",
      organizationId: "org-123",
      status: "RUNNING",
    } as any);

    vi.mocked(handleLoopEvent).mockRejectedValue(new ReplayDetectedError());

    const request = new Request("http://localhost/api/loops/loop-123/events", {
      method: "POST",
      headers: {
        authorization: "Bearer runner-token",
        "x-loop-event-nonce": "11111111-1111-4111-8111-111111111111",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "started",
        timestamp: "2026-02-17T00:00:00.000Z",
      }),
    });

    const response = await POST(request, {
      params: Promise.resolve({ id: "loop-123" }),
    });

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Replay detected");
  });
});
