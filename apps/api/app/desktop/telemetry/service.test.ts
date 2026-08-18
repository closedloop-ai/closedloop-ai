import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeTargetsService } from "@/app/compute-targets/service";
import { handleTelemetryEvent } from "@/lib/desktop-telemetry-handler";
import { desktopTelemetryService } from "./service";

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findOwnedById: vi.fn(),
  },
}));

vi.mock("@/lib/desktop-telemetry-handler", () => ({
  handleTelemetryEvent: vi.fn(),
}));

const RECEIVE_INPUT = {
  clerkUserId: "clerk-user-1",
  computeTargetId: "target-1",
  organizationId: "org-1",
  pluginVersion: "0.16.71",
  rawBody: { schemaVersion: 1, category: "loop_perf" },
  userId: "user-1",
};

describe("desktopTelemetryService.receive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue({
      id: "target-1",
    } as Awaited<ReturnType<typeof computeTargetsService.findOwnedById>>);
    vi.mocked(handleTelemetryEvent).mockReturnValue({ ok: true });
  });

  // FEA-3425: the ownership check stands in for the socket path's
  // per-connection hello binding — without it any authenticated caller could
  // log telemetry under someone else's computeTargetId.
  it("rejects an unowned compute target before invoking the shared handler", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValueOnce(null);

    const result = await desktopTelemetryService.receive(RECEIVE_INPUT);

    expect(result).toEqual({ ok: false, error: Status.Forbidden });
    expect(computeTargetsService.findOwnedById).toHaveBeenCalledWith(
      "target-1",
      "org-1",
      "user-1",
      "clerk-user-1"
    );
    expect(handleTelemetryEvent).not.toHaveBeenCalled();
  });

  it("delegates owned-target events to the shared handler with server-derived context", async () => {
    const result = await desktopTelemetryService.receive(RECEIVE_INPUT);

    expect(result).toEqual({ ok: true, value: { received: true } });
    expect(handleTelemetryEvent).toHaveBeenCalledWith(RECEIVE_INPUT.rawBody, {
      authenticatedTargetId: "target-1",
      organizationId: "org-1",
      pluginVersion: "0.16.71",
      userId: "user-1",
    });
  });

  it("maps handler validation failures to a bad-request error", async () => {
    vi.mocked(handleTelemetryEvent).mockReturnValueOnce({
      ok: false,
      validationFailed: true,
      emits: [],
    });

    const result = await desktopTelemetryService.receive(RECEIVE_INPUT);

    expect(result).toEqual({ ok: false, error: Status.BadRequest });
  });
});
