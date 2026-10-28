import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/branch-activity-kind";
import { MonitoredTargetDisposition } from "@repo/api/src/types/monitored-activity-target";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { installDb } from "@/__tests__/support/agent-sessions/service.test-harness";
import {
  readSessionUntrackedRepositoryTargets,
  resetUnreadableUntrackedRepositoryRowEmissionBudget,
  SESSION_UNTRACKED_REPOSITORIES_READ_FAILED_EVENT,
  toSessionUntrackedRepositoryTargets,
  UNREADABLE_UNTRACKED_REPOSITORY_ROWS_EVENT,
} from "./session-untracked-repositories";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

const ORGANIZATION_ID = "org-1";
const SESSION_ARTIFACT_ID = "0199e7a2-0000-4000-a000-000000009182";

describe("toSessionUntrackedRepositoryTargets", () => {
  it("keeps a repository the org cannot track and drops one it can, per row", () => {
    const { targets } = toSessionUntrackedRepositoryTargets([
      prRow("r1", "prisma/prisma-engines", 5860, {
        disposition: MonitoredTargetDisposition.RepositoryOutOfScope,
      }),
      prRow("r2", "closedloop-ai/closedloop-ai", 12, {
        disposition: MonitoredTargetDisposition.IntentionallyAbsent,
      }),
      branchRow("r3", "acme/vendored", "fix/upstream", {
        disposition: MonitoredTargetDisposition.RepositoryUnfetchable,
      }),
    ]);

    expect(targets).toEqual([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/vendored",
        branchName: "fix/upstream",
        url: "https://github.com/acme/vendored/tree/fix%2Fupstream",
      },
      {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: "prisma/prisma-engines",
        prNumber: 5860,
        url: "https://github.com/prisma/prisma-engines/pull/5860",
      },
    ]);
  });

  it("excludes and counts a row whose disposition is absent or not one this build knows", () => {
    const result = toSessionUntrackedRepositoryTargets([
      prRow("r1", "prisma/prisma-engines", 1, { disposition: undefined }),
      prRow("r2", "prisma/prisma-engines", 2, {
        disposition: "repository_vanished",
      }),
      prRow("r3", "closedloop-ai/closedloop-ai", 12, {
        disposition: MonitoredTargetDisposition.IntentionallyAbsent,
      }),
    ]);

    expect(result).toEqual({ targets: [], unreadableRowCount: 2 });
  });

  it("renders repeated deliveries of one target once", () => {
    const { targets } = toSessionUntrackedRepositoryTargets([
      prRow("r1", "prisma/prisma-engines", 5860, {
        disposition: MonitoredTargetDisposition.RepositoryOutOfScope,
      }),
      prRow("r2", "Prisma/Prisma-Engines", 5860, {
        disposition: MonitoredTargetDisposition.RepositoryUnfetchable,
      }),
      prRow("r3", "prisma/prisma-engines", 5861, {
        disposition: MonitoredTargetDisposition.RepositoryOutOfScope,
      }),
    ]);

    expect(
      targets.map((target) =>
        target.kind === ArtifactRefTargetKind.PullRequest
          ? [target.repositoryFullName, target.prNumber]
          : [target.repositoryFullName, target.branchName]
      )
    ).toEqual([
      ["prisma/prisma-engines", 5860],
      ["prisma/prisma-engines", 5861],
    ]);
  });

  it("orders PR numbers numerically, not as strings", () => {
    const { targets } = toSessionUntrackedRepositoryTargets([
      prRow("r1", "prisma/prisma-engines", 10, {
        disposition: MonitoredTargetDisposition.RepositoryOutOfScope,
      }),
      prRow("r2", "prisma/prisma-engines", 9, {
        disposition: MonitoredTargetDisposition.RepositoryOutOfScope,
      }),
    ]);

    expect(
      targets.map((target) =>
        target.kind === ArtifactRefTargetKind.PullRequest ? target.prNumber : 0
      )
    ).toEqual([9, 10]);
  });

  it("omits the url when the row carries none, and when it is not the target's own", () => {
    const { targets } = toSessionUntrackedRepositoryTargets([
      prRow("r1", "..", 7, {
        disposition: MonitoredTargetDisposition.RepositoryOutOfScope,
        url: undefined,
      }),
      prRow("r2", "acme/other", 8, {
        disposition: MonitoredTargetDisposition.RepositoryOutOfScope,
        url: "https://evil.example/acme/other/pull/8",
      }),
    ]);

    expect(targets).toEqual([
      {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: "..",
        prNumber: 7,
      },
      {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: "acme/other",
        prNumber: 8,
      },
    ]);
  });
});

