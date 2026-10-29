import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import {
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GitHubDirtyScopeKind,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
import {
  RelayDispatchDiagnosticReason,
  RelayDispatchReason,
} from "@repo/api/src/types/relay-dispatch";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  DirtyScopeRow,
  DirtyScopeTarget,
  MockDb,
} from "@/__tests__/support/integrations/github/dirty-scope-service.test-mocks";
import {
  createMockDb,
  makeDirtyScopeRow,
  makeTarget,
} from "@/__tests__/support/integrations/github/dirty-scope-service.test-mocks";
import { dispatchRelayCommandToRelay } from "@/app/compute-targets/relay-command-helpers";
import {
  GITHUB_DIRTY_SCOPE_DEBOUNCE_MS,
  GITHUB_DIRTY_SCOPE_DESKTOP_RATE_LIMIT_MS,
  GITHUB_DIRTY_SCOPE_RETRY_BACKOFF_MS,
  GITHUB_DIRTY_SCOPE_UPSERT_CHUNK_SIZE,
  githubDirtyScopeService,
} from "@/app/integrations/github/dirty-scope-service";
import { desktopCommandStore } from "@/lib/desktop-command-store";

const mockState = vi.hoisted(() => ({
  rows: [] as DirtyScopeRow[],
  targets: [] as DirtyScopeTarget[],
  // Keyed by the advisory-lock argument, so the mock only serializes writers
  // that ask for the SAME key — a lock key that stopped covering the row set
  // would show up as lost merges, and one that over-serializes would show up as
  // unrelated repositories queueing behind each other (ISS-7276).
  lockTails: new Map<string, Promise<void>>(),
  // Every key asked for, in acquisition order: the rollout-compatible key
  // shape is only observable here (ISS-7276).
  lockKeys: [] as string[],
  // Counted across every mock client (one is built per `withDb` call), so a
  // fan-out's total round trips are observable — not just one call's (ISS-7276).
  counts: {
    targetReads: 0,
    expirySweeps: 0,
    writeTransactions: 0,
    // Every statement against the nudge table, so a drain page's cost is
    // measured rather than inferred from the shape of the code (ISS-8973).
    nudgeStatements: 0,
    // Locks HELD, not transactions open: a writer blocked on the advisory lock
    // is already inside its transaction, so only this distinguishes a lock key
    // that scopes to the row set from one that over-serializes.
    heldLocks: 0,
    peakHeldLocks: 0,
  },
}));

