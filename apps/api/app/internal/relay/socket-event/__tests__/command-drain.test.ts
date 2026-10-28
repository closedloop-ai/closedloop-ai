/**
 * ISS-8453 AC-001: the half that makes throttling the reconnect flush safe.
 *
 * Nothing else in the cloud re-dispatches a queued command — the create route
 * attempts delivery once and leaves the row `queued` on `delivered:false` — so
 * without this drain a command held back by the flush cap is stranded until the
 * next reconnect, which is a worse defect than the burst it replaces.
 */

import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { RelayDispatchReason } from "@repo/api/src/types/relay-dispatch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IN_FLIGHT_COMMANDS_CEILING } from "@/lib/desktop-gateway-types";

const mockDispatchRelayCommandToRelay = vi.hoisted(() => vi.fn());
const mockFindById = vi.hoisted(() => vi.fn());
const mockCountInFlightCommandsForDispatch = vi.hoisted(() => vi.fn());
const mockListQueuedCommandsForDispatch = vi.hoisted(() => vi.fn());
const mockAcquireCommandDrainLease = vi.hoisted(() => vi.fn());
const mockRenewCommandDrainLease = vi.hoisted(() => vi.fn());
const mockReleaseCommandDrainLease = vi.hoisted(() => vi.fn());

vi.mock(
  "@/app/compute-targets/relay-command-helpers",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/app/compute-targets/relay-command-helpers")
      >();
    return {
      ...original,
      dispatchRelayCommandToRelay: mockDispatchRelayCommandToRelay,
    };
  }
);

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findById: mockFindById },
  isComputeTargetGatewayConflictResult: () => false,
}));

vi.mock("@/lib/desktop-command-dispatch-queries", () => ({
  acquireCommandDrainLease: mockAcquireCommandDrainLease,
  renewCommandDrainLease: mockRenewCommandDrainLease,
  releaseCommandDrainLease: mockReleaseCommandDrainLease,
  countInFlightCommandsForDispatch: mockCountInFlightCommandsForDispatch,
  listQueuedCommandsForDispatch: mockListQueuedCommandsForDispatch,
}));

const {
  COMMAND_DRAIN_LEASE_TTL_MS,
  normalizeMaxInFlightCommands,
  releaseQueuedCommands,
} = await import("../service/command-drain");

const TARGET_ID = "target-drain-1";

/**
 * A stand-in for `compute_targets.command_drain_lease_until` with the property
 * the real column has and a rubber-stamped `true` does not: the expiry is
 * stamped from the clock AT THE MOMENT THE STATEMENT RUNS, and renew and
 * release both match on the exact value the caller currently holds.
 *
 * Modelling the database's clock rather than the caller's is the point. The
 * defect whitlockk found on PR #7119 is that the reads between acquire and dispatch
 * can outlast the lease, and a model that trusted a caller-supplied expiry
 * could not express that at all.
 */
let leaseUntil: number | null = null;

