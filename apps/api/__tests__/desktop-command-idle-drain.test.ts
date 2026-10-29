/**
 * ISS-8686, the disconnected half.
 *
 * The presence trigger cannot reach a target that sends no heartbeat, so this
 * sweep is the floor under it — and every attempt it makes is spent against a
 * relay hop that was failing 50.9% of production dispatches over the 24h to
 * 2026-09-02. These cases pin the three bounds that keep that cost finite: the
 * decaying stride, the give-up horizon, and the per-tick fan-out cap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockListIdleDrainCandidates, mockReleaseQueuedCommands } = vi.hoisted(
  () => ({
    mockListIdleDrainCandidates: vi.fn(),
    mockReleaseQueuedCommands: vi.fn(),
  })
);

vi.mock("@/lib/desktop-command-dispatch-queries", () => ({
  listIdleDrainCandidates: mockListIdleDrainCandidates,
}));

vi.mock("@/app/internal/relay/socket-event/service/command-drain", () => ({
  releaseQueuedCommands: mockReleaseQueuedCommands,
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  drainIdleCommandQueues,
  IDLE_DRAIN_BUDGET_MS,
  IDLE_DRAIN_CANDIDATE_LIMIT,
  IDLE_DRAIN_GIVE_UP_MS,
  IDLE_DRAIN_MAX_TARGETS_PER_TICK,
  IDLE_DRAIN_MIN_SILENCE_MS,
  IDLE_DRAIN_TICK_MS,
  isDueThisTick,
  presenceSilenceMs,
  retryStrideTicks,
} from "@/lib/desktop-command-idle-drain";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A silence in the first rung, where the stride is one tick so EVERY target is
 * due on EVERY tick. Cases about the fan-out cap need that: with a wider stride
 * the offset spreads the fleet and it would be the spread, not the cap, doing
 * the bounding.
 */
const SILENT_EVERY_TICK_MS = 10 * MINUTE_MS;

/**
 * A candidate as the query hands one over: a presence clock, and the creation
 * clock the drain falls back to when no presence frame has ever been seen.
 *
 * `createdAt` is deliberately NOT derived from `presenceAt` — a case about the
 * null-presence fallback has to be able to move one without the other.
 */
function candidate(
  computeTargetId: string,
  presenceAt: Date | null,
  createdAt = new Date(0)
) {
  return { computeTargetId, presenceAt, createdAt };
}

/**
 * The epoch millis of the earliest tick at which `targetId` comes due.
 * Searched rather than computed, so the offset function can change without
 * rewriting every fixture that depends on one.
 */
function firstDueAt(targetId: string, silentMs: number): number {
  for (let tick = 0; tick < 10_000; tick++) {
    const now = tick * IDLE_DRAIN_TICK_MS;
    if (isDueThisTick(targetId, silentMs, now)) {
      return now;
    }
  }
  throw new Error(`never due: ${targetId}`);
}

/**
 * A page of targets all silent by the same amount, which is what the cap and
 * budget cases need: one silence means one stride, so only the bound under test
 * can vary the outcome.
 */
function candidatePage(
  ids: string[],
  now: number,
  silentMs: number,
  hasMore = false
) {
  return {
    candidates: ids.map((id) => candidate(id, new Date(now - silentMs))),
    hasMore,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockListIdleDrainCandidates.mockResolvedValue({
    candidates: [],
    hasMore: false,
  });
  mockReleaseQueuedCommands.mockResolvedValue(1);
});

// Unconditional, not the last line of each case: a case that throws mid-way
// would otherwise leak a frozen clock into every later test in this worker.
afterEach(() => {
  vi.useRealTimers();
});

