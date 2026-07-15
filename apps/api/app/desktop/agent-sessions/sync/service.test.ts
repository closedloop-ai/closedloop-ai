import { DesktopAgentSessionsAckReason } from "@repo/api/src/types/agent-session";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeTargetsService } from "@/app/compute-targets/service";
import { handleDesktopAgentSessionsEvent } from "@/lib/desktop-agent-sessions-handler";
import { desktopAgentSessionsSyncService } from "./service";

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findOwnedById: vi.fn(),
  },
}));

vi.mock("@/lib/desktop-agent-sessions-handler", () => ({
  handleDesktopAgentSessionsEvent: vi.fn(),
}));

describe("desktopAgentSessionsSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue({
      id: "target-1",
    } as Awaited<ReturnType<typeof computeTargetsService.findOwnedById>>);
    vi.mocked(handleDesktopAgentSessionsEvent).mockResolvedValue({
      accepted: true,
    });
  });

  it("routes owned targeted sync payloads through the shared desktop session handler", async () => {
    const payload = {
      schemaVersion: 2,
      sessions: [],
    };

    const result = await desktopAgentSessionsSyncService.sync({
      clerkUserId: "clerk-user-1",
      computeTargetId: "target-1",
      organizationId: "org-1",
      rawBody: payload,
      userId: "user-1",
    });

    expect(result).toEqual({ ok: true, value: { synced: true } });
    expect(computeTargetsService.findOwnedById).toHaveBeenCalledWith(
      "target-1",
      "org-1",
      "user-1",
      "clerk-user-1"
    );
    expect(handleDesktopAgentSessionsEvent).toHaveBeenCalledWith(payload, {
      clerkUserId: "clerk-user-1",
      organizationId: "org-1",
      targetId: "target-1",
      userId: "user-1",
    });
  });

  it("rejects targeted sync for compute targets the caller does not own", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValueOnce(null);

    const result = await desktopAgentSessionsSyncService.sync({
      clerkUserId: "clerk-user-1",
      computeTargetId: "target-1",
      organizationId: "org-1",
      rawBody: {},
      userId: "user-1",
    });

    expect(result).toEqual({ ok: false, error: Status.Forbidden });
    expect(handleDesktopAgentSessionsEvent).not.toHaveBeenCalled();
  });

  it("preserves shared handler rejection reasons for route-level status mapping", async () => {
    vi.mocked(handleDesktopAgentSessionsEvent).mockResolvedValueOnce({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.RateLimited,
    });

    const result = await desktopAgentSessionsSyncService.sync({
      clerkUserId: "clerk-user-1",
      computeTargetId: "target-1",
      organizationId: "org-1",
      rawBody: {},
      userId: "user-1",
    });

    expect(result).toEqual({
      ok: false,
      error: DesktopAgentSessionsAckReason.RateLimited,
    });
  });
});
