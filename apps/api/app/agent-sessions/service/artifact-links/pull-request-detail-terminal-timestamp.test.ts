/**
 * ISS-8547 review — the §3 degrade must not be silent.
 *
 * `storableSyncTimestampSchema` degrades an instant Postgres cannot hold to
 * absent rather than rejecting, because a sync batch is one `safeParse` and
 * rejecting would 400 up to 200 sessions on one bad date. Right failure mode,
 * but it left NO signal: a `pull_request` ref still writes `prState = MERGED`
 * while `mergedAt` stays null, and `isOrgMergedPullRequestDetail` requires a
 * non-null `mergedAt`, so the PR silently drops out of the org-merged population
 * and the delivery metrics.
 *
 * These pin the monitored warning at the cloud's write boundary. The schema
 * itself cannot log — the desktop parses it too — and the range half is pinned
 * separately in `packages/api/src/types/__tests__/sync-timestamp.test.ts`; this
 * file owns only the "this PR will not be counted" signal.
 */

import { GitHubPRState } from "@repo/api/src/types/github";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installPrDetailIngestDb,
  prDetailRef as prRef,
  syncPrDetailRefs,
} from "@/__tests__/support/agent-sessions/service.test-harness-pr-detail";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const WARNING = "session.artifact_ref.terminal_state_without_timestamp";
const MERGED_AT = "2026-08-30T00:00:00.000Z";

describe("terminal PR state with no timestamp is reported (ISS-8547)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("warns when a MERGED ref carries no mergedAt", async () => {
    installPrDetailIngestDb({});

    await syncPrDetailRefs([prRef({ state: GitHubPRState.Merged })]);

    expect(log.warn).toHaveBeenCalledWith(
      WARNING,
      expect.objectContaining({
        prNumber: 42,
        prState: GitHubPRState.Merged,
        repositoryFullName: "acme/web",
      })
    );
  });

  // The mutation this kills is an UNCONDITIONAL log: a merged PR that carries
  // its timestamp is counted normally and is not a defect.
  it("stays silent when a MERGED ref carries its mergedAt", async () => {
    installPrDetailIngestDb({});

    await syncPrDetailRefs([
      prRef({ mergedAt: MERGED_AT, state: GitHubPRState.Merged }),
    ]);

    expect(log.warn).not.toHaveBeenCalledWith(WARNING, expect.anything());
  });

  // A non-terminal PR has no merge instant to be missing, so warning on it would
  // fire on the ordinary path and bury the real signal.
  it("stays silent for an OPEN ref with no mergedAt", async () => {
    installPrDetailIngestDb({});

    await syncPrDetailRefs([prRef({ state: GitHubPRState.Open })]);

    expect(log.warn).not.toHaveBeenCalledWith(WARNING, expect.anything());
  });
});