describe("retryStrideTicks — the backoff actually decays", () => {
  it("leaves a freshly-seen target to the presence trigger", () => {
    // Presence wakes it every 30s; a second schedule would double-dispatch the
    // same backlog.
    expect(retryStrideTicks(IDLE_DRAIN_MIN_SILENCE_MS - 1)).toBeUndefined();
  });

  it("calls a target exactly on the cutoff due, which is the instant the SQL page must also admit", () => {
    // davetho, PR #7119. The constant is the silence BELOW which presence owns
    // a target, so the cutoff itself belongs to the drain. `listIdleDrainCandidates`
    // used a strict `lt` against `now - IDLE_DRAIN_MIN_SILENCE_MS` and excluded
    // exactly this instant, so the ladder called it due and the page never
    // offered it. Pinned here as well as in the integration suite because the
    // two are only correct together, and the millisecond either side of the
    // cutoff says nothing about the cutoff.
    expect(retryStrideTicks(IDLE_DRAIN_MIN_SILENCE_MS)).toBe(1);
  });

  it("widens the gap between attempts as the silence grows", () => {
    const ladder = [
      retryStrideTicks(5 * MINUTE_MS),
      retryStrideTicks(30 * MINUTE_MS),
      retryStrideTicks(2 * HOUR_MS),
      retryStrideTicks(12 * HOUR_MS),
    ];

    // Strictly increasing is the whole claim: a flat ladder would be a fixed
    // retry interval wearing the word "backoff".
    expect(ladder).toEqual([1, 3, 6, 12]);
    for (let step = 1; step < ladder.length; step++) {
      expect(ladder[step] as number).toBeGreaterThan(
        ladder[step - 1] as number
      );
    }
  });

  it("gives up entirely past the horizon, rather than retrying forever", () => {
    // The load-bearing rung. A sparse-but-fixed retry still costs a permanently
    // dead target a 4s peer-hop timeout every stride, forever.
    expect(retryStrideTicks(IDLE_DRAIN_GIVE_UP_MS)).toBeUndefined();
    expect(retryStrideTicks(7 * DAY_MS)).toBeUndefined();
  });
});

describe("isDueThisTick", () => {
  it("never fires for a target past the give-up horizon, at any tick", () => {
    // Swept across two full stride cycles so a lucky tick cannot pass this.
    for (let tick = 0; tick < 48; tick++) {
      expect(
        isDueThisTick("target-week-dead", 7 * DAY_MS, tick * IDLE_DRAIN_TICK_MS)
      ).toBe(false);
    }
  });

  it("fires on exactly one tick in every stride, not on all of them", () => {
    const SILENT_TWO_HOURS = 2 * HOUR_MS;
    // Written out, not read back off `retryStrideTicks`: an expectation derived
    // from the value under test is satisfied by any value, including the flat
    // stride of 1 this case exists to reject.
    const stride = 6;
    const start = firstDueAt("target-two-hours", SILENT_TWO_HOURS);

    const due: number[] = [];
    for (let tick = 0; tick < stride * 2; tick++) {
      if (
        isDueThisTick(
          "target-two-hours",
          SILENT_TWO_HOURS,
          start + tick * IDLE_DRAIN_TICK_MS
        )
      ) {
        due.push(tick);
      }
    }

    expect(due).toEqual([0, stride]);
  });

  it("spreads targets on the same stride across different ticks", () => {
    // Without an offset every stride-12 target lands on one tick and eats the
    // whole fan-out cap together, starving the reachable stride-1 ones.
    const SILENT = 12 * HOUR_MS;
    const firstDue = ["target-aa", "target-ab", "target-ac", "target-ad"].map(
      (id) => firstDueAt(id, SILENT)
    );

    expect(new Set(firstDue).size).toBeGreaterThan(1);
  });
});

