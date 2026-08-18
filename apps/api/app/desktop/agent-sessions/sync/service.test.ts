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

    expect(result).toEqual({ ok: false, error: { reason: Status.Forbidden } });
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
      error: { reason: DesktopAgentSessionsAckReason.RateLimited },
    });
  });

  // Goal stage 2: the handler's request-gated per-session ack echo must reach
  // the success response value — it is what the desktop keys its atomic
  // outbox clear on.
  it("passes the handler's acceptedSessionIds through the success value", async () => {
    vi.mocked(handleDesktopAgentSessionsEvent).mockResolvedValueOnce({
      accepted: true,
      acceptedSessionIds: ["sess-1", "sess-2"],
    });

    const result = await desktopAgentSessionsSyncService.sync({
      clerkUserId: "clerk-user-1",
      computeTargetId: "target-1",
      organizationId: "org-1",
      rawBody: {},
      userId: "user-1",
    });

    expect(result).toEqual({
      ok: true,
      value: { synced: true, acceptedSessionIds: ["sess-1", "sess-2"] },
    });
  });

  // Version skew: a handler ack with no echo (the batch did not opt in) must
  // OMIT the key — installed desktops `.strict()`-parse the success response,
  // so an unrequested extra field would reject a successful sync.
  it("omits acceptedSessionIds entirely when the handler sent none", async () => {
    const result = await desktopAgentSessionsSyncService.sync({
      clerkUserId: "clerk-user-1",
      computeTargetId: "target-1",
      organizationId: "org-1",
      rawBody: {},
      userId: "user-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected an accepted sync");
    }
    expect(result.value).toEqual({ synced: true });
    expect(Object.hasOwn(result.value, "acceptedSessionIds")).toBe(false);
  });

  // ISS-5090: an opaque `validation_failed` gave operators nothing to act on.
  // The handler's stable field/path summary must survive to the route so the
  // 400 can carry it back to the desktop.
  it("carries the handler's validation detail through the failure channel", async () => {
    vi.mocked(handleDesktopAgentSessionsEvent).mockResolvedValueOnce({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
      detail: "session_count_mismatch",
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
      error: {
        reason: DesktopAgentSessionsAckReason.ValidationFailed,
        detail: "session_count_mismatch",
      },
    });
  });

  // Version skew: an ack with no detail must OMIT the key, never serialize an
  // explicit `undefined`/`null` the failure contract does not declare.
  it("omits detail entirely when the handler sent none", async () => {
    vi.mocked(handleDesktopAgentSessionsEvent).mockResolvedValueOnce({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });

    const result = await desktopAgentSessionsSyncService.sync({
      clerkUserId: "clerk-user-1",
      computeTargetId: "target-1",
      organizationId: "org-1",
      rawBody: {},
      userId: "user-1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a rejected sync");
    }
    expect(Object.hasOwn(result.error, "detail")).toBe(false);
  });
});