describe("readSessionUntrackedRepositoryTargets", () => {
  beforeEach(() => {
    vi.mocked(log.error).mockClear();
    vi.mocked(log.warn).mockClear();
    resetUnreadableUntrackedRepositoryRowEmissionBudget();
  });

  it("omits the field and reports a failed read instead of rejecting", async () => {
    installDb({
      $queryRaw: vi.fn().mockRejectedValue(new Error("pool timeout")),
    });

    await expect(
      readSessionUntrackedRepositoryTargets({
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: SESSION_ARTIFACT_ID,
      })
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      SESSION_UNTRACKED_REPOSITORIES_READ_FAILED_EVENT,
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        sessionId: SESSION_ARTIFACT_ID,
      })
    );
  });

  it("reports unreadable rows by count, once per org per window, and still serves the readable ones", async () => {
    installDb({
      $queryRaw: vi.fn().mockResolvedValue([
        { id: "r1", after: { kind: "not-a-kind" } },
        prRow("r2", "prisma/prisma-engines", 7, { disposition: undefined }),
        prRow("r3", "prisma/prisma-engines", 5860, {
          disposition: MonitoredTargetDisposition.RepositoryOutOfScope,
        }),
      ]),
    });
    const read = () =>
      readSessionUntrackedRepositoryTargets({
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: SESSION_ARTIFACT_ID,
      });

    const targets = await read();
    await read();

    expect(targets).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      UNREADABLE_UNTRACKED_REPOSITORY_ROWS_EVENT,
      {
        organizationId: ORGANIZATION_ID,
        sessionId: SESSION_ARTIFACT_ID,
        unreadableRows: 2,
      }
    );
  });

  it("reads the session's retained rows under one org-scoped predicate", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      prRow("r1", "prisma/prisma-engines", 5860, {
        disposition: MonitoredTargetDisposition.RepositoryOutOfScope,
      }),
    ]);
    installDb({ $queryRaw: queryRaw });

    const targets = await readSessionUntrackedRepositoryTargets({
      organizationId: ORGANIZATION_ID,
      sessionArtifactId: SESSION_ARTIFACT_ID,
    });

    expect(targets).toHaveLength(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const statement = z
      .object({ values: z.array(z.unknown()) })
      .parse(queryRaw.mock.calls[0]?.[0]);
    expect(statement.values).toContain(ORGANIZATION_ID);
    expect(statement.values).toContain(SESSION_ARTIFACT_ID);
  });

  it("returns nothing at all, and reports nothing, when no retained row qualifies", async () => {
    installDb({
      $queryRaw: vi.fn().mockResolvedValue([
        prRow("r1", "closedloop-ai/closedloop-ai", 12, {
          disposition: MonitoredTargetDisposition.IntentionallyAbsent,
        }),
      ]),
    });

    await expect(
      readSessionUntrackedRepositoryTargets({
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: SESSION_ARTIFACT_ID,
      })
    ).resolves.toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

function prRow(
  id: string,
  repositoryFullName: string,
  prNumber: number,
  overrides: { disposition: string | undefined; url?: string | undefined }
) {
  const url =
    "url" in overrides
      ? overrides.url
      : `https://github.com/${repositoryFullName}/pull/${prNumber}`;
  return {
    id,
    after: {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName,
      prNumber,
      ...(url === undefined ? {} : { url }),
      eventKind: MonitoredSessionActivityEventKind.AgentAction,
      occurredAt: "2026-08-31T15:25:46.000Z",
      completeness: BranchActivityEvidenceCompleteness.Complete,
      ...(overrides.disposition === undefined
        ? {}
        : { disposition: overrides.disposition }),
    },
  };
}

function branchRow(
  id: string,
  repositoryFullName: string,
  branchName: string,
  overrides: { disposition: string }
) {
  return {
    id,
    after: {
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName,
      branchName,
      url: `https://github.com/${repositoryFullName}/tree/${encodeURIComponent(branchName)}`,
      eventKind: MonitoredSessionActivityEventKind.AgentAction,
      occurredAt: "2026-08-31T15:25:46.000Z",
      completeness: BranchActivityEvidenceCompleteness.Complete,
      disposition: overrides.disposition,
    },
  };
}
