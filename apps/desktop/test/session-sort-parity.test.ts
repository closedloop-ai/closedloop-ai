import assert from "node:assert/strict";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, it } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  compareOwnerName,
  sessionDurationMs,
  sortSyncedSessions,
} from "../src/main/session/session-working-set-sort.js";
import { projectDisplayedSharedStatus } from "../src/main/session/shared-agent-session-status.js";
import { sessionSortQuery } from "./helpers/session-sort-query.js";

// FEA-4300/FEA-4297 (thread #8): the desktop Local Sessions sort must mirror the
// cloud's display-value semantics so the SAME table sorts identically whether it
// is backed by the API or the local adapter — Owner by DISPLAYED name (nulls
// last, both directions) and, since ISS-5131, Duration by the session's own wall
// time (`now - start` while running, `end - start` once terminal), nulls-last for
// the rows whose cell renders blank.

const START = "2026-05-20T17:00:00.000Z";

function session(overrides: Partial<SyncedAgentSession>): SyncedAgentSession {
  return {
    startedAt: START,
    ...overrides,
  } as SyncedAgentSession;
}

describe("compareOwnerName (FEA-4300/FEA-4330 desktop-cloud parity)", () => {
  it("orders resolved names ascending, negated for descending", () => {
    assert.ok(compareOwnerName("ada lovelace", "zed young", "asc") < 0);
    assert.ok(compareOwnerName("ada lovelace", "zed young", "desc") > 0);
  });

  it("keeps a null owner LAST in BOTH directions (nulls-last, matching the cloud)", () => {
    // A plain Postgres `{ email: dir }` would float nulls to the TOP on desc; the
    // cloud now keeps them last both ways, and so must the local adapter.
    assert.ok(compareOwnerName(null, "ada", "asc") > 0);
    assert.ok(compareOwnerName(null, "ada", "desc") > 0);
    assert.ok(compareOwnerName("ada", null, "asc") < 0);
    assert.ok(compareOwnerName("ada", null, "desc") < 0);
    assert.equal(compareOwnerName(null, null, "asc"), 0);
  });
});

