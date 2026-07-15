import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import {
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GitHubDirtyScopeKind,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
import { waitUntil } from "@vercel/functions";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dispatchRelayCommandToRelay } from "@/app/compute-targets/relay-command-helpers";
import {
  GITHUB_DIRTY_SCOPE_DEBOUNCE_MS,
  githubDirtyScopeService,
} from "@/app/integrations/github/dirty-scope-service";
import { desktopCommandStore } from "@/lib/desktop-command-store";

const mockState = vi.hoisted(() => ({
  rows: [] as DirtyScopeRow[],
  targets: [] as DirtyScopeTarget[],
  lockTail: Promise.resolve(),
  releaseLock: null as (() => void) | null,
}));

vi.mock("@repo/database", () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
  withDb: Object.assign(
    async (callback: (db: MockDb) => unknown) => callback(createMockDb()),
    {
      tx: async (callback: (tx: MockDb) => unknown) => {
        const db = createMockDb();
        try {
          return await callback(db);
        } finally {
          releaseAdvisoryLock();
        }
      },
    }
  ),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/lib/desktop-command-store", () => ({
  desktopCommandStore: {
    createCommand: vi.fn(),
  },
}));

vi.mock(
  "@/app/compute-targets/relay-command-helpers",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/app/compute-targets/relay-command-helpers")
      >();
    return {
      ...original,
      dispatchRelayCommandToRelay: vi.fn(),
    };
  }
);