function installLeaseColumn(): void {
  leaseUntil = null;
  mockAcquireCommandDrainLease.mockImplementation(
    (_targetId: string, ttlMs: number) => {
      const now = Date.now();
      if (leaseUntil !== null && leaseUntil > now) {
        return Promise.resolve(null);
      }
      leaseUntil = now + ttlMs;
      return Promise.resolve(new Date(leaseUntil));
    }
  );
  mockRenewCommandDrainLease.mockImplementation(
    (_targetId: string, heldUntil: Date, ttlMs: number) => {
      if (leaseUntil !== heldUntil.getTime()) {
        return Promise.resolve(null);
      }
      leaseUntil = Date.now() + ttlMs;
      return Promise.resolve(new Date(leaseUntil));
    }
  );
  mockReleaseCommandDrainLease.mockImplementation(
    (_targetId: string, heldUntil: Date) => {
      if (leaseUntil === heldUntil.getTime()) {
        leaseUntil = null;
      }
      return Promise.resolve();
    }
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {
    // Replaced synchronously by the executor below.
  };
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
}

function queuedCommand(index: number) {
  return {
    commandId: `cmd-${index}`,
    computeTargetId: TARGET_ID,
    operationId: "health_check",
    status: DesktopCommandStatus.Queued,
    lastSequenceAcked: 0,
    method: "POST" as const,
    path: "/api/gateway/health-check",
    createdAt: new Date(Date.UTC(2026, 7, 28, 18, index)).toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindById.mockResolvedValue({
    id: TARGET_ID,
    capabilities: { maxInFlightCommands: 3 },
  });
  mockDispatchRelayCommandToRelay.mockResolvedValue({ delivered: true });
  mockCountInFlightCommandsForDispatch.mockResolvedValue(0);
  mockListQueuedCommandsForDispatch.mockResolvedValue([]);
  installLeaseColumn();
});

describe("releaseQueuedCommands", () => {
  it("releases exactly the free slots, never the whole backlog", async () => {
    // Written out rather than read back off the capability under test.
    const DECLARED_CEILING = 3;
    const ALREADY_IN_FLIGHT = 1;
    const EXPECTED_FREE = 2;

    mockCountInFlightCommandsForDispatch.mockResolvedValue(ALREADY_IN_FLIGHT);
    mockListQueuedCommandsForDispatch.mockResolvedValue([
      queuedCommand(0),
      queuedCommand(1),
    ]);

    const released = await releaseQueuedCommands(TARGET_ID);

    // The cap is applied in SQL, so the query itself must carry it — asking for
    // the whole backlog and slicing after would make a deep queue quadratic.
    expect(mockListQueuedCommandsForDispatch).toHaveBeenCalledWith(
      TARGET_ID,
      DECLARED_CEILING - ALREADY_IN_FLIGHT
    );
    expect(mockDispatchRelayCommandToRelay).toHaveBeenCalledTimes(
      EXPECTED_FREE
    );
    expect(released).toBe(EXPECTED_FREE);
  });

  it("counts only canonical gateway commands as in flight", async () => {
    // The general store count includes legacy accepted/running rows. They are
    // deliberately not replayable, so counting them here would leave the
    // desktop at a false ceiling and starve otherwise-valid queued work.
    mockCountInFlightCommandsForDispatch.mockResolvedValue(0);
    mockListQueuedCommandsForDispatch.mockResolvedValue([queuedCommand(0)]);

    const released = await releaseQueuedCommands(TARGET_ID);

    expect(mockCountInFlightCommandsForDispatch).toHaveBeenCalledWith(
      TARGET_ID
    );
    expect(mockListQueuedCommandsForDispatch).toHaveBeenCalledWith(
      TARGET_ID,
      3
    );
    expect(mockDispatchRelayCommandToRelay).toHaveBeenCalledTimes(1);
    expect(released).toBe(1);
  });

  it("releases nothing while the ceiling is already full", async () => {
    mockCountInFlightCommandsForDispatch.mockResolvedValue(3);

    const released = await releaseQueuedCommands(TARGET_ID);

    expect(mockDispatchRelayCommandToRelay).not.toHaveBeenCalled();
    expect(mockListQueuedCommandsForDispatch).not.toHaveBeenCalled();
    expect(released).toBe(0);
  });

  // The positive sibling of the assertion above: the same spy must fire when a
  // slot IS free, or "not called" would pass for a drain that never works.
  it("releases as soon as one slot frees under the same ceiling", async () => {
    mockCountInFlightCommandsForDispatch.mockResolvedValue(2);
    mockListQueuedCommandsForDispatch.mockResolvedValue([queuedCommand(0)]);

    const released = await releaseQueuedCommands(TARGET_ID);

    expect(mockDispatchRelayCommandToRelay).toHaveBeenCalledTimes(1);
    expect(released).toBe(1);
  });

  // The guard that made hello and the drain disagree. hello floored a declared
  // 0 to 1 and withheld the rest; the drain read the SAME 0 as "no ceiling
  // stated" and bailed before counting anything, so the withheld tail could
  // never be released — throttled by one half, un-drainable by the other. The
  // desktop's own scheduler floors it to 1, so flooring is the agreeing answer.
  it.each([
    { label: "zero", declared: 0 },
    { label: "negative", declared: -3 },
    { label: "fractional", declared: 1.5 },
  ])(
    "floors a $label ceiling to 1 instead of disabling the drain",
    async ({ declared }) => {
      mockFindById.mockResolvedValue({
        id: TARGET_ID,
        capabilities: { maxInFlightCommands: declared },
      });
      mockCountInFlightCommandsForDispatch.mockResolvedValue(0);
      mockListQueuedCommandsForDispatch.mockResolvedValue([queuedCommand(0)]);

      const released = await releaseQueuedCommands(TARGET_ID);

      expect(mockListQueuedCommandsForDispatch).toHaveBeenCalledWith(
        TARGET_ID,
        1
      );
      expect(released).toBe(1);
    }
  );

  // ISS-8547: the declared value was floored but never capped, so it became
  // the Prisma `take` of this read and, downstream, the width of the
  // `Promise.all` that opens one relay POST per row.
  it("caps the dispatch read at the ceiling when the declared value is unbounded", async () => {
    mockFindById.mockResolvedValue({
      id: TARGET_ID,
      capabilities: { maxInFlightCommands: Number.MAX_SAFE_INTEGER },
    });
    mockCountInFlightCommandsForDispatch.mockResolvedValue(0);
    mockListQueuedCommandsForDispatch.mockResolvedValue([queuedCommand(0)]);

    await releaseQueuedCommands(TARGET_ID);

    expect(mockListQueuedCommandsForDispatch).toHaveBeenCalledWith(
      TARGET_ID,
      MAX_IN_FLIGHT_COMMANDS_CEILING
    );
  });

  // The mutation this catches: a clamp broad enough to also clip a value that
  // never needed one.
  it("passes a declared ceiling below the cap through to the dispatch read unchanged", async () => {
    mockFindById.mockResolvedValue({
      id: TARGET_ID,
      capabilities: { maxInFlightCommands: 2 },
    });
    mockCountInFlightCommandsForDispatch.mockResolvedValue(0);
    mockListQueuedCommandsForDispatch.mockResolvedValue([queuedCommand(0)]);

    await releaseQueuedCommands(TARGET_ID);

    expect(mockListQueuedCommandsForDispatch).toHaveBeenCalledWith(
      TARGET_ID,
      2
    );
  });

  it("does not throttle a desktop that declared no ceiling", async () => {
    mockFindById.mockResolvedValue({ id: TARGET_ID, capabilities: {} });

    const released = await releaseQueuedCommands(TARGET_ID);

    // Absent is not zero: an older desktop keeps its previous behaviour rather
    // than having its queue frozen by a limit it never stated.
    expect(mockListQueuedCommandsForDispatch).not.toHaveBeenCalled();
    expect(released).toBe(0);
  });

  it("counts a dispatch the relay refused as not released", async () => {
    mockCountInFlightCommandsForDispatch.mockResolvedValue(1);
    mockListQueuedCommandsForDispatch.mockResolvedValue([
      queuedCommand(0),
      queuedCommand(1),
    ]);
    mockDispatchRelayCommandToRelay
      .mockResolvedValueOnce({ delivered: true })
      .mockResolvedValueOnce({
        delivered: false,
        reason: RelayDispatchReason.TargetNotConnected,
      });

    const released = await releaseQueuedCommands(TARGET_ID);

    expect(released).toBe(1);
  });

  it("survives a dispatch that throws, leaving the command queued", async () => {
    mockCountInFlightCommandsForDispatch.mockResolvedValue(0);
    mockListQueuedCommandsForDispatch.mockResolvedValue([queuedCommand(0)]);
    mockDispatchRelayCommandToRelay.mockRejectedValue(new Error("relay down"));

    // Must not reject: this runs off a command ack that still has to answer.
    await expect(releaseQueuedCommands(TARGET_ID)).resolves.toBe(0);
    // And the lease is handed back on the failing path too, on the token the
    // holder actually ended up with. A `finally` that released the acquire's
    // original value would leave the row set here.
    expect(leaseUntil).toBeNull();
  });

  it("dispatches nothing, and reads nothing, when another instance holds the lease", async () => {
    // davetho, PR #7119. The refusal arm, stated on its own: every other case
    // in this file takes the lease, so deleting the acquire check would leave
    // them all green while concurrent triggers over-dispatched. The reads are
    // asserted absent as well as the dispatch, because the gate is deliberately
    // in front of them — a refused holder must not pay for the two queries.
    mockAcquireCommandDrainLease.mockResolvedValue(null);
    mockCountInFlightCommandsForDispatch.mockResolvedValue(0);
    mockListQueuedCommandsForDispatch.mockResolvedValue([queuedCommand(0)]);

    await expect(releaseQueuedCommands(TARGET_ID)).resolves.toBe(0);

    expect(mockCountInFlightCommandsForDispatch).not.toHaveBeenCalled();
    expect(mockListQueuedCommandsForDispatch).not.toHaveBeenCalled();
    expect(mockDispatchRelayCommandToRelay).not.toHaveBeenCalled();
    expect(mockRenewCommandDrainLease).not.toHaveBeenCalled();
    // And it does not run the hand-back: releasing on a lease it never took
    // would clear the holder's row and reopen the concurrent dispatch.
    expect(mockReleaseCommandDrainLease).not.toHaveBeenCalled();
  });
});

/**
 * whitlockk, PR #7119. `COMMAND_DRAIN_LEASE_TTL_MS` is 15s. Each of the two reads
 * between the acquire and the dispatch takes its own pooled connection, and a
 * wait for one is bounded by `DB_POOL_ACQUIRE_TIMEOUT_MS` at 30s — per
 * acquisition — so a stalled pool puts up to 60s of reading inside a 15s
 * window. Before the renewal, the holder that came out of that read went on to
 * dispatch against a lease another instance had already taken, which is the
 * `N x ceiling` the lease exists to stop with the lease in place.
 */
describe("releaseQueuedCommands under a stalled read", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
    installLeaseColumn();
  });

  // Unconditional, so a throw between the two lines cannot leak a frozen clock
  // into every later case in this worker.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses the holder whose reads outran its lease, so only one instance dispatches", async () => {
    const stalledRead = deferred<number>();
    mockCountInFlightCommandsForDispatch
      .mockImplementationOnce(() => stalledRead.promise)
      .mockImplementation(() => Promise.resolve(0));
    mockListQueuedCommandsForDispatch.mockResolvedValue([queuedCommand(0)]);

    const stalledHolder = releaseQueuedCommands(TARGET_ID);
    // Let it take the lease and reach the read before the clock moves;
    // otherwise the second holder simply loses the acquire race and the case
    // proves nothing about the expiry.
    await vi.advanceTimersByTimeAsync(0);
    expect(mockCountInFlightCommandsForDispatch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(COMMAND_DRAIN_LEASE_TTL_MS + 1000);

    // The lease has lapsed, so this instance legitimately claims the target.
    await expect(releaseQueuedCommands(TARGET_ID)).resolves.toBe(1);

    stalledRead.resolve(0);
    await expect(stalledHolder).resolves.toBe(0);

    // ONE dispatch across both holders. Delete the renewal and this is 2.
    expect(mockDispatchRelayCommandToRelay).toHaveBeenCalledTimes(1);
  });

  it("hands the renewed lease back on a completed drain, so the next trigger is not locked out for a TTL", async () => {
    // The mutation this kills: releasing the token the acquire returned instead
    // of the one the renewal wrote. That release matches nothing, and every
    // successful drain would then cost the target a full TTL of refusals.
    //
    // The read has to consume some of the window for that to be observable at
    // all — with a frozen clock the renewal rewrites the same millisecond and
    // the stale token still matches, which is true of `TIMESTAMP(3)` too.
    mockCountInFlightCommandsForDispatch.mockImplementation(() => {
      vi.setSystemTime(Date.now() + 5000);
      return Promise.resolve(0);
    });
    mockListQueuedCommandsForDispatch.mockResolvedValue([queuedCommand(0)]);

    await expect(releaseQueuedCommands(TARGET_ID)).resolves.toBe(1);

    expect(leaseUntil).toBeNull();
  });
});

