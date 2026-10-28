/**
 * What one `githubDirtyScopeService.dispatchDue` page COSTS the nudge table,
 * and when the drain takes another one (ISS-8973).
 *
 * The drain is reached unconditionally from the relay presence heartbeat, which
 * fires on the order of 27,000 times a day, so its statement count per page is
 * a contract and not an implementation detail. Statement counts are measured off
 * the mock client. Only the two DELTA cases run the same drain at a second page
 * size, so only their bound is proof against a fixture that never scales; the
 * full-page case pins an exact count at one size, and the re-paging cases pin
 * dispatch totals rather than statements.
 *
 * Its own file rather than `github-dirty-scope-service.test.ts`, which sits at
 * the per-file ceiling — the re-paging cases live here for the same reason, so
 * that file keeps the publish, debounce, and expiry surface and this one keeps
 * the drain.
 */
import type { CreateDesktopCommandInput } from "@repo/api/src/types/compute-target";
import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { GitHubDirtyScopeKind } from "@repo/api/src/types/github-dirty-scope";
import { RelayDispatchReason } from "@repo/api/src/types/relay-dispatch";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  DirtyScopeRow,
  DirtyScopeTarget,
  MockDb,
} from "@/__tests__/support/integrations/github/dirty-scope-service.test-mocks";
import {
  createMockDb,
  DIRTY_SCOPE_ORG_ID,
  makeDirtyScopeRow,
  makeTarget,
} from "@/__tests__/support/integrations/github/dirty-scope-service.test-mocks";
import { dispatchRelayCommandToRelay } from "@/app/compute-targets/relay-command-helpers";
import {
  GITHUB_DIRTY_SCOPE_DEBOUNCE_MS,
  GITHUB_DIRTY_SCOPE_DRAIN_MAX_PAGES,
  GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE,
  GITHUB_DIRTY_SCOPE_PENDING_TTL_MS,
  GITHUB_DIRTY_SCOPE_RETRY_BACKOFF_MS,
  githubDirtyScopeService,
} from "@/app/integrations/github/dirty-scope-service";
import { desktopCommandStore } from "@/lib/desktop-command-store";