describe("sessionDurationMs (ISS-5131 desktop-cloud parity)", () => {
  const HOUR_MS = 3_600_000;

  it("measures a terminal session startedAt -> endedAt", () => {
    assert.equal(
      sessionDurationMs(
        session({
          status: SESSION_STATUS.INACTIVE,
          startedAt: START,
          endedAt: new Date(new Date(START).getTime() + 5000).toISOString(),
        })
      ),
      5000
    );
  });

  it("ignores a lastActivityAt that runs past endedAt, and the collector wallClock", () => {
    // The reported session `019fb3e3`: `lastActivityAt` tracks SYNC time and
    // lands six days past `endedAt`, and `wallClock` was derived from that same
    // anchor. Keying on either would order the Local page against a number the
    // row no longer renders -- the non-monotonic paint ISS-4675 fixed on the
    // cloud comparator, reintroduced through a different input.
    assert.equal(
      sessionDurationMs(
        session({
          status: SESSION_STATUS.INACTIVE,
          startedAt: START,
          endedAt: new Date(new Date(START).getTime() + HOUR_MS).toISOString(),
          lastActivityAt: new Date(
            new Date(START).getTime() + 170 * HOUR_MS
          ).toISOString(),
          wallClock: "170h 30m",
        })
      ),
      HOUR_MS
    );
  });

  it("measures a RUNNING session against the clock it is handed", () => {
    // whitlockk (#4409): this was a live-clock BOUNDED assertion -- `>= 90m` and
    // `< 91m` around a `Date.now()` the production code read separately. The
    // repo bans those: scheduler delay can flake it, and a one-minute range is
    // wide enough to hide a real regression. The clock is an argument now, so
    // the span is exact. Same fix as the cloud twin in
    // `apps/api/app/agent-sessions/service/session-display-sort.test.ts`.
    assert.equal(
      sessionDurationMs(
        session({
          status: SESSION_STATUS.ACTIVE,
          startedAt: START,
          endedAt: null,
        }),
        new Date(START).getTime() + 90 * 60_000
      ),
      90 * 60_000
    );
  });

  it("keeps the comparator and the cell on one terminal definition (whitlockk, #4409)", () => {
    // Two hand-rolled terminal-status lists once put one session's cell and its
    // own sort key on opposite sides of the branch: a live, growing duration in
    // the cell, sorted with the blanks. ISS-5592 removed the `failed` alias that
    // made them diverge, so this now drives the canonical `error` — the invariant
    // is the shared classifier, not the spelling that exposed it.
    assert.equal(
      sessionDurationMs(
        session({ status: "error", startedAt: START, endedAt: null }),
        new Date(START).getTime() + 90 * 60_000
      ),
      null
    );
    assert.equal(
      sessionDurationMs(
        session({
          status: SESSION_STATUS.ERROR,
          startedAt: START,
          endedAt: null,
        }),
        new Date(START).getTime() + 90 * 60_000
      ),
      null
    );
    assert.equal(
      sessionDurationMs(
        session({
          status: SESSION_STATUS.ACTIVE,
          startedAt: START,
          endedAt: null,
        }),
        new Date(START).getTime() + 90 * 60_000
      ),
      90 * 60_000
    );
  });

  it("keeps timing an unrecognized or display-only status against the clock it is handed (ISS-10364)", () => {
    // ISS-10364 (operator ruling 2026-09-23): there is no more Indeterminate
    // fold for these spellings. `normalizeSessionStatus` fails an unrecognized
    // value open to Active exactly like the literal `stale` spelling now
    // does, so both reach the clock instead of declining to. Kept as the
    // counterfactual: `null` here would mean the retired fold came back.
    for (const status of ["some-future-status", "stale"]) {
      assert.equal(
        sessionDurationMs(
          session({ status, startedAt: START, endedAt: null }),
          new Date(START).getTime() + 90 * 60_000
        ),
        90 * 60_000
      );
    }
  });

  it("returns null for a clock-skew (end before start) span, matching the blank cell", () => {
    assert.equal(
      sessionDurationMs(
        session({
          status: SESSION_STATUS.INACTIVE,
          startedAt: START,
          endedAt: new Date(new Date(START).getTime() - 5000).toISOString(),
        })
      ),
      null
    );
  });

  it("returns null for a TERMINAL session with no end instant", () => {
    // One instant is not a span, so the cell renders blank and the key must be
    // null -- nulls-last in both directions, never a 0 among the real minima.
    assert.equal(
      sessionDurationMs(
        session({
          status: SESSION_STATUS.INACTIVE,
          startedAt: START,
          endedAt: null,
          lastActivityAt: null,
        })
      ),
      null
    );
  });

  it("keeps the LEGACY terminal statuses timing against the clock too (ISS-10364)", () => {
    // ISS-4586 named these "version skew"; ISS-10364 changed what an
    // unrecognized status now means for duration — see the note above. Pinned
    // with an EXPLICIT clock rather than the original no-argument call, which
    // read the real wall clock and would have made this suite non-deterministic
    // now that the row is no longer bounded by its (absent) `endedAt`.
    for (const status of ["completed", "abandoned"]) {
      assert.equal(
        sessionDurationMs(
          session({ status, startedAt: START, endedAt: null }),
          new Date(START).getTime() + 90 * 60_000
        ),
        90 * 60_000
      );
    }
  });

  it("no longer bounds an unrecognized status by its recorded end (ISS-10364)", () => {
    // ISS-10364 (operator ruling 2026-09-23): `resolveDisplayedSessionStatus`
    // folds an unrecognized spelling straight to Active regardless of a
    // genuine `endedAt`, so the row keeps timing against the clock instead of
    // bounding at its recorded end. Kept as the counterfactual for the claim
    // ISS-4997 established (an `endedAt` bounds an unrecognized status),
    // pinned with an explicit clock: the original no-argument call read the
    // real wall clock, which this new unbounded behavior would have made
    // genuinely non-deterministic.
    assert.equal(
      sessionDurationMs(
        session({
          status: "some-future-status",
          startedAt: START,
          endedAt: new Date(new Date(START).getTime() + 5000).toISOString(),
        }),
        new Date(START).getTime() + 90 * 60_000
      ),
      90 * 60_000
    );
  });
});

function sortStatusIds(
  sessions: SyncedAgentSession[],
  dir: "asc" | "desc"
): string[] {
  return sortSyncedSessions(sessions, sessionSortQuery("status", dir)).map(
    (s) => s.externalSessionId
  );
}