describe("normalizeMaxInFlightCommands", () => {
  // ISS-8547: the mutation this must kill is a clamp that only floors and
  // never caps — an unbounded declared value must not survive verbatim.
  it("clamps an unbounded declared value to the ceiling instead of returning it verbatim", () => {
    expect(normalizeMaxInFlightCommands(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_IN_FLIGHT_COMMANDS_CEILING
    );
  });

  it("reports the clamp via onClamped when the declared value exceeds the ceiling", () => {
    const onClamped = vi.fn();

    normalizeMaxInFlightCommands(Number.MAX_SAFE_INTEGER, onClamped);

    expect(onClamped).toHaveBeenCalledWith({
      declared: Number.MAX_SAFE_INTEGER,
      applied: MAX_IN_FLIGHT_COMMANDS_CEILING,
    });
  });

  it("does not report a clamp for a declared value already within the ceiling", () => {
    const onClamped = vi.fn();

    normalizeMaxInFlightCommands(2, onClamped);

    expect(onClamped).not.toHaveBeenCalled();
  });

  // The hole the first clamp left (ISS-8547 review): a finite magnitude PAST the
  // safe-integer range fell through `Number.isSafeInteger` to `undefined`, and
  // absence means UNTHROTTLED — hello emits the whole backlog for it. So the one
  // input furthest out of range bought exactly the fan-out the cap exists to
  // stop. Asserting the ceiling rather than `not.toBeUndefined()` is what makes
  // this fail if the guard is restored.
  it.each([1e20, Number.MAX_VALUE, 2 ** 53])(
    "clamps the finite unsafe magnitude %p to the ceiling rather than to absence",
    (declared) => {
      expect(normalizeMaxInFlightCommands(declared)).toBe(
        MAX_IN_FLIGHT_COMMANDS_CEILING
      );
    }
  );

  it("floors a finite unsafe NEGATIVE magnitude to 1 rather than to absence", () => {
    expect(normalizeMaxInFlightCommands(-1e20)).toBe(1);
  });

  // Absence is still absence, and it still means unthrottled. Without this the
  // clamp above could be "widened" into swallowing a genuinely absent ceiling,
  // which would freeze an older desktop's queue behind a limit it never stated.
  it.each([
    ["absent", undefined],
    ["a non-number", "64"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("returns undefined for %s", (_label, declared) => {
    expect(normalizeMaxInFlightCommands(declared)).toBeUndefined();
  });
});