const mockState = vi.hoisted(() => ({
  rows: [] as DirtyScopeRow[],
  targets: [] as DirtyScopeTarget[],
  lockTails: new Map<string, Promise<void>>(),
  lockKeys: [] as string[],
  // Errors the mock throws from its next `updateMany` calls, one per call, so a
  // test can drive a settle that fails without the page failing with it.
  updateManyErrors: [] as Error[],
  // Runs between the due read and the claim, so a test can move a desktop
  // inside the claim window.
  afterDueRead: undefined as (() => void) | undefined,
  counts: {
    targetReads: 0,
    expirySweeps: 0,
    writeTransactions: 0,
    nudgeStatements: 0,
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
        try {
          return await callback(db);
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

const NOW = new Date("2026-09-02T09:00:00.000Z");

/**
 * What a FULL page of rows sharing one outcome costs: the due read, the
 * set-based claim, that outcome's single settle, and the read that finds the
 * next page empty. Asserted EXACTLY, not as a ceiling — a `<=` bound also
 * accepts FEWER statements, and losing the re-page read is a regression that
 * shows up as 3.
 */
const FULL_PAGE_STATEMENTS = 4;

/**
 * Two partial page sizes, so the per-row delta between them is measured within
 * a single page — a FULL page re-reads to find the page after it, and that
 * fixed +1 would otherwise land in the delta.
 */
const SMALL_PAGE = 5;
const LARGE_PAGE = 95;

/**
 * Rows one drain delivers before its page ceiling stops it. A LITERAL, not
 * `MAX_PAGES * PAGE_SIZE`: an expectation read from the constants it polices
 * would let shrinking `GITHUB_DIRTY_SCOPE_DRAIN_MAX_PAGES` to 1 ship green.
 */
const DRAIN_CEILING_ROWS = 1000;

/**
 * A relay hop slow enough that two of them exhaust the claim lease. A LITERAL
 * against the literal 120s TTL and 15s margin: derived from
 * `GITHUB_DIRTY_SCOPE_DISPATCH_CLAIM_TTL_MS` it would track any widening of the
 * margin and stay green.
 */
const SLOW_RELAY_HOP_MS = 60_000;

/**
 * Skew between the caller's stamp and the drain's start big enough to spend the
 * lease on its own. A LITERAL against the literal 120s TTL and 15s margin, for
 * the same reason as `SLOW_RELAY_HOP_MS`.
 */
const STALE_CALLER_STAMP_MS = 110_000;

/**
 * A command write slow enough to spend the lease on its own, so the relay hop
 * behind it would fire past the claim. A LITERAL against the literal 120s TTL
 * and 15s margin, for the same reason as `SLOW_RELAY_HOP_MS`.
 */
const SLOW_COMMAND_WRITE_MS = 110_000;

type SeedKind = "eligible" | "reassigned" | "unsupported";

/**
 * Rows tied with the retrying block on `createdAt` and behind it in the page
 * (ISS-10050). Any positive count works; twenty keeps the block plus its peers
 * comfortably over one page without making the fixture slow.
 */
const TIED_PEERS = 20;

/**
 * Separate drains one starvation case runs. More than one on purpose: a single
 * round cannot tell a fairness fix from a tiebreaker, because both pick the
 * same page on the first pass. The defect only shows when the SAME block is
 * offered again.
 */
const STARVATION_ROUNDS = 5;

/**
 * Real time a slow page burns between the drain's `now` and its settle write.
 *
 * A LITERAL against the literal 120s claim TTL and 15s margin, like
 * `SLOW_RELAY_HOP_MS` above: long enough that a deferral anchored on the
 * drain's frozen `now` lands before the write does, short enough that the page
 * still finishes inside its lease rather than releasing its tail.
 */
const SLOW_COMMAND_FAILURE_MS = 60_000;

describe("dispatchDue cost and paging", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mockState.rows.length = 0;
    mockState.targets = [];
    mockState.lockTails.clear();
    mockState.lockKeys.length = 0;
    mockState.updateManyErrors.length = 0;
    mockState.afterDueRead = undefined;
    resetCounts();
    // A distinct command id per row, which is what production writes: a
    // delivered row's `deliveryResult` carries it, so delivered settles group
    // only when two rows genuinely settled the same way. A fixture that reused
    // one id would collapse them all and overstate the batching.
    let commandSequence = 0;
    vi.mocked(desktopCommandStore.createCommand).mockImplementation(
      (computeTargetId, input) => {
        commandSequence += 1;
        return Promise.resolve(
          makeCreatedCommand(computeTargetId, input, commandSequence)
        );
      }
    );
    vi.mocked(dispatchRelayCommandToRelay).mockResolvedValue({
      delivered: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("an empty due set costs exactly one read", async () => {
    // The case that runs on every presence heartbeat: nothing is due, and the
    // drain must not pay a write to discover that.
    const dispatched = await githubDirtyScopeService.dispatchDue({ now: NOW });

    expect(dispatched).toBe(0);
    expect(mockState.counts.nudgeStatements).toBe(1);
  });

  test("a full page of ineligible rows costs exactly four statements", async () => {
    seedDueRows(GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE, "reassigned");

    const dispatched = await githubDirtyScopeService.dispatchDue({ now: NOW });

    expect(dispatched).toBe(0);
    // Per-row claim plus per-row settle would be 201 here.
    expect(mockState.counts.nudgeStatements).toBe(FULL_PAGE_STATEMENTS);
    // Settled, not merely skipped: an unsettled row is re-read and re-claimed
    // on every drain until its TTL.
    expect(mockState.rows.every((row) => row.dispatchedAt !== null)).toBe(true);
  });

  test("an ineligible page costs the same at either page size", async () => {
    // Non-vacuity: the exact count above is only meaningful if it does not
    // move with the row count. Nineteen times the rows, same statements — a
    // per-row claim and settle would make this delta 2.
    const small = await measureDrain(SMALL_PAGE, "reassigned");
    const large = await measureDrain(LARGE_PAGE, "reassigned");

    expect(large.statements).toBe(small.statements);
    expect(perRowDelta(small, large)).toBe(0);
    expect(large.statements).toBeLessThan(FULL_PAGE_STATEMENTS);
  });

  test("a delivered page costs one statement per row beyond the fixed read and claim", async () => {
    // Delivered rows each carry their own command id, so their settles cannot
    // collapse further. What this pins is that the READ and the CLAIM are
    // fixed: the per-row delta is 1, and a per-row claim would make it 2.
    const small = await measureDrain(SMALL_PAGE, "eligible");
    const large = await measureDrain(LARGE_PAGE, "eligible");

    expect(small.dispatched).toBe(SMALL_PAGE);
    expect(large.dispatched).toBe(LARGE_PAGE);
    expect(perRowDelta(small, large)).toBe(1);
    expect(large.statements).toBeLessThanOrEqual(2 + LARGE_PAGE);
  });

  test("a full page of ineligible rows still re-pages to the rows behind it", async () => {
    // Ineligible rows are forward PROGRESS without being a DELIVERY, and that
    // distinction is the ONLY reason `drainDirtyScopePage` returns `progress`
    // separately from `dispatched`. Drop `progress += 1` from the ineligible
    // arm, or re-page on `dispatched === 0` instead, and a fully-ineligible
    // page reads as a stalled drain and strands everything behind it.
    //
    // The page must be EXACTLY full: below the page size the drain returns on
    // `rows.length < GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE` before the progress
    // check is ever reached, which is why the pre-existing two-row ineligible
    // test cannot cover this.
    seedDueRows(GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE, "reassigned");
    seedDueRows(1, "eligible", GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE);

    const dispatched = await githubDirtyScopeService.dispatchDue({ now: NOW });

    expect(dispatched).toBe(1);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledTimes(1);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledWith(
      `target-${GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE}`,
      expect.anything()
    );
    // Every row left the due set, which is the part a stalled drain loses.
    expect(mockState.rows.every((row) => row.dispatchedAt !== null)).toBe(true);
  });

  test("the due read pages oldest rows first", async () => {
    // The page BOUNDARY is decided by `orderBy`, so a suite that never observes
    // it cannot tell a paged read from an arbitrary one — and the full-page case
    // above depends on the boundary landing where production would put it.
    // Inserted NEWEST-first, so insertion order is the reverse of the sort key
    // and a read that ignores `orderBy` returns them backwards.
    for (const age of [0, 1, 2]) {
      const targetId = `target-age-${age}`;
      mockState.targets.push(makeTarget(targetId));
      mockState.rows.push(
        makeDirtyScopeRow({
          id: `row-age-${age}`,
          organizationId: DIRTY_SCOPE_ORG_ID,
          computeTargetId: targetId,
          scheduledDispatchAt: NOW,
          expiresAt: new Date(NOW.getTime() + 60_000),
          createdAt: new Date(NOW.getTime() - age * 1000),
        })
      );
    }

    await githubDirtyScopeService.dispatchDue({ now: NOW });

    expect(
      vi
        .mocked(desktopCommandStore.createCommand)
        .mock.calls.map(([targetId]) => targetId)
    ).toEqual(["target-age-2", "target-age-1", "target-age-0"]);
  });

  test("a settle that fails does not strand the groups behind it", async () => {
    // The per-row settle this replaced was inside the per-row try, so one
    // transient write failure cost one row. A page-wide flush must keep that
    // isolation, or a single failure leaves up to a page of rows sitting at
    // `claimed` — indistinguishable from in-flight until the claim TTL.
    seedDueRows(2, "reassigned");
    seedDueRows(2, "unsupported", 2);
    mockState.updateManyErrors.push(new Error("settle write failed"));

    await expect(
      githubDirtyScopeService.dispatchDue({ now: NOW })
    ).resolves.toBe(0);

    const [first, second, third, fourth] = mockState.rows;
    // Group one was the failing write: still CLAIMED, so only the TTL returns
    // it. Releasing the claim here instead — what the per-row catch this
    // replaced used to do — would make the same drain's next page re-read and
    // re-deliver these rows immediately, so the claim is pinned, not just the
    // dispatch.
    expect(first?.dispatchedAt).toBeNull();
    expect(first?.dispatchClaimedAt).toEqual(NOW);
    expect(second?.dispatchedAt).toBeNull();
    expect(second?.dispatchClaimedAt).toEqual(NOW);
    // Group two was behind it and still landed.
    expect(third?.dispatchedAt).not.toBeNull();
    expect(fourth?.dispatchedAt).not.toBeNull();
  });

  test("a settle only writes rows still holding this drain's claim", async () => {
    // Batching stretched the claim-to-settle window from one row to a whole
    // page, so a slow page can outlive `GITHUB_DIRTY_SCOPE_DISPATCH_CLAIM_TTL_MS`
    // and another drain can legitimately re-claim its rows. An id-only settle
    // would stamp over that second claim. Simulated by moving the row's claim
    // out from under the flush while the page is in flight.
    seedDueRows(1, "eligible");
    const stolenAt = new Date(NOW.getTime() + 1);
    vi.mocked(dispatchRelayCommandToRelay).mockImplementation(() => {
      const row = mockState.rows[0];
      if (row) {
        row.dispatchClaimedAt = stolenAt;
      }
      return Promise.resolve({ delivered: true });
    });

    await githubDirtyScopeService.dispatchDue({ now: NOW });

    // The other drain's claim survives, and this drain's settle was a no-op.
    expect(mockState.rows[0]?.dispatchClaimedAt).toEqual(stolenAt);
    expect(mockState.rows[0]?.dispatchedAt).toBeNull();
  });

  test("the eligibility recheck reads the target state as of the claim", async () => {
    // The due read's snapshot is stale by the time the claim lands: move the
    // desktop to another org in between and a recheck run against that snapshot
    // still sees the old org, so the FORMER org's repository id is handed to
    // the desktop's new owner (@whitlockk, #6529). The recheck must therefore read
    // the row the claim returned, not the row the due read returned.
    seedDueRows(1, "eligible");
    mockState.afterDueRead = () => {
      const target = mockState.targets[0];
      if (target) {
        target.organizationId = `${DIRTY_SCOPE_ORG_ID}-other`;
      }
    };

    const dispatched = await githubDirtyScopeService.dispatchDue({ now: NOW });

    expect(dispatched).toBe(0);
    // The leak itself: no command, so no cross-org repository id reaches the
    // desktop. Asserted on the store rather than on the return value, which a
    // released row would also read as 0.
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
    // Settled, not merely undelivered — the row must leave the due set.
    expect(mockState.rows[0]?.dispatchedAt).toEqual(NOW);
  });

  test("a page stops delivering when its claim lease is nearly spent", async () => {
    // Deliveries are serial and the relay hop aborts at 5s, so a full page can
    // cost 500s against a 120s claim (@whitlockk, #6529). A drain that keeps going
    // past its own lease delivers alongside the drain that has since reclaimed
    // those rows, and both push the same command id — the store's idempotency
    // key dedupes the row, not the relay hop.
    seedDueRows(GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE, "eligible");
    vi.mocked(dispatchRelayCommandToRelay).mockImplementation(() => {
      vi.advanceTimersByTime(SLOW_RELAY_HOP_MS);
      return Promise.resolve({ delivered: true });
    });

    const dispatched = await githubDirtyScopeService.dispatchDue({ now: NOW });

    // Two hops of 60s put the clock at 120s, past the 105s the 120s lease
    // leaves once its margin is held back, so the third row is never sent.
    expect(dispatched).toBe(2);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledTimes(2);
    // The rows it did not reach are RELEASED, not left claimed: the next drain
    // gets them now rather than after the claim TTL.
    const unreached = mockState.rows.slice(2);
    expect(unreached).toHaveLength(GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE - 2);
    expect(
      unreached.every(
        (row) => row.dispatchClaimedAt === null && row.dispatchedAt === null
      )
    ).toBe(true);
    // And the drain STOPS rather than re-paging into a lease it has already
    // spent: the page was full and made progress, which is otherwise exactly
    // the shape that re-pages. One read, one claim, two delivered settles and
    // one released settle — a re-page would add three more.
    expect(mockState.counts.nudgeStatements).toBe(5);
  });

  test("a command write that spends the lease stops before the relay hop", async () => {
    // The page checks the lease BEFORE the row, but `createCommand` runs
    // between that check and the 5s-bounded hop and is bounded by neither, so a
    // slow command write puts the hop past the lease — alongside whichever
    // drain has since legitimately reclaimed the row, both pushing the same
    // command id (@davetho, #6529). Two rows, so the case also pins that the
    // one BEHIND the slow row is released rather than delivered past the lease.
    seedDueRows(2, "eligible");
    vi.mocked(desktopCommandStore.createCommand).mockImplementation(
      (computeTargetId, input) => {
        vi.advanceTimersByTime(SLOW_COMMAND_WRITE_MS);
        return Promise.resolve(makeCreatedCommand(computeTargetId, input, 1));
      }
    );

    const dispatched = await githubDirtyScopeService.dispatchDue({ now: NOW });

    expect(dispatched).toBe(0);
    // The write happened once and the hop never did: that hop is the half the
    // store's idempotency key does NOT dedupe.
    expect(desktopCommandStore.createCommand).toHaveBeenCalledTimes(1);
    expect(dispatchRelayCommandToRelay).not.toHaveBeenCalled();
    // Both rows RELEASED, not settled: the command is idempotency-keyed, so the
    // next drain gets that same command and does the hop.
    expect(
      mockState.rows.every(
        (row) => row.dispatchClaimedAt === null && row.dispatchedAt === null
      )
    ).toBe(true);
  });

  test("a caller's stamp that already spent the lease releases the whole page", async () => {
    // The lease is `dispatchClaimedAt + TTL`, and `dispatchClaimedAt` is `now`
    // — the CALLER's stamp. `publish` takes it before resolving targets and
    // before every chunk write, each of which blocks on the per-window advisory
    // lock, so the drain can start with most of the lease already gone
    // (@marisolashgrove, #6529). A deadline anchored on the drain's own start
    // would read that skew as extra runway and deliver both rows past the
    // lease, alongside whichever drain has since reclaimed them.
    seedDueRows(2, "eligible");
    vi.setSystemTime(new Date(NOW.getTime() + STALE_CALLER_STAMP_MS));

    const dispatched = await githubDirtyScopeService.dispatchDue({ now: NOW });

    expect(dispatched).toBe(0);
    // Asserted on the store, not only on the return value: a released row also
    // reads as 0 dispatched.
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
    // Released rather than left claimed, so the next drain gets them now.
    expect(
      mockState.rows.every(
        (row) => row.dispatchClaimedAt === null && row.dispatchedAt === null
      )
    ).toBe(true);
  });

  test("re-paging stops at the page ceiling and leaves the remainder due", async () => {
    // Both sides literal: deriving the expectation from the constants under
    // test would let MAX_PAGES shrink to 1 and still ship green.
    expect(
      GITHUB_DIRTY_SCOPE_DRAIN_MAX_PAGES * GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE
    ).toBe(DRAIN_CEILING_ROWS);
    seedDueRows(DRAIN_CEILING_ROWS + 1, "eligible");

    const dispatched = await githubDirtyScopeService.dispatchDue({ now: NOW });

    expect(dispatched).toBe(DRAIN_CEILING_ROWS);
    // The remainder is not lost — the next drain picks it up.
    resetCounts();
    const remainder = await githubDirtyScopeService.dispatchDue({ now: NOW });
    expect(remainder).toBe(1);
  });

  test("continues draining after the first due-row page", async () => {
    const now = new Date("2026-07-06T09:05:00.000Z");
    vi.setSystemTime(now);
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
    vi.setSystemTime(now);
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

  test("keeps draining a page whose only rows were ineligible", async () => {
    // The ineligible rows ARE forward progress — they leave the due set — so a
    // page made entirely of them must not read as a stalled drain and stop the
    // loop before the rows behind it.
    const startedAt = new Date("2026-07-06T09:11:30.000Z");
    vi.setSystemTime(startedAt);

    mockState.targets = [makeTarget("target-1"), makeTarget("target-2")];
    await githubDirtyScopeService.publish({
      organizationId: "org-1",
      repositoryId: "repo-1",
      scopes: [
        { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
      ],
    });
    expect(mockState.rows).toHaveLength(2);

    mockState.targets = [
      makeTarget("target-1", { organizationId: "org-2" }),
      makeTarget("target-2"),
    ];

    const dispatched = await githubDirtyScopeService.dispatchDue({
      organizationId: "org-1",
      now: new Date(startedAt.getTime() + GITHUB_DIRTY_SCOPE_DEBOUNCE_MS),
    });

    expect(dispatched).toBe(1);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledTimes(1);
    expect(desktopCommandStore.createCommand).toHaveBeenCalledWith(
      "target-2",
      expect.anything()
    );
  });

  test("a retrying tie block wider than a page stops starving its tied peers", async () => {
    // The starvation shape, driven over repeated drains (ISS-10050). Every row
    // shares one `createdAt`: `writeDirtyScopeChunk` inserts a chunk in a single
    // transaction so a chunk really does tie, and `created_at` is TIMESTAMP(3),
    // so separate transactions landing in one millisecond tie too.
    //
    // Order among tied rows is unspecified in Postgres. The mock sorts stably,
    // which stands in for the case that actually hurts — a plan that keeps
    // handing back the same rows — and is exactly why a TIEBREAKER is not the
    // fix: it would make this selection the guaranteed one rather than the
    // unlucky one.
    seedTiedBlock(GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE, TIED_PEERS);
    failDispatchForRetryingTargets();

    const peersReachedPerRound = await drainRounds(STARVATION_ROUNDS);

    // Round one: the retrying block fills the page and the peers are untouched.
    // That is the state the old behaviour never left, and the fix does not
    // change it — fairness arrives on the NEXT drain, not this one.
    expect(peersReachedPerRound[0]).toBe(0);
    // Round two onward: the block has been deprioritized, so the peers get a
    // page. Every later round, not just one, so a fix that let the block back
    // in and re-starved them would still fail here.
    expect(peersReachedPerRound.slice(1)).toEqual(
      Array.from({ length: STARVATION_ROUNDS - 1 }, () => TIED_PEERS)
    );
    // Deprioritized, not dropped: still undelivered, and still due — just past
    // the last round, having been re-deferred by each round that did re-reach
    // them once an earlier backoff had lapsed.
    const lastRoundAt =
      NOW.getTime() + (STARVATION_ROUNDS - 1) * GITHUB_DIRTY_SCOPE_DEBOUNCE_MS;
    expect(
      retryingRows().every(
        (row) =>
          row.dispatchedAt === null &&
          row.scheduledDispatchAt.getTime() > lastRoundAt
      )
    ).toBe(true);
  });

  test("a deferred retry is attempted again once its backoff elapses", async () => {
    // The liveness sibling of the case above. A backoff that DROPPED the row
    // would satisfy the fairness assertions just as well and silently lose the
    // nudge, so the retry has to be observed coming back.
    seedTiedBlock(GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE, TIED_PEERS);
    failDispatchForRetryingTargets();

    await drainRounds(2);
    const attemptsInsideBackoff = retryingAttempts();
    const afterBackoff = new Date(
      NOW.getTime() + GITHUB_DIRTY_SCOPE_RETRY_BACKOFF_MS + 1
    );
    vi.setSystemTime(afterBackoff);
    await githubDirtyScopeService.dispatchDue({ now: afterBackoff });

    // One page of attempts across both rounds inside the backoff — the second
    // round did not re-reach them — and a second page once it lapses.
    expect(attemptsInsideBackoff).toBe(GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE);
    expect(retryingAttempts()).toBe(GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE * 2);
  });

  test("a page-wide block whose relay hop fails defers nothing", async () => {
    // The near miss, and the shape ISS-10050 named as its plausible cause: a
    // relay outage during an "all repositories" fan-out. It does NOT produce a
    // retrying block. Every failure inside `dispatchRelayCommandToRelay` comes
    // back as `delivered: false` rather than throwing, and the page SETTLES
    // that — `dispatchedAt` stamped, row out of the due `where` — so the block
    // never repeats and nothing is backed off. Planting it must leave the new
    // behaviour silent.
    seedTiedBlock(GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE, TIED_PEERS);
    vi.mocked(dispatchRelayCommandToRelay).mockResolvedValue({
      delivered: false,
      reason: RelayDispatchReason.TargetNotConnected,
    });

    await drainRounds(1);

    expect(
      mockState.rows.every(
        (row) =>
          row.dispatchedAt !== null &&
          row.scheduledDispatchAt.getTime() === NOW.getTime()
      )
    ).toBe(true);
  });

  test("the retry backoff strictly outlasts the debounce that schedules the next re-drain", () => {
    // The RELATIONSHIP, not the number. The debounced re-drain is the only
    // drain that reads a tie block spanning several desktops, and the due
    // read's `scheduledDispatchAt: { lte: now }` is INCLUSIVE — so a backoff
    // merely equal to that gap is due again on exactly the drain meant to step
    // over it, and the block refills the page. The service derives one from the
    // other so they cannot coincide by edit; this fails if that derivation is
    // ever replaced by a literal that coincides, or inverted.
    expect(GITHUB_DIRTY_SCOPE_RETRY_BACKOFF_MS).toBeGreaterThan(
      GITHUB_DIRTY_SCOPE_DEBOUNCE_MS
    );
  });

  test("a deferral survives a slow page AND the boundary re-drain together", async () => {
    // Both halves of the deadline at once, because fixing either alone still
    // starves. The page burns real time before its settle write, so a deferral
    // anchored on the drain's FROZEN `now` lands at or before the instant it is
    // written. And the next drain that can read this block is the debounced
    // re-drain exactly `GITHUB_DIRTY_SCOPE_DEBOUNCE_MS` later, a gap a backoff
    // merely EQUAL to the debounce does not clear.
    seedTiedBlock(GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE, TIED_PEERS);
    failDispatchForRetryingTargets(SLOW_COMMAND_FAILURE_MS);

    await githubDirtyScopeService.dispatchDue({ now: NOW });

    // The page really did outrun its own stamp, so the fixture is not vacuous.
    const settledAt = Date.now();
    expect(settledAt).toBe(NOW.getTime() + SLOW_COMMAND_FAILURE_MS);
    expect(
      retryingRows().every(
        (row) =>
          row.scheduledDispatchAt.getTime() ===
          settledAt + GITHUB_DIRTY_SCOPE_RETRY_BACKOFF_MS
      )
    ).toBe(true);

    // The debounced re-drain, at its exact instant.
    const boundaryDrainAt = new Date(
      settledAt + GITHUB_DIRTY_SCOPE_DEBOUNCE_MS
    );
    vi.setSystemTime(boundaryDrainAt);
    await githubDirtyScopeService.dispatchDue({ now: boundaryDrainAt });

    expect(peerRows().every((row) => row.dispatchedAt !== null)).toBe(true);
    // The block was NOT re-attempted on that drain — one page of attempts, not
    // two, which is what a deferral landing in the past or on the boundary
    // would produce.
    expect(retryingAttempts()).toBe(GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE);
  });

  test("a page released by a spent lease keeps its dispatch schedule", async () => {
    // The liveness half of the backoff (ISS-10050). Rows the drain never
    // reached were not attempted, and the page-mates ahead of them settled and
    // left, so they hold no page against a tied peer. Backing them off would
    // delay a healthy drain's own tail for fairness it does not owe, so this
    // release path must stay unchanged.
    seedDueRows(GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE, "eligible");
    vi.mocked(dispatchRelayCommandToRelay).mockImplementation(() => {
      vi.advanceTimersByTime(SLOW_RELAY_HOP_MS);
      return Promise.resolve({ delivered: true });
    });

    await githubDirtyScopeService.dispatchDue({ now: NOW });

    const unreached = mockState.rows.slice(2);
    expect(unreached).toHaveLength(GITHUB_DIRTY_SCOPE_DRAIN_PAGE_SIZE - 2);
    expect(
      unreached.every(
        (row) => row.scheduledDispatchAt.getTime() === NOW.getTime()
      )
    ).toBe(true);
  });
});

function resetCounts(): void {
  mockState.counts = {
    targetReads: 0,
    expirySweeps: 0,
    writeTransactions: 0,
    nudgeStatements: 0,
    heldLocks: 0,
    peakHeldLocks: 0,
  };
}

/**
 * Seed `count` rows that are due now, each on its own desktop.
 *
 * `reassigned` and `unsupported` are the two dispatch-time rechecks that settle
 * a row WITHOUT delivering it — the page shape with no per-row command work to
 * hide the drain's own statements behind, and the two distinct settle outcomes.
 * `startIndex` offsets the ids so one test can seed more than one kind.
 */
function seedDueRows(count: number, kind: SeedKind, startIndex = 0): void {
  for (let offset = 0; offset < count; offset += 1) {
    const index = startIndex + offset;
    const targetId = `target-${index}`;
    mockState.targets.push(makeTarget(targetId, targetOverrides(kind)));
    mockState.rows.push(
      makeDirtyScopeRow({
        id: `row-${index}`,
        organizationId: DIRTY_SCOPE_ORG_ID,
        computeTargetId: targetId,
        dirtyScopes: [
          { kind: GitHubDirtyScopeKind.Repository, repositoryId: "repo-1" },
        ],
        scheduledDispatchAt: NOW,
        expiresAt: new Date(NOW.getTime() + 60_000),
        // Distinct and ascending, so "behind the page" means behind it by the
        // key the due read orders on. Sharing one `createdAt` would leave the
        // page boundary decided by push order in the mock and unspecified in
        // Postgres — and a transaction-inserted batch really does tie.
        createdAt: new Date(NOW.getTime() + index),
      })
    );
  }
}

function targetOverrides(kind: SeedKind): Partial<DirtyScopeTarget> {
  if (kind === "reassigned") {
    return { organizationId: `${DIRTY_SCOPE_ORG_ID}-other` };
  }
  if (kind === "unsupported") {
    return { supportedOperations: [] };
  }
  return {};
}

/** One drain over a freshly seeded due set, and what it cost. */
async function measureDrain(
  count: number,
  kind: SeedKind
): Promise<{ dispatched: number; statements: number }> {
  mockState.rows.length = 0;
  mockState.targets = [];
  resetCounts();
  seedDueRows(count, kind);
  const dispatched = await githubDirtyScopeService.dispatchDue({ now: NOW });
  return { dispatched, statements: mockState.counts.nudgeStatements };
}

/** Statements added per extra row between two measured drains. */
function perRowDelta(
  small: { statements: number },
  large: { statements: number }
): number {
  return (large.statements - small.statements) / (LARGE_PAGE - SMALL_PAGE);
}

/**
 * What `desktopCommandStore.createCommand` returns for one row. Extracted so a
 * case that replaces the mock to make the WRITE the slow operation still hands
 * the drain the shape production writes.
 */
function makeCreatedCommand(
  computeTargetId: string,
  input: CreateDesktopCommandInput,
  sequence: number
): Awaited<ReturnType<typeof desktopCommandStore.createCommand>> {
  return {
    command: {
      commandId: `command-${sequence}`,
      computeTargetId,
      operationId: input.operationId,
      status: DesktopCommandStatus.Queued,
      requestPayload: input,
      createdAt: new Date(),
      lastSequenceAcked: 0,
      requestFingerprint: `fingerprint-${sequence}`,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    },
    deduped: false,
  };
}

/**
 * A tie block: `retryingCount` rows whose dispatch will throw, then `peerCount`
 * rows that would deliver, ALL sharing one `createdAt` (ISS-10050).
 *
 * The peers go in behind the block so the mock's stable sort puts them past the
 * page boundary — the unlucky draw production's unspecified tie order permits
 * and a stable query plan repeats.
 */
function seedTiedBlock(retryingCount: number, peerCount: number): void {
  const tiedAt = new Date(NOW.getTime() - 1000);
  for (let index = 0; index < retryingCount + peerCount; index += 1) {
    const targetId =
      index < retryingCount ? `retrying-${index}` : `peer-${index}`;
    mockState.targets.push(makeTarget(targetId));
    mockState.rows.push(
      makeDirtyScopeRow({
        id: `row-${index}`,
        organizationId: DIRTY_SCOPE_ORG_ID,
        computeTargetId: targetId,
        scheduledDispatchAt: NOW,
        expiresAt: new Date(NOW.getTime() + GITHUB_DIRTY_SCOPE_PENDING_TTL_MS),
        createdAt: tiedAt,
      })
    );
  }
}

function isRetryingTarget(computeTargetId: string): boolean {
  return computeTargetId.startsWith("retrying-");
}

function retryingRows(): DirtyScopeRow[] {
  return mockState.rows.filter((row) => isRetryingTarget(row.computeTargetId));
}

function peerRows(): DirtyScopeRow[] {
  return mockState.rows.filter((row) => !isRetryingTarget(row.computeTargetId));
}

/**
 * Make the block's dispatch THROW — the release the backoff covers. Thrown at
 * the command write, the one operation in `dispatchDirtyScopeRow` that can:
 * `dispatchRelayCommandToRelay` returns its failures rather than raising them.
 *
 * `burnRealTimeMs` advances the clock inside the FIRST failing row only, so the
 * page spends real time between the drain's `now` and its settle write without
 * the per-row cost compounding into a spent lease.
 */
function failDispatchForRetryingTargets(burnRealTimeMs = 0): void {
  let commandSequence = 0;
  let burned = false;
  vi.mocked(desktopCommandStore.createCommand).mockImplementation(
    (computeTargetId, input) => {
      if (isRetryingTarget(computeTargetId)) {
        if (burnRealTimeMs > 0 && !burned) {
          burned = true;
          vi.advanceTimersByTime(burnRealTimeMs);
        }
        return Promise.reject(new Error("command write failed"));
      }
      commandSequence += 1;
      return Promise.resolve(
        makeCreatedCommand(computeTargetId, input, commandSequence)
      );
    }
  );
}

/** Dispatch attempts made against the retrying block, across every round. */
function retryingAttempts(): number {
  return vi
    .mocked(desktopCommandStore.createCommand)
    .mock.calls.filter(([computeTargetId]) => isRetryingTarget(computeTargetId))
    .length;
}

/**
 * Run `rounds` SEPARATE drains, one `GITHUB_DIRTY_SCOPE_DEBOUNCE_MS` apart, and
 * report how many tied peers had been reached after each one.
 *
 * Separate drains because the starvation is invisible inside a single one. That
 * gap because the debounced re-drain `publish` schedules is the drain that
 * actually reads a tie block spanning several desktops — NOT the presence
 * heartbeat, which `scheduleGitHubDirtyScopeRecoveryDrain` scopes to one
 * `computeTargetId` and which therefore never competes for a page with another
 * desktop's rows.
 */
async function drainRounds(rounds: number): Promise<number[]> {
  const peersReached: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const roundNow = new Date(
      NOW.getTime() + round * GITHUB_DIRTY_SCOPE_DEBOUNCE_MS
    );
    vi.setSystemTime(roundNow);
    await githubDirtyScopeService.dispatchDue({ now: roundNow });
    peersReached.push(
      peerRows().filter((row) => row.dispatchedAt !== null).length
    );
  }
  return peersReached;
}
