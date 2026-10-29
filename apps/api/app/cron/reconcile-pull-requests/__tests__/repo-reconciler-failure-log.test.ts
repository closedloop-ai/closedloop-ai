import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

import { withDb } from "@repo/database";
import { GitHubProviderResultStatus } from "@repo/github";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  computeNextRetryAt,
} from "@/lib/github/github-retry-backoff";
import {
  persistFailureSettlement,
  RECONCILE_UNEXPECTED_FAILURE_REASON,
} from "../repo-reconciler";

/**
 * ISS-7875: the settlement's log line is the ONLY record a handled per-repo
 * failure leaves. `reposFailed` in the sweep summary is per-tick, so a repo that
 * has backed off past the selection window stops being counted and its cause
 * ages out — which is exactly how two stage repos reached eight consecutive
 * failures with no recoverable reason.
 */

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};

const NOW = new Date("2026-08-24T12:00:00.000Z");
const TARGET = {
  organizationId: "org-1",
  repositoryFullName: "acme/widgets",
  consecutiveFailureCount: 0,
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) =>
    fn({
      gitHubRepoSyncState: {
        updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
      },
    })
  );
  warn = vi.spyOn(log, "warn").mockImplementation(() => {
    // The assertion target; silenced so a failing suite stays readable.
  });
});

function lastWarnPayload(): Record<string, unknown> {
  return warn.mock.calls.at(-1)?.[1] as Record<string, unknown>;
}

describe("persistFailureSettlement failure log", () => {
  it("names the reason its caller classified, verbatim", async () => {
    await persistFailureSettlement(TARGET, NOW, {
      stampSwept: true,
      reason: GitHubProviderResultStatus.ProviderRateLimit,
    });

    expect(lastWarnPayload()).toMatchObject({
      organizationId: "org-1",
      repositoryFullName: "acme/widgets",
      reason: GitHubProviderResultStatus.ProviderRateLimit,
    });
  });

  it("carries the resulting count and window, so one line answers how stuck and until when", async () => {
    await persistFailureSettlement(
      { ...TARGET, consecutiveFailureCount: 2 },
      NOW,
      { stampSwept: true, reason: RECONCILE_UNEXPECTED_FAILURE_REASON }
    );

    expect(lastWarnPayload()).toMatchObject({
      consecutiveFailureCount: 3,
      nextRetryAt: computeNextRetryAt(3, NOW).toISOString(),
    });
  });

  it("reports atBackoffCeiling false while the window is still growing", async () => {
    await persistFailureSettlement(TARGET, NOW, {
      stampSwept: true,
      reason: GitHubProviderResultStatus.ProviderUnavailable,
    });

    // First failure: one base window, nowhere near the cap.
    expect(computeNextRetryAt(1, NOW).getTime() - NOW.getTime()).toBe(
      BACKOFF_BASE_MS
    );
    expect(lastWarnPayload()).toMatchObject({ atBackoffCeiling: false });
  });

  it("reports atBackoffCeiling true once the window saturates", async () => {
    // Derived, not hand-picked: the first count whose exponential window is
    // clamped by BACKOFF_MAX_MS. Pinning a literal here would silently stop
    // meaning "saturated" the moment the curve changes.
    let saturatedCount = 1;
    while (
      computeNextRetryAt(saturatedCount, NOW).getTime() - NOW.getTime() <
      BACKOFF_MAX_MS
    ) {
      saturatedCount += 1;
    }

    await persistFailureSettlement(
      { ...TARGET, consecutiveFailureCount: saturatedCount - 1 },
      NOW,
      {
        stampSwept: true,
        reason: GitHubProviderResultStatus.ProviderUnavailable,
      }
    );

    expect(lastWarnPayload()).toMatchObject({
      consecutiveFailureCount: saturatedCount,
      atBackoffCeiling: true,
    });
  });
});
