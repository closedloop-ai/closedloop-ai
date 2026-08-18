import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../src/main/agent-sync/session-date-window.js";
import {
  compareOwnerName,
  sessionDurationMs,
  sortSyncedSessions,
} from "../src/main/session/session-working-set-sort.js";
import type { SanitizedQuery } from "../src/main/session/shared-agent-sessions-query.js";

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
    // wongk (#4409): this was a live-clock BOUNDED assertion -- `>= 90m` and
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

  it("keeps the comparator and the cell on one terminal definition (wongk, #4409)", () => {
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

  it("never reaches the clock for an INDETERMINATE status with no end instant", () => {
    // An unrecognized or display-only status asserts nothing about the
    // lifecycle, and the ABSENCE of an end instant is not evidence the run
    // continues. A clock-bound key here would rank a row the cell renders blank
    // as the longest session on the page.
    for (const status of [
      "some-future-status",
      DISPLAYED_SESSION_STATUS.STALE,
    ]) {
      assert.equal(
        sessionDurationMs(
          session({ status, startedAt: START, endedAt: null }),
          new Date(START).getTime() + 90 * 60_000
        ),
        null
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

  it("bounds the LEGACY terminal statuses too (ISS-4586 version skew)", () => {
    for (const status of ["completed", "abandoned"]) {
      assert.equal(
        sessionDurationMs(session({ status, startedAt: START, endedAt: null })),
        null
      );
    }
  });

  it("resolves an unrecognized status by evidence rather than by guess", () => {
    // ISS-4997: an unknown status asserts nothing about the lifecycle. An
    // `endedAt` is evidence the session ended and bounds it.
    assert.equal(
      sessionDurationMs(
        session({
          status: "some-future-status",
          startedAt: START,
          endedAt: new Date(new Date(START).getTime() + 5000).toISOString(),
        })
      ),
      5000
    );
  });
});

const AWAITING = new Date("2026-05-20T17:05:00.000Z").toISOString();

function statusQuery(dir: "asc" | "desc"): SanitizedQuery {
  return {
    startDate: null,
    endDate: null,
    dateWindowField: SESSIONS_SURFACE_DATE_WINDOW_FIELD,
    completedAfter: null,
    harness: null,
    status: null,
    statuses: [],
    userId: null,
    userIds: [],
    repositories: [],
    harnesses: [],
    models: [],
    autonomyTiers: [],
    costBuckets: [],
    changePresence: [],
    prAssociation: [],
    quality: "all",
    search: null,
    countOnly: false,
    limit: 50,
    offset: 0,
    sortBy: "status",
    sortDir: dir,
    hasUnsupportedCloudFilter: false,
    scopeUnsatisfiable: false,
  };
}

function sortStatusIds(
  sessions: SyncedAgentSession[],
  dir: "asc" | "desc"
): string[] {
  return sortSyncedSessions(sessions, statusQuery(dir)).map(
    (s) => s.externalSessionId
  );
}

describe("sortSyncedSessions status column (FEA-4301 desktop-cloud parity)", () => {
  it("orders ASC by the DISPLAYED status lifecycle, mirroring the cloud rank", () => {
    const sessions = [
      session({ externalSessionId: "abandoned", status: "abandoned" }),
      session({ externalSessionId: "active", status: "active" }),
      session({ externalSessionId: "failed", status: "failed" }),
      // Stored `active`, but awaiting input → DISPLAYS as Waiting.
      session({
        externalSessionId: "waiting",
        status: "active",
        awaitingInputSince: AWAITING,
      }),
      session({ externalSessionId: "completed", status: "completed" }),
    ];
    // ISS-5592, in two steps. First the retired spellings stopped keying the
    // rank map on either surface; now the `failed` ALIAS has too, since nothing
    // manufactures it. All three degrade to the unrecognized rank, which is
    // still parity — the cloud `DISPLAYED_STATUS_RANK` is keyed by
    // `DisplayedSessionStatus` and never held `failed` either.
    //
    // Equal ranks fall to the stable sort's input order, which is why these
    // three keep the order the fixture declares them in rather than an
    // alphabetical one.
    assert.deepEqual(sortStatusIds(sessions, "asc"), [
      "active",
      "waiting",
      "abandoned",
      "failed",
      "completed",
    ]);
  });

  it("sorts a displayed-Waiting row (stored active) as Waiting, not among Active rows", () => {
    const sessions = [
      session({ externalSessionId: "completed", status: "completed" }),
      session({
        externalSessionId: "waiting",
        status: "active",
        awaitingInputSince: AWAITING,
      }),
      session({ externalSessionId: "active", status: "active" }),
    ];
    // A raw-string sort would have collapsed `waiting` onto `active` (both store
    // "active"); the projected rank lands it between Active and Completed.
    assert.deepEqual(sortStatusIds(sessions, "asc"), [
      "active",
      "waiting",
      "completed",
    ]);
  });

  it("does not project Waiting for an awaiting-input row that has ended", () => {
    const sessions = [
      session({ externalSessionId: "active", status: "active" }),
      // Ended → the Waiting projection is suppressed; stays Active.
      session({
        externalSessionId: "ended-awaiting",
        status: "active",
        awaitingInputSince: AWAITING,
        endedAt: new Date("2026-05-20T17:10:00.000Z").toISOString(),
      }),
    ];
    // Both display as Active → equal rank → stable incoming order preserved.
    assert.deepEqual(sortStatusIds(sessions, "asc"), [
      "active",
      "ended-awaiting",
    ]);
  });

  it("keeps an UNKNOWN status LAST in BOTH directions (never promoted to the front on desc)", () => {
    // ISS-5592: the third row must carry a status the rank map still KNOWS.
    // This case used `completed`, which is unrecognized now — it would have
    // tied with `quantum-flux` at the unknown rank and the test would have
    // asserted nothing about known-vs-unknown ordering.
    const sessions = [
      session({ externalSessionId: "unknown", status: "quantum-flux" }),
      session({ externalSessionId: "active", status: "active" }),
      session({ externalSessionId: "inactive", status: "inactive" }),
    ];
    assert.deepEqual(sortStatusIds(sessions, "asc"), [
      "active",
      "inactive",
      "unknown",
    ]);
    // On desc the KNOWN ranks reverse, but the unknown status stays last — a
    // direction-flipped raw rank would have put it first here.
    assert.deepEqual(sortStatusIds(sessions, "desc"), [
      "inactive",
      "active",
      "unknown",
    ]);
  });
});