describe("githubDirtyScopeService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockState.rows.length = 0;
    mockState.targets = [makeTarget("target-1")];
    mockState.lockTail = Promise.resolve();
    mockState.releaseLock = null;
    vi.mocked(desktopCommandStore.createCommand).mockImplementation(
      async (computeTargetId, input) => ({
        command: {
          commandId: "command-1",
          computeTargetId,
          operationId: input.operationId,
          status: DesktopCommandStatus.Queued,
          requestPayload: input,
          createdAt: new Date(),
          lastSequenceAcked: 0,
          requestFingerprint: "fingerprint-1",
          ...(input.idempotencyKey
            ? { idempotencyKey: input.idempotencyKey }
            : {}),
        },
        deduped: false,
      })
    );
    vi.mocked(dispatchRelayCommandToRelay).mockResolvedValue({
      delivered: false,
      reason: "no_subscriber",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("debounces webhook bursts into one merged dirty-scope command", async () => {
    const startedAt = new Date("2026-07-06T09:00:00.000Z");
    const secondAt = new Date(startedAt.getTime() + 1000);
    vi.setSystemTime(startedAt);

    const firstResult = await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      repositoryFullName: "closedloop-ai/symphony-alpha",
      scopes: [
        {
          kind: GitHubDirtyScopeKind.Branch,
          repositoryId: "repo-1",
          repositoryFullName: "closedloop-ai/symphony-alpha",
          branchName: "feat/one",
        },
      ],
      triggers: [GitHubDirtyTrigger.Push],
    });

    expect(firstResult).toEqual({ pendingRows: 1, dispatchedRows: 0 });
    expect(mockState.rows[0]?.scheduledDispatchAt.toISOString()).toBe(
      new Date(
        startedAt.getTime() + GITHUB_DIRTY_SCOPE_DEBOUNCE_MS
      ).toISOString()
    );
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();

    vi.setSystemTime(secondAt);
    await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      repositoryFullName: "closedloop-ai/symphony-alpha",
      scopes: [
        {
          kind: GitHubDirtyScopeKind.PullRequest,
          repositoryId: "repo-1",
          repositoryFullName: "closedloop-ai/symphony-alpha",
          branchName: "feat/one",
          pullRequestNumber: 42,
        },
      ],
      triggers: [GitHubDirtyTrigger.PullRequest],
    });

    expect(mockState.rows).toHaveLength(1);
    expect(mockState.rows[0]?.dirtyScopes).toHaveLength(2);
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();

    const dispatched = await githubDirtyScopeService.dispatchDue({
      now: new Date(startedAt.getTime() + GITHUB_DIRTY_SCOPE_DEBOUNCE_MS),
    });

    expect(dispatched).toBe(1);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledWith(
      "target-1",
      expect.objectContaining({
        operationId: GITHUB_RESYNC_NUDGE_OPERATION_ID,
        body: {
          scopes: [
            {
              kind: GitHubDirtyScopeKind.Branch,
              repositoryId: "repo-1",
              repositoryFullName: "closedloop-ai/symphony-alpha",
              branchName: "feat/one",
            },
            {
              kind: GitHubDirtyScopeKind.PullRequest,
              repositoryId: "repo-1",
              repositoryFullName: "closedloop-ai/symphony-alpha",
              branchName: "feat/one",
              pullRequestNumber: 42,
            },
          ],
          computeTargetId: "target-1",
          gatewayId: "target-1-gateway",
        },
        idempotencyKey: expect.stringContaining("github-resync:org-1:repo-1:"),
      })
    );
    expect(mockState.rows[0]?.deliveryResult).toEqual({
      delivered: false,
      reason: "no_subscriber",
      commandId: "command-1",
    });
  });

  test("targets ordinary online desktop targets that are not org-shared", async () => {
    mockState.targets = [makeTarget("target-1", { isSharedWithOrg: false })];
    const now = new Date("2026-07-06T09:00:30.000Z");
    vi.setSystemTime(now);

    const result = await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      scopes: [
        { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
      ],
      triggers: [GitHubDirtyTrigger.Push],
    });

    expect(result.pendingRows).toBe(1);
    expect(mockState.rows).toHaveLength(1);
  });

  test("keeps generic dirty scope terminal when later specific scopes arrive", async () => {
    const startedAt = new Date("2026-07-06T09:00:45.000Z");
    vi.setSystemTime(startedAt);

    await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      scopes: [{ kind: GitHubDirtyScopeKind.Generic }],
    });
    await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      scopes: [
        {
          kind: GitHubDirtyScopeKind.Branch,
          repositoryId: "repo-1",
          branchName: "feat/specific",
        },
      ],
    });

    expect(mockState.rows[0]?.dirtyScopes).toEqual([
      { kind: GitHubDirtyScopeKind.Generic },
    ]);

    await githubDirtyScopeService.dispatchDue({
      now: new Date(startedAt.getTime() + GITHUB_DIRTY_SCOPE_DEBOUNCE_MS),
    });

    expect(desktopCommandStore.createCommand).toHaveBeenCalledWith(
      "target-1",
      expect.objectContaining({
        body: expect.objectContaining({
          scopes: [{ kind: GitHubDirtyScopeKind.Generic }],
        }),
      })
    );
  });

  test("schedules due dispatch after the debounce window", async () => {
    const startedAt = new Date("2026-07-06T09:01:00.000Z");
    vi.setSystemTime(startedAt);

    await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      scopes: [
        { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
      ],
      triggers: [GitHubDirtyTrigger.InstallationRepositories],
    });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();

    const scheduledDispatch = vi.mocked(waitUntil).mock.calls[0]?.[0];
    await vi.advanceTimersByTimeAsync(GITHUB_DIRTY_SCOPE_DEBOUNCE_MS);
    await scheduledDispatch;

    expect(desktopCommandStore.createCommand).toHaveBeenCalledTimes(1);
    expect(mockState.rows[0]?.dispatchedAt).toBeInstanceOf(Date);
  });

  test("drains pending due rows for a reconnecting desktop target", async () => {
    const startedAt = new Date("2026-07-06T09:01:30.000Z");
    vi.setSystemTime(startedAt);

    await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      scopes: [
        { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
      ],
      triggers: [GitHubDirtyTrigger.InstallationRepositories],
    });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();

    const dispatched = await githubDirtyScopeService.dispatchDue({
      computeTargetId: "target-1",
      organizationId: "org-1",
      now: new Date(startedAt.getTime() + GITHUB_DIRTY_SCOPE_DEBOUNCE_MS),
    });

    expect(dispatched).toBe(1);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledTimes(1);
    expect(mockState.rows[0]?.dispatchedAt).toBeInstanceOf(Date);
  });

  test("dispatches one command per eligible desktop and downgrades malformed persisted scopes", async () => {
    mockState.targets = [makeTarget("target-1"), makeTarget("target-2")];
    const now = new Date("2026-07-06T09:02:00.000Z");
    vi.setSystemTime(now);

    await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      scopes: [
        { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
      ],
    });
    mockState.rows[1]!.dirtyScopes = [{ kind: "future_scope" }];

    const dispatched = await githubDirtyScopeService.dispatchDue({
      now: new Date(now.getTime() + GITHUB_DIRTY_SCOPE_DEBOUNCE_MS),
    });

    expect(dispatched).toBe(2);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(desktopCommandStore.createCommand).mock.calls[1]?.[1].body
    ).toEqual({
      scopes: [{ kind: GitHubDirtyScopeKind.Generic }],
      computeTargetId: "target-2",
      gatewayId: "target-2-gateway",
    });
  });

  test("serializes concurrent same-window publishes before merging scopes", async () => {
    const startedAt = new Date("2026-07-06T09:03:00.000Z");
    vi.setSystemTime(startedAt);

    await Promise.all([
      githubDirtyScopeService.publish({
        organizationId: "org-1",
        repositoryId: "repo-1",
        scopes: [
          {
            kind: GitHubDirtyScopeKind.Branch,
            repositoryId: "repo-1",
            branchName: "feat/one",
          },
        ],
      }),
      githubDirtyScopeService.publish({
        organizationId: "org-1",
        repositoryId: "repo-1",
        scopes: [
          {
            kind: GitHubDirtyScopeKind.PullRequest,
            repositoryId: "repo-1",
            branchName: "feat/one",
            pullRequestNumber: 42,
          },
        ],
      }),
    ]);

    expect(mockState.rows).toHaveLength(1);
    expect(mockState.rows[0]?.dirtyScopes).toEqual([
      {
        kind: GitHubDirtyScopeKind.Branch,
        repositoryId: "repo-1",
        branchName: "feat/one",
      },
      {
        kind: GitHubDirtyScopeKind.PullRequest,
        repositoryId: "repo-1",
        branchName: "feat/one",
        pullRequestNumber: 42,
      },
    ]);
  });

  test("claims due rows before dispatch so concurrent drains send one command", async () => {
    const now = new Date("2026-07-06T09:04:00.000Z");
    mockState.rows.push(
      makeDirtyScopeRow({
        id: "row-due",
        scheduledDispatchAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      })
    );

    const [first, second] = await Promise.all([
      githubDirtyScopeService.dispatchDue({ now }),
      githubDirtyScopeService.dispatchDue({ now }),
    ]);

    expect(first + second).toBe(1);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledTimes(1);
    expect(mockState.rows[0]?.deliveryResult).toEqual({
      delivered: false,
      reason: "no_subscriber",
      commandId: "command-1",
    });
  });

  test("releases a dispatch claim when command creation fails before retrying", async () => {
    const now = new Date("2026-07-06T09:04:30.000Z");
    mockState.rows.push(
      makeDirtyScopeRow({
        id: "row-retry",
        scheduledDispatchAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      })
    );
    vi.mocked(desktopCommandStore.createCommand)
      .mockRejectedValueOnce(new Error("command store unavailable"))
      .mockImplementationOnce(async (computeTargetId, input) => ({
        command: {
          commandId: "command-2",
          computeTargetId,
          operationId: input.operationId,
          status: DesktopCommandStatus.Queued,
          requestPayload: input,
          createdAt: new Date(),
          lastSequenceAcked: 0,
          requestFingerprint: "fingerprint-2",
          ...(input.idempotencyKey
            ? { idempotencyKey: input.idempotencyKey }
            : {}),
        },
        deduped: false,
      }));

    const failedDispatch = await githubDirtyScopeService.dispatchDue({ now });

    expect(failedDispatch).toBe(0);
    expect(mockState.rows[0]).toMatchObject({
      dispatchedAt: null,
      dispatchClaimedAt: null,
      deliveryResult: {
        delivered: false,
        reason: "command store unavailable",
      },
    });

    const retriedDispatch = await githubDirtyScopeService.dispatchDue({
      now: new Date(now.getTime() + 1000),
    });

    expect(retriedDispatch).toBe(1);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledTimes(2);
    expect(mockState.rows[0]?.deliveryResult).toEqual({
      delivered: false,
      reason: "no_subscriber",
      commandId: "command-2",
    });
  });

  test("continues draining after the first due-row page", async () => {
    const now = new Date("2026-07-06T09:05:00.000Z");
    for (let index = 0; index < 101; index += 1) {
      mockState.rows.push(
        makeDirtyScopeRow({
          id: `row-${index}`,
          computeTargetId: `target-${index}`,
          scheduledDispatchAt: now,
          expiresAt: new Date(now.getTime() + 60_000),
        })
      );
      mockState.targets.push(makeTarget(`target-${index}`));
    }

    const dispatched = await githubDirtyScopeService.dispatchDue({ now });

    expect(dispatched).toBe(101);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledTimes(101);
  });

  test("stops draining when a full due-row page makes no forward progress", async () => {
    const now = new Date("2026-07-06T09:05:30.000Z");
    for (let index = 0; index < 100; index += 1) {
      mockState.rows.push(
        makeDirtyScopeRow({
          id: `row-failed-${index}`,
          computeTargetId: `target-${index}`,
          scheduledDispatchAt: now,
          expiresAt: new Date(now.getTime() + 60_000),
        })
      );
      mockState.targets.push(makeTarget(`target-${index}`));
    }
    vi.mocked(desktopCommandStore.createCommand).mockRejectedValue(
      new Error("dispatch failed")
    );

    const dispatched = await githubDirtyScopeService.dispatchDue({ now });

    expect(dispatched).toBe(0);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledTimes(100);
    expect(mockState.rows.every((row) => row.dispatchClaimedAt === null)).toBe(
      true
    );
  });

  test("cleans up expired dispatched and undispatched rows", async () => {
    const now = new Date("2026-07-06T09:06:00.000Z");
    vi.setSystemTime(now);
    mockState.rows.push(
      makeDirtyScopeRow({
        id: "expired-pending",
        expiresAt: new Date(now.getTime() - 1000),
      }),
      makeDirtyScopeRow({
        id: "expired-dispatched",
        dispatchedAt: new Date(now.getTime() - 2000),
        expiresAt: new Date(now.getTime() - 1000),
      }),
      makeDirtyScopeRow({
        id: "fresh-dispatched",
        dispatchedAt: new Date(now.getTime() - 1000),
        expiresAt: new Date(now.getTime() + 60_000),
      })
    );

    await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      scopes: [
        { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
      ],
    });

    expect(mockState.rows.map((row) => row.id)).not.toContain(
      "expired-pending"
    );
    expect(mockState.rows.map((row) => row.id)).not.toContain(
      "expired-dispatched"
    );
    expect(mockState.rows.map((row) => row.id)).toContain("fresh-dispatched");
  });
});