/**
 * ISS-9939 / ISS-10262 (davetho, PR #7289 review): the desktop Local
 * Sessions Status SORT must move with the cloud's — the FEA-4301
 * desktop-cloud parity suite this replaces pinned BOTH surfaces to the
 * DISPLAYED-status rank, and moving only the cloud half would have reopened
 * exactly the drift class that suite existed to close: an awaiting-input
 * session (stored `active`) sorting with Active in cloud and with Waiting
 * locally.
 *
 * The new contract is a plain PERSISTED-status string comparison — no rank
 * table, matching the ISS-9939 ruling's "no denormalized column, no
 * maintained writer, no rank table" and the cloud `dbColumnOrderBy`/
 * `bindSortRule` "status" cases. DISPLAY (`projectDisplayedSharedStatus`),
 * the Status FACET (`matchesStatusFilter`), and Duration
 * (`resolveDisplayedSharedSessionStatus`, exercised above) are UNCHANGED —
 * this suite pins that a Waiting-displayed row still projects as Waiting
 * even though it no longer SORTS as Waiting.
 */
describe("sortSyncedSessions status column (ISS-9939 / ISS-10262)", () => {
  it("orders ASC by the raw persisted lifecycle string: active < error < inactive", () => {
    const sessions = [
      session({ externalSessionId: "c", status: SESSION_STATUS.INACTIVE }),
      session({ externalSessionId: "a", status: SESSION_STATUS.ACTIVE }),
      session({ externalSessionId: "b", status: SESSION_STATUS.ERROR }),
    ];
    assert.deepEqual(sortStatusIds(sessions, "asc"), ["a", "b", "c"]);
    assert.deepEqual(sortStatusIds(sessions, "desc"), ["c", "b", "a"]);
  });

  it("sorts a row awaiting input (stored active) WITH the other Active rows, unaffected by the retired Waiting badge", () => {
    // The deliberate FEA-4301 reversal, together with the cloud: a raw-string
    // sort collapses `waiting`'s shape onto `active` (both store "active"),
    // which is the INTENDED behavior on both surfaces rather than the bug
    // FEA-4301 fixed.
    //
    // ISS-10364 (operator ruling 2026-09-23): the badge assertion below used
    // to prove the row was genuinely Waiting-displayed before checking it
    // still SORTS with Active; the badge itself is retired, so it now reads
    // plain Active too. The sort contract this test is actually about was
    // already independent of the badge (ISS-9939 moved the Status SORT onto
    // the raw persisted string) and is unchanged.
    const waiting = session({
      externalSessionId: "waiting",
      status: SESSION_STATUS.ACTIVE,
      awaitingInputSince: new Date("2026-05-20T17:05:00.000Z").toISOString(),
    });
    assert.equal(projectDisplayedSharedStatus(waiting), SESSION_STATUS.ACTIVE);
    const sessions = [
      session({
        externalSessionId: "inactive",
        status: SESSION_STATUS.INACTIVE,
      }),
      waiting,
      session({ externalSessionId: "active", status: SESSION_STATUS.ACTIVE }),
    ];
    // "active" ties between `waiting` and `active` (both persist that literal
    // string), so the stable sort keeps their INCOMING relative order —
    // `waiting` before `active` — both ahead of "inactive".
    assert.deepEqual(sortStatusIds(sessions, "asc"), [
      "waiting",
      "active",
      "inactive",
    ]);
  });

  it("orders a locally-stored `waiting` literal by its own raw spelling, matching cloud's raw comparison", () => {
    // marisolashgrove (#7289 review): the ISS-5981 migration deliberately leaves
    // a LIVE-AND-ANCHORLESS session (`sessionEndedAt` null,
    // `awaitingInputSince` null) storing the literal "waiting" on the CLOUD
    // side too — it is not a desktop-only legacy spelling, and no later
    // migration drains it. So this no longer folds it to Active: both
    // surfaces compare the raw string, and "waiting" sorts after "inactive"
    // ascending like any other value outside the three-member lifecycle set.
    const sessions = [
      session({
        externalSessionId: "inactive",
        status: SESSION_STATUS.INACTIVE,
      }),
      session({ externalSessionId: "waiting-literal", status: "waiting" }),
      session({ externalSessionId: "active", status: SESSION_STATUS.ACTIVE }),
    ];
    assert.deepEqual(sortStatusIds(sessions, "asc"), [
      "active",
      "inactive",
      "waiting-literal",
    ]);
  });

  it("orders an unrecognized future status by its own raw spelling, not by a fail-open guess", () => {
    const sessions = [
      session({
        externalSessionId: "inactive",
        status: SESSION_STATUS.INACTIVE,
      }),
      session({ externalSessionId: "unknown", status: "some-future-status" }),
      session({ externalSessionId: "active", status: SESSION_STATUS.ACTIVE }),
    ];
    assert.deepEqual(sortStatusIds(sessions, "asc"), [
      "active",
      "inactive",
      "unknown",
    ]);
  });
});
