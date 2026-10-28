import { log } from "@repo/observability/log";
import type { RevokeTarget } from "@repo/realtime-contract/internal";
import { InternalCallFailure } from "@repo/realtime-server/internal-call";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOC_SYNC_REVOKE_FAILED_EVENT,
  DOC_SYNC_REVOKE_THREW,
  revokeDocSyncAccess,
} from "../revoke";

const { revoke } = vi.hoisted(() => ({ revoke: vi.fn() }));

vi.mock("../internal-client", () => ({
  docSyncInternalClient: () => ({ revoke }),
}));

const TARGET: RevokeTarget = { orgId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" };

beforeEach(() => {
  revoke.mockReset();
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("revokeDocSyncAccess", () => {
  it.each([
    ["applied", { ok: true, value: { closedConnections: 1 } }],
    [
      "not configured",
      { ok: false, failure: InternalCallFailure.NotConfigured },
    ],
  ])("logs nothing when the revoke is %s", async (_label, result) => {
    revoke.mockResolvedValue(result);

    await revokeDocSyncAccess(TARGET);

    expect(revoke).toHaveBeenCalledWith(TARGET);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs one revoke_failed with the target, failure and status when doc-sync refuses", async () => {
    revoke.mockResolvedValue({
      ok: false,
      failure: InternalCallFailure.Rejected,
      status: 404,
    });

    await revokeDocSyncAccess(TARGET);

    expect(vi.mocked(log.error).mock.calls).toEqual([
      [
        "Doc sync revoke failed",
        {
          event: DOC_SYNC_REVOKE_FAILED_EVENT,
          target: TARGET,
          failure: InternalCallFailure.Rejected,
          httpStatus: 404,
        },
      ],
    ]);
  });

  it("resolves and logs one revoke_failed carrying the thrown error when the client throws", async () => {
    const error = new Error("boom");
    revoke.mockRejectedValue(error);

    await expect(revokeDocSyncAccess(TARGET)).resolves.toBeUndefined();

    expect(vi.mocked(log.error).mock.calls).toEqual([
      [
        "Doc sync revoke failed",
        {
          event: DOC_SYNC_REVOKE_FAILED_EVENT,
          target: TARGET,
          failure: DOC_SYNC_REVOKE_THREW,
          error,
        },
      ],
    ]);
  });
});