vi.mock("@repo/database", () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
  withDb: Object.assign(
    async (callback: (db: MockDb) => unknown) =>
      callback(createMockDb(mockState, [])),
    {
      tx: async (callback: (tx: MockDb) => unknown) => {
        const heldLocks: Array<() => void> = [];
        const db = createMockDb(mockState, heldLocks);
        mockState.counts.writeTransactions += 1;
        const snapshot = mockState.rows.map((row) => ({ ...row }));
        try {
          return await callback(db);
        } catch (error) {
          // A constraint violation aborts the whole transaction, so nothing the
          // chunk wrote before it survives.
          mockState.rows.splice(0, mockState.rows.length, ...snapshot);
          throw error;
        } finally {
          for (const release of heldLocks.splice(0)) {
            release();
          }
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

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
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
    mockState.lockTails.clear();
    mockState.lockKeys.length = 0;
    mockState.counts = {
      targetReads: 0,
      expirySweeps: 0,
      writeTransactions: 0,
      nudgeStatements: 0,
      heldLocks: 0,
      peakHeldLocks: 0,
    };
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
      repositoryFullName: "closedloop-ai/closedloop-ai",
      scopes: [
        {
          kind: GitHubDirtyScopeKind.Branch,
          repositoryId: "repo-1",
          repositoryFullName: "closedloop-ai/closedloop-ai",
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
      repositoryFullName: "closedloop-ai/closedloop-ai",
      scopes: [
        {
          kind: GitHubDirtyScopeKind.PullRequest,
          repositoryId: "repo-1",
          repositoryFullName: "closedloop-ai/closedloop-ai",
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
              repositoryFullName: "closedloop-ai/closedloop-ai",
              branchName: "feat/one",
            },
            {
              kind: GitHubDirtyScopeKind.PullRequest,
              repositoryId: "repo-1",
              repositoryFullName: "closedloop-ai/closedloop-ai",
              branchName: "feat/one",
              pullRequestNumber: 42,
            },
          ],
          computeTargetId: "target-1",
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

  test("persists relay diagnostics with dirty-scope dispatch results", async () => {
    const now = new Date("2026-07-06T09:00:40.000Z");
    // The drain's claim lease is anchored on the `now` it is handed, and spent
    // against the wall clock. A fixture `now` with the clock left at real time
    // is a lease years overdue, so the page releases before its first row —
    // pin them together in every drain case below.
    vi.setSystemTime(now);
    mockState.rows.push(
      makeDirtyScopeRow({
        id: "row-diagnostic",
        scheduledDispatchAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      })
    );
    vi.mocked(dispatchRelayCommandToRelay).mockResolvedValue({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerHttpNotOk,
      peerStatusCode: 503,
      peerErrorCode: "ECONNRESET",
    });

    const dispatched = await githubDirtyScopeService.dispatchDue({ now });

    expect(dispatched).toBe(1);
    expect(mockState.rows[0]?.deliveryResult).toEqual({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
      diagnosticReason: RelayDispatchDiagnosticReason.PeerHttpNotOk,
      peerStatusCode: 503,
      peerErrorCode: "ECONNRESET",
      commandId: "command-1",
    });
    expect(log.info).toHaveBeenCalledWith(
      "[githubDirtyScopeService] GitHub resync nudge not delivered",
      expect.objectContaining({
        commandId: "command-1",
        computeTargetId: "target-1",
        diagnosticReason: RelayDispatchDiagnosticReason.PeerHttpNotOk,
        peerErrorCode: "ECONNRESET",
        peerStatusCode: 503,
        reason: RelayDispatchReason.TargetNotConnected,
      })
    );
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
    vi.setSystemTime(now);
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

  test("releases a dispatch claim when command creation fails, and retries it a backoff later", async () => {
    // The claim is released so the row stays due, but its next attempt is
    // deferred by `GITHUB_DIRTY_SCOPE_RETRY_BACKOFF_MS` rather than landing on
    // the very next drain (ISS-10050): a row that was attempted and failed must
    // fall behind the peers it ties with on `createdAt` instead of re-filling
    // the page ahead of them. Both halves are pinned below — the drain inside
    // the backoff must NOT retry it, and the drain after it must.
    const now = new Date("2026-07-06T09:04:30.000Z");
    vi.setSystemTime(now);
    mockState.rows.push(
      makeDirtyScopeRow({
        id: "row-retry",
        scheduledDispatchAt: now,
        // Outlives the backoff, so the retry below is a real retry rather than
        // an expiry the sweep would have taken anyway.
        expiresAt: new Date(
          now.getTime() + GITHUB_DIRTY_SCOPE_RETRY_BACKOFF_MS + 60_000
        ),
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

    // Deferred: still due eventually, but not on a drain one second later.
    expect(mockState.rows[0]?.scheduledDispatchAt).toEqual(
      new Date(now.getTime() + GITHUB_DIRTY_SCOPE_RETRY_BACKOFF_MS)
    );
    const insideBackoff = await githubDirtyScopeService.dispatchDue({
      now: new Date(now.getTime() + 1000),
    });

    expect(insideBackoff).toBe(0);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledTimes(1);

    const retriedDispatch = await githubDirtyScopeService.dispatchDue({
      now: new Date(now.getTime() + GITHUB_DIRTY_SCOPE_RETRY_BACKOFF_MS + 1000),
    });

    expect(retriedDispatch).toBe(1);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledTimes(2);
    expect(mockState.rows[0]?.deliveryResult).toEqual({
      delivered: false,
      reason: "no_subscriber",
      commandId: "command-2",
    });
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

  test("writes every eligible target's pending row in one transaction", async () => {
    mockState.targets = [
      makeTarget("target-1"),
      makeTarget("target-2"),
      makeTarget("target-3"),
    ];
    vi.setSystemTime(new Date("2026-07-06T09:07:00.000Z"));

    const result = await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      scopes: [
        { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
      ],
    });

    expect(result.pendingRows).toBe(3);
    expect(mockState.rows).toHaveLength(3);
    // One set-based upsert, not one transaction per target (ISS-7276).
    expect(mockState.counts.writeTransactions).toBe(1);
  });

  test("merges into existing rows without re-opening a transaction per target", async () => {
    mockState.targets = [makeTarget("target-1"), makeTarget("target-2")];
    vi.setSystemTime(new Date("2026-07-06T09:07:15.000Z"));

    await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      scopes: [
        {
          kind: GitHubDirtyScopeKind.Branch,
          repositoryId: "repo-1",
          branchName: "feat/one",
        },
      ],
    });
    mockState.counts.writeTransactions = 0;

    await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      scopes: [
        {
          kind: GitHubDirtyScopeKind.Branch,
          repositoryId: "repo-1",
          branchName: "feat/two",
        },
      ],
    });

    expect(mockState.counts.writeTransactions).toBe(1);
    expect(mockState.rows).toHaveLength(2);
    for (const row of mockState.rows) {
      expect(row.dirtyScopes).toEqual([
        {
          kind: GitHubDirtyScopeKind.Branch,
          repositoryId: "repo-1",
          branchName: "feat/one",
        },
        {
          kind: GitHubDirtyScopeKind.Branch,
          repositoryId: "repo-1",
          branchName: "feat/two",
        },
      ]);
    }
  });

  test("reuses a prepared batch so a fan-out reads targets and sweeps expiry once", async () => {
    mockState.targets = [makeTarget("target-1"), makeTarget("target-2")];
    vi.setSystemTime(new Date("2026-07-06T09:07:30.000Z"));

    const batch = await githubDirtyScopeService.prepareBatch("org-1");

    expect(mockState.counts.targetReads).toBe(1);
    expect(mockState.counts.expirySweeps).toBe(1);

    for (const repositoryId of ["repo-1", "repo-2", "repo-3"]) {
      await githubDirtyScopeService.publish(
        {
          organizationId: "org-1",
          repositoryId,
          scopes: [{ kind: GitHubDirtyScopeKind.Repository, repositoryId }],
        },
        batch
      );
    }

    // Still once, not once per repository — the whole point of the batch.
    expect(mockState.counts.targetReads).toBe(1);
    expect(mockState.counts.expirySweeps).toBe(1);
    expect(mockState.rows).toHaveLength(6);
  });

  test("does not serialize publishes that touch different repositories", async () => {
    // Sibling of the same-window serialization test above: the advisory lock
    // must cover the (org, repo, window) row set and no more. A key that
    // over-serialized — one constant per org, say — would still merge correctly
    // and so would pass that test, while queueing every repository of an
    // installation_repositories fan-out behind one lock.
    vi.setSystemTime(new Date("2026-07-06T09:07:45.000Z"));

    await Promise.all([
      githubDirtyScopeService.publish({
        organizationId: "org-1",
        repositoryId: "repo-1",
        scopes: [
          { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
        ],
      }),
      githubDirtyScopeService.publish({
        organizationId: "org-1",
        repositoryId: "repo-2",
        scopes: [
          { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-2" },
        ],
      }),
    ]);

    expect(mockState.counts.peakHeldLocks).toBe(2);
    expect(mockState.rows).toHaveLength(2);
  });

  test("writes every target when the eligible set spans more than one chunk", async () => {
    // Sized off the bound, not hardcoded: the chunk split only runs when the
    // eligible set exceeds it, which is the "hundreds of desktops" case.
    const targetCount = GITHUB_DIRTY_SCOPE_UPSERT_CHUNK_SIZE + 1;
    mockState.targets = Array.from({ length: targetCount }, (_, index) =>
      makeTarget(`target-${index}`)
    );
    vi.setSystemTime(new Date("2026-07-06T09:07:55.000Z"));

    const result = await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      scopes: [
        { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
      ],
    });

    expect(result.pendingRows).toBe(targetCount);
    expect(mockState.counts.writeTransactions).toBe(2);
    expect(new Set(mockState.rows.map((row) => row.computeTargetId)).size).toBe(
      targetCount
    );
  });

  test("ignores a batch prepared for another organization", async () => {
    mockState.targets = [makeTarget("target-1")];
    vi.setSystemTime(new Date("2026-07-06T09:08:00.000Z"));

    const batch = await githubDirtyScopeService.prepareBatch("org-2");
    mockState.counts.targetReads = 0;

    const result = await githubDirtyScopeService.publish(
      {
        organizationId: "org-1",
        repositoryId: "repo-1",
        scopes: [
          { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
        ],
      },
      batch
    );

    expect(mockState.counts.targetReads).toBe(1);
    expect(result.pendingRows).toBe(1);
    expect(mockState.rows).toHaveLength(1);
    expect(mockState.rows[0]?.organizationId).toBe("org-1");
  });

  test("locks every target on the pre-batch per-target lock key", async () => {
    // The set-based write still has to exclude a pre-deploy instance that locks
    // per (org, repo, target, window): a window-wide key would not overlap it,
    // so across a rollout both writers would read the row as absent and one of
    // the two merges would be lost. Sorted, so overlapping chunks cannot
    // deadlock.
    mockState.targets = [makeTarget("target-2"), makeTarget("target-1")];
    vi.setSystemTime(new Date("2026-07-06T09:08:15.000Z"));

    await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      scopes: [
        { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
      ],
    });

    expect(
      mockState.lockKeys.map((key) => key.split(":").slice(0, 4).join(":"))
    ).toEqual([
      "github-dirty-scope:org-1:repo-1:target-1",
      "github-dirty-scope:org-1:repo-1:target-2",
    ]);
    expect(
      mockState.lockKeys.every((key) => key.endsWith(windowSuffix()))
    ).toBe(true);
  });

  test("keeps nudging live desktops when a batched target was deleted mid-fan-out", async () => {
    // A batch snapshot outlives its desktops. Without the reload-and-retry the
    // foreign key aborts the chunk, so this repository — and, through the shared
    // batch, every later one in the fan-out — loses its still-live targets'
    // nudges too.
    mockState.targets = [
      makeTarget("target-1"),
      makeTarget("target-2"),
      makeTarget("target-3"),
    ];
    vi.setSystemTime(new Date("2026-07-06T09:08:30.000Z"));

    const batch = await githubDirtyScopeService.prepareBatch("org-1");
    mockState.targets = mockState.targets.filter(
      (target) => target.id !== "target-2"
    );

    const first = await githubDirtyScopeService.publish(
      {
        organizationId: "org-1",
        repositoryId: "repo-1",
        scopes: [
          { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
        ],
      },
      batch
    );

    expect(first.pendingRows).toBe(2);
    expect(
      mockState.rows
        .filter((row) => row.githubInstallationRepositoryId === "repo-1")
        .map((row) => row.computeTargetId)
    ).toEqual(["target-1", "target-3"]);

    // The deleted desktop is dropped from the shared snapshot, so the next
    // repository of the fan-out does not re-trip the same foreign key.
    mockState.counts.writeTransactions = 0;
    const second = await githubDirtyScopeService.publish(
      {
        organizationId: "org-1",
        repositoryId: "repo-2",
        scopes: [
          { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-2" },
        ],
      },
      batch
    );

    expect(second.pendingRows).toBe(2);
    expect(mockState.counts.writeTransactions).toBe(1);
  });

  test("does not deliver a pending nudge to a desktop reassigned to another org", async () => {
    // The eligible-target read decides org membership once — per fan-out when a
    // batch is threaded — and the row then waits out the debounce window before
    // dispatch. Without the recheck at delivery, org-1's repository id reaches a
    // desktop that now belongs to org-2 (@davetho, #6441).
    const startedAt = new Date("2026-07-06T09:09:30.000Z");
    vi.setSystemTime(startedAt);

    await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      scopes: [
        { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
      ],
    });
    expect(mockState.rows).toHaveLength(1);

    mockState.targets = [makeTarget("target-1", { organizationId: "org-2" })];

    const dispatched = await githubDirtyScopeService.dispatchDue({
      organizationId: "org-1",
      now: new Date(startedAt.getTime() + GITHUB_DIRTY_SCOPE_DEBOUNCE_MS),
    });

    expect(dispatched).toBe(0);
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
    // Settled, not skipped: a claimed row left unsettled is re-read and
    // re-claimed on every pass until its TTL expires.
    expect(mockState.rows[0]?.dispatchedAt).toBeInstanceOf(Date);
    expect(mockState.rows[0]?.deliveryResult).toEqual({
      delivered: false,
      reason: "target_reassigned",
    });
  });

  test("does not deliver a pending nudge to a desktop that dropped the nudge operation", async () => {
    // `supportedOperations` is rewritten on every desktop re-registration, so a
    // reconnect during the debounce window can revoke the capability the
    // eligible-target read checked.
    const startedAt = new Date("2026-07-06T09:10:30.000Z");
    vi.setSystemTime(startedAt);

    await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      scopes: [
        { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
      ],
    });
    expect(mockState.rows).toHaveLength(1);

    mockState.targets = [
      makeTarget("target-1", { supportedOperations: ["some.other.operation"] }),
    ];

    const dispatched = await githubDirtyScopeService.dispatchDue({
      organizationId: "org-1",
      now: new Date(startedAt.getTime() + GITHUB_DIRTY_SCOPE_DEBOUNCE_MS),
    });

    expect(dispatched).toBe(0);
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
    expect(mockState.rows[0]?.deliveryResult).toEqual({
      delivered: false,
      reason: "operation_unsupported",
    });
  });
});

/** The window segment every lock key for the current fake time ends with. */
function windowSuffix(): string {
  const windowStartedAt = new Date(
    Math.floor(Date.now() / GITHUB_DIRTY_SCOPE_DESKTOP_RATE_LIMIT_MS) *
      GITHUB_DIRTY_SCOPE_DESKTOP_RATE_LIMIT_MS
  );
  return `:${windowStartedAt.toISOString()}`;
}