function createMockDb(): MockDb {
  const db: MockDb = {
    $executeRaw: vi.fn(async () => {
      await acquireAdvisoryLock();
      return 1;
    }),
    computeTarget: {
      findMany: vi.fn(({ where }: ComputeTargetFindManyArgs) =>
        Promise.resolve(
          mockState.targets.filter(
            (target) =>
              target.isOnline === where.isOnline &&
              (!Object.hasOwn(where, "isSharedWithOrg") ||
                target.isSharedWithOrg === where.isSharedWithOrg)
          )
        )
      ),
    },
    gitHubDirtyScopeNudge: {
      deleteMany: vi.fn(({ where }: DeleteManyArgs) => {
        const before = mockState.rows.length;
        const retained = mockState.rows.filter(
          (row) => !(where.expiresAt && row.expiresAt < where.expiresAt.lt)
        );
        mockState.rows.splice(0, mockState.rows.length, ...retained);
        return { count: before - retained.length };
      }),
      findUnique: vi.fn(
        async ({ where }: FindUniqueArgs) =>
          mockState.rows.find((row) => rowMatchesUnique(row, where)) ?? null
      ),
      upsert: vi.fn(({ create, update, where }: UpsertArgs) => {
        const existing = mockState.rows.find((row) =>
          rowMatchesUnique(row, where)
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: DirtyScopeRow = {
          id: `row-${mockState.rows.length + 1}`,
          organizationId: create.organizationId,
          githubInstallationRepositoryId: create.githubInstallationRepositoryId,
          computeTargetId: create.computeTargetId,
          windowStartedAt: create.windowStartedAt,
          dirtyScopes: create.dirtyScopes,
          genericRefresh: create.genericRefresh,
          scheduledDispatchAt: create.scheduledDispatchAt,
          dispatchClaimedAt: null,
          dispatchedAt: null,
          expiresAt: create.expiresAt,
          deliveryResult: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        mockState.rows.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where }: FindManyArgs) =>
        mockState.rows
          .filter(
            (row) =>
              row.dispatchedAt === null &&
              isUnclaimedOrStale(row, where.OR) &&
              row.scheduledDispatchAt <= where.scheduledDispatchAt.lte &&
              row.expiresAt > where.expiresAt.gt &&
              (!where.computeTargetId ||
                row.computeTargetId === where.computeTargetId) &&
              (!where.organizationId ||
                row.organizationId === where.organizationId) &&
              (!where.githubInstallationRepositoryId ||
                row.githubInstallationRepositoryId ===
                  where.githubInstallationRepositoryId)
          )
          .slice(0, 100)
          .map((row) => ({
            ...row,
            computeTarget: {
              gatewayId:
                mockState.targets.find(
                  (target) => target.id === row.computeTargetId
                )?.gatewayId ?? null,
            },
          }))
      ),
      updateMany: vi.fn(({ where, data }: UpdateManyArgs) => {
        let count = 0;
        for (const row of mockState.rows) {
          if (!rowMatchesWhere(row, where)) {
            continue;
          }
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      }),
      update: vi.fn(({ where, data }: UpdateArgs) => {
        const row = mockState.rows.find(
          (candidate) => candidate.id === where.id
        );
        if (!row) {
          throw new Error("row not found");
        }
        Object.assign(row, data);
        return row;
      }),
    },
  };
  return db;
}

function makeTarget(
  id: string,
  overrides: Partial<DirtyScopeTarget> = {}
): DirtyScopeTarget {
  return {
    id,
    gatewayId: `${id}-gateway`,
    isOnline: true,
    isSharedWithOrg: true,
    supportedOperations: [GITHUB_RESYNC_NUDGE_OPERATION_ID],
    ...overrides,
  };
}

function rowMatchesUnique(row: DirtyScopeRow, where: UniqueWhere): boolean {
  const key =
    where.organizationId_githubInstallationRepositoryId_computeTargetId_windowStartedAt;
  return (
    row.organizationId === key.organizationId &&
    row.githubInstallationRepositoryId === key.githubInstallationRepositoryId &&
    row.computeTargetId === key.computeTargetId &&
    row.windowStartedAt.getTime() === key.windowStartedAt.getTime()
  );
}

function rowMatchesWhere(row: DirtyScopeRow, where: UpdateManyWhere): boolean {
  if (where.id && row.id !== where.id) {
    return false;
  }
  if (
    Object.hasOwn(where, "dispatchedAt") &&
    row.dispatchedAt !== where.dispatchedAt
  ) {
    return false;
  }
  if (where.OR && !isUnclaimedOrStale(row, where.OR)) {
    return false;
  }
  if (
    where.scheduledDispatchAt &&
    row.scheduledDispatchAt > where.scheduledDispatchAt.lte
  ) {
    return false;
  }
  if (where.expiresAt && row.expiresAt <= where.expiresAt.gt) {
    return false;
  }
  return true;
}

function isUnclaimedOrStale(
  row: DirtyScopeRow,
  clauses: DirtyScopeClaimWhere[] | undefined
): boolean {
  if (!clauses) {
    return true;
  }
  return clauses.some((clause) => {
    if (
      Object.hasOwn(clause, "dispatchClaimedAt") &&
      clause.dispatchClaimedAt === null
    ) {
      return row.dispatchClaimedAt === null;
    }
    return Boolean(
      clause.dispatchClaimedAt?.lt &&
        row.dispatchClaimedAt &&
        row.dispatchClaimedAt < clause.dispatchClaimedAt.lt
    );
  });
}

function makeDirtyScopeRow(
  overrides: Partial<DirtyScopeRow> = {}
): DirtyScopeRow {
  const now = new Date("2026-07-06T09:00:00.000Z");
  return {
    id: "row-manual",
    organizationId: "org-1",
    githubInstallationRepositoryId: "repo-1",
    computeTargetId: "target-1",
    windowStartedAt: now,
    dirtyScopes: [
      { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
    ],
    genericRefresh: false,
    scheduledDispatchAt: now,
    dispatchClaimedAt: null,
    dispatchedAt: null,
    expiresAt: new Date(now.getTime() + 60_000),
    deliveryResult: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function acquireAdvisoryLock(): Promise<void> {
  const previous = mockState.lockTail;
  let releaseNext: () => void = () => {};
  mockState.lockTail = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  await previous;
  mockState.releaseLock = releaseNext;
}

function releaseAdvisoryLock(): void {
  const release = mockState.releaseLock;
  mockState.releaseLock = null;
  release?.();
}

type DirtyScopeTarget = {
  id: string;
  gatewayId: string | null;
  isOnline: boolean;
  isSharedWithOrg: boolean;
  supportedOperations: unknown;
};

type DirtyScopeRow = {
  id: string;
  organizationId: string;
  githubInstallationRepositoryId: string;
  computeTargetId: string;
  windowStartedAt: Date;
  dirtyScopes: unknown;
  genericRefresh: boolean;
  scheduledDispatchAt: Date;
  dispatchClaimedAt: Date | null;
  dispatchedAt: Date | null;
  expiresAt: Date;
  deliveryResult: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type UniqueWhere = {
  organizationId_githubInstallationRepositoryId_computeTargetId_windowStartedAt: {
    organizationId: string;
    githubInstallationRepositoryId: string;
    computeTargetId: string;
    windowStartedAt: Date;
  };
};

type FindUniqueArgs = { where: UniqueWhere };
type UpsertArgs = {
  where: UniqueWhere;
  create: Omit<
    DirtyScopeRow,
    | "id"
    | "dispatchClaimedAt"
    | "dispatchedAt"
    | "deliveryResult"
    | "createdAt"
    | "updatedAt"
  >;
  update: Partial<DirtyScopeRow>;
};
type FindManyArgs = {
  where: {
    computeTargetId?: string;
    organizationId?: string;
    githubInstallationRepositoryId?: string;
    OR?: DirtyScopeClaimWhere[];
    scheduledDispatchAt: { lte: Date };
    expiresAt: { gt: Date };
  };
};
type ComputeTargetFindManyArgs = {
  where: {
    isOnline: boolean;
    isSharedWithOrg?: boolean;
    organizationId: string;
  };
};
type DeleteManyArgs = {
  where: {
    expiresAt?: { lt: Date };
  };
};
type UpdateManyWhere = {
  id?: string;
  dispatchedAt?: Date | null;
  OR?: DirtyScopeClaimWhere[];
  scheduledDispatchAt?: { lte: Date };
  expiresAt?: { gt: Date };
};
type DirtyScopeClaimWhere = {
  dispatchClaimedAt: null | { lt: Date };
};
type UpdateManyArgs = {
  where: UpdateManyWhere;
  data: Partial<DirtyScopeRow>;
};
type UpdateArgs = {
  where: { id: string };
  data: Partial<DirtyScopeRow>;
};
type MockDb = {
  $executeRaw: ReturnType<typeof vi.fn>;
  computeTarget: {
    findMany: ReturnType<typeof vi.fn>;
  };
  gitHubDirtyScopeNudge: {
    deleteMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};
