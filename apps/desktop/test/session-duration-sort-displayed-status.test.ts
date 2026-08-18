import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { UNRECOGNIZED_SESSION_STATUS } from "@repo/api/src/agent-session-displayed-status-parity.test-fixtures";
import {
  DURATION_SORT_PARITY_CASES,
  type DurationSortParityCase,
  expectedDurationSortIds,
} from "@repo/api/src/session-duration-sort-parity.test-fixtures";
import {
  DISPLAYED_SESSION_STATUS,
  resolveDisplayedSessionStatus,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { setDisplayedStatusParityResolver } from "../src/main/session/displayed-status-parity-gate.js";
import {
  sessionDurationMs,
  sortSyncedSessions,
} from "../src/main/session/session-working-set-sort.js";
import { mapListItem } from "../src/main/session/shared-agent-sessions-api.js";
import { sessionSortQuery } from "./helpers/session-sort-query.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

/**
 * ISS-6270: the desktop Local Duration comparator must key on the status the row
 * DISPLAYS, not on the raw stored column.
 *
 * ISS-5575 routed the Duration CELL through `resolveDisplayedSessionStatus` and
 * left this comparator reading `session.status`. A run silent past the staleness
 * cutoff renders an EMPTY Duration cell — it is not accumulating time — while the
 * comparator measured `now - start` off the raw `active` status and made it the
 * longest span in the table, so sorting by Duration descending put rows
 * displaying nothing at the top of the page.
 *
 * The expected order is NOT written here. It comes from
 * `DURATION_SORT_PARITY_CASES.displayedSpanMs` — the span the real
 * `agentSessionToSessionTableRow` renders, pinned by
 * `packages/app/agents/lib/__tests__/session-duration-sort-parity.test.ts`, which
 * this main-process suite cannot import. The cloud comparator asserts against the
 * SAME table, so the two surfaces are compared to one oracle rather than to two
 * per-file constants — which is exactly what let this defect survive ISS-5575.
 */

/**
 * wongk (#5111): a fixed instant, and the clock the suite FREEZES to it.
 *
 * `sortSyncedSessions` takes no clock — a running row's key is measured against
 * `Date.now()` inside `sessionDurationMs`, and the staleness fold behind it
 * reads `now` — so this is a freshness/clock-boundary suite, which the root
 * `AGENTS.md` requires to pin time rather than read the wall clock. Reading
 * `Date.now()` at module load left every fixture expressed as an offset from an
 * instant a few milliseconds BEHIND the one production would go on to read; the
 * spans happened to be hours apart, so nothing failed, but no assertion could
 * pin an exact span through the default-clock path.
 *
 * Frozen per test rather than once for the file, and restored in `afterEach`, so
 * a case that advances the clock cannot leak into the next one.
 */
const NOW_MS = Date.parse("2026-03-05T12:00:00.000Z");

function syncedSession(
  testCase: DurationSortParityCase,
  status: string
): SyncedAgentSession {
  const startedAt = new Date(NOW_MS - testCase.startedBeforeMs);
  return {
    externalSessionId: testCase.id,
    status,
    startedAt: startedAt.toISOString(),
    lastActivityAt: new Date(NOW_MS - testCase.silentForMs).toISOString(),
    endedAt:
      testCase.endedAfterStartMs === null
        ? null
        : new Date(
            startedAt.getTime() + testCase.endedAfterStartMs
          ).toISOString(),
    awaitingInputSince:
      testCase.awaitingInputSinceBeforeMs === null
        ? null
        : new Date(NOW_MS - testCase.awaitingInputSinceBeforeMs).toISOString(),
    tokenUsageByModel: [],
  } as unknown as SyncedAgentSession;
}

const MALFORMED_ACTIVITY_ID = "d-malformed-activity";

/**
 * wongk (#5111): a row whose PERSISTED `lastActivityAt` does not parse, on a
 * start time recent enough that the start time alone is NOT stale.
 *
 * That combination is what separates the two projections: the producer parses
 * the malformed string to the epoch (Stale, blank cell), while resolving the
 * first PARSEABLE of the raw pair skips it and lands on the recent start time
 * (Active, a span growing against the clock). Shared by both cases below so the
 * key assertion and the order assertion cannot drift onto different rows.
 */
function malformedActivitySession(): SyncedAgentSession {
  return {
    externalSessionId: MALFORMED_ACTIVITY_ID,
    status: SESSION_STATUS.ACTIVE,
    startedAt: new Date(NOW_MS - 2 * 3_600_000).toISOString(),
    lastActivityAt: "not-a-timestamp",
    endedAt: null,
    awaitingInputSince: null,
    updatedAt: new Date(NOW_MS).toISOString(),
    agents: [],
    events: [],
    prs: [],
    tokenUsageByModel: [],
  } as unknown as SyncedAgentSession;
}

/**
 * `sortSyncedSessions` decorates, sorts, and breaks ties on the INCOMING index
 * (the stable-sort tiebreak), so the oracle is resolved with that same tiebreak
 * rather than a second expectation about it.
 */
function tiebreakByIncomingOrder(
  a: DurationSortParityCase,
  b: DurationSortParityCase
): number {
  return (
    DURATION_SORT_PARITY_CASES.indexOf(a) -
    DURATION_SORT_PARITY_CASES.indexOf(b)
  );
}

function sortedIds(dir: "asc" | "desc"): string[] {
  const sessions = DURATION_SORT_PARITY_CASES.map((testCase) =>
    syncedSession(testCase, testCase.rawStatus)
  );
  return sortSyncedSessions(sessions, sessionSortQuery("duration", dir)).map(
    (session) => session.externalSessionId
  );
}

describe("desktop Duration sort keys on the DISPLAYED status (ISS-6270)", () => {
  beforeEach(() => {
    nodeTestTimers.enable(["Date"], { now: NOW_MS });
  });

  afterEach(() => {
    nodeTestTimers.reset();
    // The gate module holds a process-wide resolver; restore the fail-closed
    // default so a case that flips it cannot leak into the next one.
    setDisplayedStatusParityResolver(() => false);
  });

  it("descending: no row whose Duration cell is BLANK outranks a measured span", () => {
    assert.deepEqual(
      sortedIds("desc"),
      expectedDurationSortIds("desc", tiebreakByIncomingOrder)
    );
  });

  it("ascending: blanks still collect LAST (FEA-4330), they do not lead the page", () => {
    assert.deepEqual(
      sortedIds("asc"),
      expectedDurationSortIds("asc", tiebreakByIncomingOrder)
    );
  });

  it("keeps the stale-folded row from outranking every measured row", () => {
    const order = sortedIds("desc");
    const stalePosition = order.indexOf("d-stale-40h");
    for (const measured of DURATION_SORT_PARITY_CASES.filter(
      (c) => c.displayedSpanMs !== null
    )) {
      assert.ok(
        stalePosition > order.indexOf(measured.id),
        `stale row outranked ${measured.id}`
      );
    }
  });

  it("keys every case to the span its Duration cell renders", () => {
    // Per-case equality, not just relative order: an order assertion alone
    // would survive a comparator that scaled every span by the same factor.
    //
    // The fixture drives `rawStatus` only. `servedStatuses` — the wire
    // spellings the two producers can emit, including the display-only
    // `stale` — belongs to the CELL test in `packages/app`, which reads
    // `AgentSessionListItem.status`. This comparator runs one layer earlier,
    // on `SyncedAgentSession.status`, where the value is always the raw stored
    // one; feeding a display-only spelling in here would assert idempotence of
    // the fold rather than the gate variance it claimed to (test-strategist,
    // this PR's review). The real gate variance is covered by the case below.
    for (const testCase of DURATION_SORT_PARITY_CASES) {
      assert.equal(
        sessionDurationMs(syncedSession(testCase, testCase.rawStatus), NOW_MS),
        testCase.displayedSpanMs,
        `${testCase.id} key disagreed with the rendered cell`
      );
    }
  });

  it("keys the DEFAULT clock path to that same span, not only the injected one", () => {
    // wongk (#5111): assertable only because the clock above is pinned.
    // `sessionDurationMs` defaults `nowMs` to `Date.now()`, and every other
    // exact-value case injects an instant instead — so the branch
    // `sortSyncedSessions` actually calls, the one that reads the clock itself,
    // had no exact coverage. Against a live clock this comparison is off by the
    // scheduler delay and can only be written as a tolerance, which the repo
    // test rules ban.
    for (const testCase of DURATION_SORT_PARITY_CASES) {
      assert.equal(
        sessionDurationMs(syncedSession(testCase, testCase.rawStatus)),
        testCase.displayedSpanMs,
        `${testCase.id} default-clock key disagreed with the rendered cell`
      );
    }
  });

  it("measures the staleness fold against the INJECTED clock, gate ON or OFF", () => {
    // ISS-6270 review (bug_hunter_a / bug_hunter_b / unified_auditor, all
    // three independently): with the parity gate ON the staleness fold runs
    // inside the SERVED projection, so a `now` threaded only into the client
    // fold left the gate-ON path reading an ambient `Date.now()` — one row
    // judged by two clocks, the same defect this ticket fixed on the cloud
    // comparator's default clock.
    //
    // The instant is pinned TEN DAYS in the past while the row is live
    // relative to it. Against the wall clock the row is long silent and folds
    // to Stale (blank); against the injected instant it is a live 2h run. So
    // the two clocks give different ANSWERS here, which is what makes this
    // case able to fail at all.
    const pinned = new Date(NOW_MS - 10 * 24 * 3_600_000);
    const liveAtPinned = {
      externalSessionId: "clock-probe",
      status: SESSION_STATUS.ACTIVE,
      startedAt: new Date(pinned.getTime() - 2 * 3_600_000).toISOString(),
      lastActivityAt: pinned.toISOString(),
      endedAt: null,
      awaitingInputSince: null,
      tokenUsageByModel: [],
    } as unknown as SyncedAgentSession;

    assert.equal(
      sessionDurationMs(liveAtPinned, pinned.getTime()),
      2 * 3_600_000
    );
    setDisplayedStatusParityResolver(() => true);
    assert.equal(
      sessionDurationMs(liveAtPinned, pinned.getTime()),
      2 * 3_600_000
    );
  });

  it("holds with the displayed-status-parity Labs gate ON", () => {
    // ON, the producer serves the folded/projected status; OFF, it serves the
    // raw one. The renderer applies the client fold either way, so the sort key
    // — and therefore the page order — must be identical in both states.
    //
    // wongk (#5111 review): the row that can make this FAIL is
    // `d-awaiting-40h`. It is the only case whose served status the gate
    // actually moves (`active` off, `waiting` on), and `waiting` is the one
    // spelling EXEMPT from the staleness fold — so if the gated projection
    // stopped producing it, this row would fold to Stale and key blank while its
    // cell went on rendering 40h. Every other case is served a status the fold
    // is idempotent over, which is why a table with no awaiting-input row made
    // this assertion vacuously true.
    const awaiting = DURATION_SORT_PARITY_CASES.find(
      (c) => c.id === "d-awaiting-40h"
    );
    assert.ok(
      awaiting,
      "the gate-variant population must still be in the shared oracle"
    );
    assert.notEqual(
      awaiting.awaitingInputSinceBeforeMs,
      null,
      "that case must actually carry awaiting-input evidence"
    );
    assert.notEqual(
      awaiting.displayedSpanMs,
      null,
      "and must render a measured span, or the gate cannot move its key"
    );
    const off = sortedIds("desc");
    setDisplayedStatusParityResolver(() => true);
    assert.deepEqual(sortedIds("desc"), off);
    assert.equal(
      sessionDurationMs(syncedSession(awaiting, awaiting.rawStatus), NOW_MS),
      awaiting.displayedSpanMs,
      "the awaiting-input row keeps timing with the gate ON"
    );
  });

  it("keys a MALFORMED lastActivityAt to the blank its served row displays", () => {
    // wongk (#5111): the persisted-value case the two projections used to
    // answer differently. `mapListItem` serves `lastActivityAt` through
    // `parseSessionDate`, whose NaN→epoch fallback puts `1970-01-01` on the
    // wire, so the renderer's fold reads Stale and the Duration cell is BLANK.
    // The comparator's mirror passed the RAW strings to
    // `resolveDisplayedSessionStatus`, which resolves the first PARSEABLE of
    // the two, skipped the malformed value, landed on the recent `startedAt`,
    // read `active`, and keyed on a span growing against the clock — a blank
    // cell sorting as the longest run on the page.
    //
    // Asserted through the PRODUCER, not against a restated expectation: the
    // served row is what the renderer folds, so the fold is run over
    // `mapListItem`'s own output rather than over a hand-built list item.
    const malformed = malformedActivitySession();
    const served = mapListItem(malformed);
    assert.equal(
      served.lastActivityAt.getTime(),
      0,
      "the producer serves the malformed timestamp as the epoch"
    );
    assert.equal(
      resolveDisplayedSessionStatus({
        status: served.status,
        lastActivityAt: served.lastActivityAt,
        startedAt: served.startedAt,
        now: new Date(NOW_MS),
      }),
      DISPLAYED_SESSION_STATUS.STALE,
      "the served row DISPLAYS as stale, so its Duration cell is blank"
    );
    assert.equal(
      sessionDurationMs(malformed, NOW_MS),
      null,
      "the sort key must be the same blank, not a span growing against the clock"
    );
  });

  it("keys an UNRECOGNIZED status awaiting input to the blank its served row displays", () => {
    // ISS-6270 (wongk, #5111 review): the case that pins `isLiveSharedStatus`'s
    // narrowing. That gate asks "does this build know the status means the run
    // is RUNNING", not the facet's wider "is this row not finished", and the
    // difference is only observable on this shape: a status this build does not
    // recognize, awaiting input, never ended, silent past the cutoff. Widened to
    // `!TERMINAL_SHARED_STATUSES.has(canonicalSharedStatus(status))` the mirror
    // projects Waiting, the key starts timing against the clock, and the served
    // row's cell goes on rendering blank — a fresh instance of the very
    // cell-disagrees-with-comparator defect this ticket closes.
    //
    // WHY IT IS NOT IN `DURATION_SORT_PARITY_CASES`, which is where a Duration
    // case belongs by default: that oracle carries ONE `displayedSpanMs` per
    // shape, and this shape does not have one. The cloud's
    // `projectDisplayedSessionStatus` reaches its Waiting branch through the
    // wide non-terminal test, so cloud SERVES `waiting` and its cell renders a
    // growing span (measured: `resolveDisplayDurationMs` keys 144000000) — the
    // deliberate gap that projection's own docstring records as held shut by
    // evidence rather than closed. The desktop gate-ON producer
    // (`projectDisplayedSharedStatus`) mirrors that wide test and serves
    // `waiting` too. Only the gate-OFF producer serves the unrecognized
    // spelling, and only there does the cell render blank. Adding the case to
    // the shared table reds the `apps/api` order assertions and the gate-ON
    // parity assertion above — not because either comparator is wrong, but
    // because the table cannot state two answers. So it is pinned HERE, against
    // the producer, exactly as the malformed-timestamp case below is.
    const session = {
      externalSessionId: "d-unknown-awaiting-40h",
      status: UNRECOGNIZED_SESSION_STATUS,
      startedAt: new Date(NOW_MS - 40 * 3_600_000).toISOString(),
      lastActivityAt: new Date(NOW_MS - 30 * 3_600_000).toISOString(),
      endedAt: null,
      awaitingInputSince: new Date(NOW_MS - 30 * 3_600_000).toISOString(),
      updatedAt: new Date(NOW_MS).toISOString(),
      agents: [],
      events: [],
      prs: [],
      tokenUsageByModel: [],
    } as unknown as SyncedAgentSession;

    // Asserted through the PRODUCER rather than against a restated expectation:
    // the served status is what the renderer folds, so the claim "its cell is
    // blank" is read off `mapListItem`'s own output.
    const served = mapListItem(session);
    assert.equal(
      served.status,
      UNRECOGNIZED_SESSION_STATUS,
      "gate OFF, the producer serves the unrecognized spelling, not waiting"
    );
    assert.equal(
      resolveDisplayedSessionStatus({
        status: served.status,
        lastActivityAt: served.lastActivityAt,
        startedAt: served.startedAt,
        now: new Date(NOW_MS),
      }),
      DISPLAYED_SESSION_STATUS.UNKNOWN,
      "the served row DISPLAYS as unknown, so its Duration cell is blank"
    );
    assert.equal(
      sessionDurationMs(session, NOW_MS),
      null,
      "the sort key must be that same blank, not a span growing against the clock"
    );
  });

  it("sorts the MALFORMED-lastActivityAt row below every measured span", () => {
    // The order consequence of the case above: a nulls-last key collects with
    // the blanks in BOTH directions. Ordering is asserted separately from the
    // key because a comparator could produce the right key and still place it
    // wrongly (the FEA-4330 direction-flip shape).
    //
    // The fixture's start time is deliberately RECENT (2h): a start time old
    // enough to be stale on its own would let the pre-fix comparator reach the
    // same blank by the wrong route, and this case would pass either way.
    const malformed = malformedActivitySession();
    const measured = DURATION_SORT_PARITY_CASES.filter(
      (c) => c.displayedSpanMs !== null
    );
    const sessions = [
      malformed,
      ...measured.map((testCase) =>
        syncedSession(testCase, testCase.rawStatus)
      ),
    ];

    for (const dir of ["desc", "asc"] as const) {
      const order = sortSyncedSessions(
        sessions,
        sessionSortQuery("duration", dir)
      ).map((session) => session.externalSessionId);
      for (const testCase of measured) {
        assert.ok(
          order.indexOf(MALFORMED_ACTIVITY_ID) > order.indexOf(testCase.id),
          `${dir}: the malformed row outranked ${testCase.id}`
        );
      }
    }
  });

  it("still measures a live run and a stale run that recorded an end", () => {
    // The two controls that keep the fix from being a blanket "unended means
    // blank": a fresh `active` run keeps timing against `now`, and a stale row
    // carrying its own `endedAt` still measures that end.
    const live = DURATION_SORT_PARITY_CASES.find(
      (c) => c.id === "d-running-2h"
    );
    const staleEnded = DURATION_SORT_PARITY_CASES.find(
      (c) => c.id === "d-stale-ended-1h"
    );
    assert.equal(live?.rawStatus, SESSION_STATUS.ACTIVE);
    assert.equal(
      sessionDurationMs(syncedSession(live!, live!.rawStatus), NOW_MS),
      live?.displayedSpanMs
    );
    assert.equal(
      sessionDurationMs(
        syncedSession(staleEnded!, DISPLAYED_SESSION_STATUS.STALE),
        NOW_MS
      ),
      staleEnded?.displayedSpanMs
    );
  });
});