describe("drainIdleCommandQueues", () => {
  it("drains a disconnected target that no presence heartbeat can reach", async () => {
    const SILENT_MS = 30 * MINUTE_MS;
    const now = firstDueAt("target-offline", SILENT_MS);
    vi.setSystemTime(now);
    mockListIdleDrainCandidates.mockResolvedValue(
      candidatePage(["target-offline"], now, SILENT_MS)
    );

    const summary = await drainIdleCommandQueues();

    expect(mockReleaseQueuedCommands).toHaveBeenCalledWith("target-offline");
    expect(summary.targetsAttempted).toBe(1);
    expect(summary.commandsReleased).toBe(1);
  });

  it("reads the whole page in one query, never once per target", async () => {
    // The fleet size must never reach a cron tick's query count: the candidate
    // page is attacker-inflatable — registering a target needs no quota.
    const ids = Array.from({ length: 40 }, (_unused, index) => `bulk-${index}`);
    const now = 1000 * IDLE_DRAIN_TICK_MS;
    vi.setSystemTime(now);
    mockListIdleDrainCandidates.mockResolvedValue(
      candidatePage(ids, now, SILENT_EVERY_TICK_MS, true)
    );

    await drainIdleCommandQueues();

    expect(mockListIdleDrainCandidates).toHaveBeenCalledTimes(1);
  });

  it("asks the database for the cap and the presence filter together, so the page is bounded after the filter", async () => {
    // ISS-8895 finding 1 (whitlockk, PR #6459). The old shape took the deepest 100
    // backlogs and only then discarded the ones the presence trigger owns, so
    // a fleet of connected desktops could fill every slot with targets this
    // sweep was about to refuse and the disconnected ones never reached it.
    // Both arguments in ONE call is the whole claim: a cap applied in a
    // separate query from the filter is the defect, not the fix.
    const now = 777 * IDLE_DRAIN_TICK_MS;
    vi.setSystemTime(now);

    await drainIdleCommandQueues();

    expect(mockListIdleDrainCandidates).toHaveBeenCalledWith(
      IDLE_DRAIN_CANDIDATE_LIMIT,
      new Date(now - IDLE_DRAIN_MIN_SILENCE_MS)
    );
  });

  it("never dispatches at more targets in one tick than the fan-out cap", async () => {
    const OVER_CAP = IDLE_DRAIN_MAX_TARGETS_PER_TICK + 7;
    const now = 0;
    vi.setSystemTime(now);
    const ids = Array.from(
      { length: OVER_CAP },
      (_unused, index) => `capped-${index}`
    );
    mockListIdleDrainCandidates.mockResolvedValue(
      candidatePage(ids, now, SILENT_EVERY_TICK_MS)
    );

    const summary = await drainIdleCommandQueues();

    // Every candidate is due on this tick (stride 1), so only the cap can bound
    // this — the offset spread is deliberately not doing the work here.
    expect(summary.targetsDue).toBe(OVER_CAP);
    expect(mockReleaseQueuedCommands).toHaveBeenCalledTimes(
      IDLE_DRAIN_MAX_TARGETS_PER_TICK
    );
    expect(summary.targetsAttempted).toBe(IDLE_DRAIN_MAX_TARGETS_PER_TICK);
    // Reported rather than swallowed: a cap that bites silently is a cap that
    // looks like a small fleet.
    expect(summary.targetsSkippedByCap).toBe(
      OVER_CAP - IDLE_DRAIN_MAX_TARGETS_PER_TICK
    );
  });

  it("does not dispatch at a target silent past the give-up horizon, on any tick", async () => {
    // Swept across two full cycles of the widest stride rather than probed on
    // one tick: a single tick a target happens not to be due on passes with the
    // horizon deleted, which is the whole behaviour under test.
    const TICKS = 24;

    for (let tick = 0; tick < TICKS; tick++) {
      const now = tick * IDLE_DRAIN_TICK_MS;
      vi.setSystemTime(now);
      mockListIdleDrainCandidates.mockResolvedValue(
        candidatePage(["target-week-offline"], now, 7 * DAY_MS)
      );

      const summary = await drainIdleCommandQueues();

      expect(summary.targetsDue).toBe(0);
    }
    expect(mockReleaseQueuedCommands).not.toHaveBeenCalled();
  });

  it("leaves a target the presence trigger still owns alone", async () => {
    // Draining a connected target here would put a second schedule on the same
    // backlog that presence is already waking every 30s.
    const now = 500 * IDLE_DRAIN_TICK_MS;
    vi.setSystemTime(now);
    mockListIdleDrainCandidates.mockResolvedValue(
      candidatePage(["target-connected"], now, IDLE_DRAIN_MIN_SILENCE_MS - 1)
    );

    const summary = await drainIdleCommandQueues();

    expect(mockReleaseQueuedCommands).not.toHaveBeenCalled();
    expect(summary.targetsDue).toBe(0);
  });

  it("measures a target that has never sent relay presence from when it was created, and drains it", async () => {
    // ISS-8897 AC4. A null `presenceAt` is UNKNOWN, and the drain resolves it
    // toward "the presence trigger has never covered this" — which is what it
    // means — rather than toward "present now", which would strand the backlog
    // forever. `createdAt` is a true lower bound, not a stand-in.
    const AGE_MS = 30 * MINUTE_MS;
    const now = firstDueAt("target-never-present", AGE_MS);
    vi.setSystemTime(now);
    mockListIdleDrainCandidates.mockResolvedValue({
      candidates: [
        candidate("target-never-present", null, new Date(now - AGE_MS)),
      ],
      hasMore: false,
    });

    const summary = await drainIdleCommandQueues();

    expect(mockReleaseQueuedCommands).toHaveBeenCalledWith(
      "target-never-present"
    );
    expect(summary.targetsAttempted).toBe(1);
  });

  it("still leaves a brand-new target to the presence trigger for its first silence window", async () => {
    // The positive sibling of the case above: the null fallback must not become
    // "always drain". A target created seconds ago has not been abandoned by a
    // trigger that has simply not had a chance to fire yet.
    const now = 900 * IDLE_DRAIN_TICK_MS;
    vi.setSystemTime(now);
    mockListIdleDrainCandidates.mockResolvedValue({
      candidates: [
        candidate(
          "target-just-registered",
          null,
          new Date(now - (IDLE_DRAIN_MIN_SILENCE_MS - 1))
        ),
      ],
      hasMore: false,
    });

    const summary = await drainIdleCommandQueues();

    expect(mockReleaseQueuedCommands).not.toHaveBeenCalled();
    expect(summary.targetsDue).toBe(0);
  });

  it("stops mid-sweep when the wall-clock budget runs out, and says so", async () => {
    // The frozen clock is advanced from INSIDE the drain, because a fake timer
    // otherwise makes `Date.now() - now` permanently 0 and leaves the budget
    // branch unreachable — the shape that lets a declared bound ship untested.
    const PER_TARGET_MS = IDLE_DRAIN_BUDGET_MS / 2 + 1000;
    const now = 0;
    vi.setSystemTime(now);
    const ids = Array.from(
      { length: IDLE_DRAIN_MAX_TARGETS_PER_TICK },
      (_unused, index) => `slow-${index}`
    );
    mockListIdleDrainCandidates.mockResolvedValue(
      candidatePage(ids, now, SILENT_EVERY_TICK_MS)
    );
    mockReleaseQueuedCommands.mockImplementation(() => {
      vi.setSystemTime(Date.now() + PER_TARGET_MS);
      return Promise.resolve(0);
    });

    const summary = await drainIdleCommandQueues();

    // Two fit and the third is refused: each costs just over half the budget,
    // and the check runs BEFORE a target rather than after it, so the second
    // starts at 23.5s (under) and the third would start at 47s (over).
    const EXPECTED_ATTEMPTS = 2;

    expect(summary.budgetExhausted).toBe(true);
    expect(summary.targetsAttempted).toBe(EXPECTED_ATTEMPTS);
    // Attributed to the budget, not to the fan-out cap — they are different
    // problems with different fixes, and one "skipped" number would name the
    // wrong one.
    expect(summary.targetsSkippedByBudget).toBe(
      IDLE_DRAIN_MAX_TARGETS_PER_TICK - EXPECTED_ATTEMPTS
    );
    expect(summary.targetsSkippedByCap).toBe(0);
  });

  it("rotates which due targets are selected across ticks, so no target starves behind the depth order", async () => {
    // whitlockk/marisolashgrove (PR #6459): stride 1 puts every one of these up on
    // every tick, so `due` is just the backlog-depth order the query
    // returned. A flat `slice(0, cap)` would hand the same top targets the
    // cap forever and starve the rest of this band indefinitely.
    const DUE_COUNT = IDLE_DRAIN_MAX_TARGETS_PER_TICK + 3;
    const ids = Array.from(
      { length: DUE_COUNT },
      (_unused, index) => `dense-${index}`
    );
    const attempted = new Set<string>();
    for (let tick = 0; tick < DUE_COUNT; tick++) {
      const now = tick * IDLE_DRAIN_TICK_MS;
      vi.setSystemTime(now);
      mockListIdleDrainCandidates.mockResolvedValue(
        candidatePage(ids, now, SILENT_EVERY_TICK_MS)
      );
      mockReleaseQueuedCommands.mockClear();

      await drainIdleCommandQueues();

      for (const call of mockReleaseQueuedCommands.mock.calls) {
        attempted.add(call[0] as string);
      }
    }

    // Every one of the 13 equally-due targets got a turn across 13 ticks; a
    // depth-order slice would only ever have attempted the same top 10.
    expect(attempted.size).toBe(DUE_COUNT);
  });

  it("counts targets stranded past the give-up horizon separately from ones the presence trigger still owns", async () => {
    // marisolashgrove (PR #6459): retryStrideTicks returns undefined for both,
    // so targetsDue: 0 alone cannot tell "presence has these" apart from "these
    // are stranded for good" — the load-bearing rung had no counter.
    const now = 0;
    vi.setSystemTime(now);
    const coveredIds = ["covered-a", "covered-b"];
    const givenUpIds = ["given-up-a", "given-up-b", "given-up-c"];
    mockListIdleDrainCandidates.mockResolvedValue({
      candidates: [
        ...coveredIds.map((id) =>
          candidate(id, new Date(now - (IDLE_DRAIN_MIN_SILENCE_MS - 1)))
        ),
        ...givenUpIds.map((id) =>
          candidate(id, new Date(now - IDLE_DRAIN_GIVE_UP_MS))
        ),
      ],
      hasMore: false,
    });

    const summary = await drainIdleCommandQueues();

    expect(summary.targetsDue).toBe(0);
    expect(summary.targetsGivenUp).toBe(givenUpIds.length);
  });

  it("still counts stranded targets after the candidate query learned to filter, which is what a give-up predicate in SQL would empty", async () => {
    // ISS-8895 AC3, the assertion that goes VACUOUS rather than red if the
    // redesign takes the obvious next step. Filtering stale targets out of the
    // page in SQL is the natural way to make the cap mean what it says — and it
    // would permanently zero `targetsGivenUp`, which exists precisely because a
    // stranded target and a presence-covered one both read as `targetsDue: 0`.
    // The page here contains ONLY stranded targets, so a query that dropped
    // them would hand the drain an empty page and this count would be 0.
    const now = 0;
    vi.setSystemTime(now);
    const strandedIds = ["stranded-a", "stranded-b", "stranded-c"];
    mockListIdleDrainCandidates.mockResolvedValue({
      candidates: strandedIds.map((id) =>
        candidate(id, new Date(now - 7 * DAY_MS))
      ),
      hasMore: false,
    });

    const summary = await drainIdleCommandQueues();

    expect(summary.targetsGivenUp).toBe(strandedIds.length);
    // The positive sibling: they are counted AND refused, so a non-zero counter
    // can never be read as work this sweep did.
    expect(summary.targetsDue).toBe(0);
    expect(mockReleaseQueuedCommands).not.toHaveBeenCalled();
  });

  it("keeps sweeping after one target's drain throws", async () => {
    const now = 0;
    vi.setSystemTime(now);
    const ids = ["fails-0", "fails-1", "fails-2"];
    mockListIdleDrainCandidates.mockResolvedValue(
      candidatePage(ids, now, SILENT_EVERY_TICK_MS)
    );
    mockReleaseQueuedCommands.mockRejectedValueOnce(new Error("relay down"));

    const summary = await drainIdleCommandQueues();

    expect(mockReleaseQueuedCommands).toHaveBeenCalledTimes(ids.length);
    // The thrown target contributed an attempt and no released command, which
    // is what keeps a relay outage from reading as successful work.
    expect(summary.targetsAttempted).toBe(ids.length);
    expect(summary.commandsReleased).toBe(ids.length - 1);
  });
});

describe("presenceSilenceMs — the two clocks are not the same clock", () => {
  it("measures from the presence frame when there has been one", () => {
    const now = 10 * HOUR_MS;

    expect(
      presenceSilenceMs(
        candidate("target-present", new Date(now - 3 * HOUR_MS)),
        now
      )
    ).toBe(3 * HOUR_MS);
  });

  it("falls back to creation, not to zero, when no presence frame was ever seen", () => {
    // Zero is the reading that strands the target: it would put every
    // never-present target permanently inside the presence trigger's window,
    // and the presence trigger is exactly what is not covering it.
    const now = 10 * HOUR_MS;

    expect(
      presenceSilenceMs(
        candidate("target-unknown", null, new Date(now - 9 * HOUR_MS)),
        now
      )
    ).toBe(9 * HOUR_MS);
  });
});
