import assert from "node:assert/strict";
import { UNRECOGNIZED_SESSION_STATUS } from "@repo/api/src/agent-session-displayed-status-parity.test-fixtures";
import {
  DURATION_SORT_PARITY_CASES,
  type DurationSortParityCase,
  expectedDurationSortIds,
} from "@repo/api/src/session-duration-sort-parity.test-fixtures";
import {
  resolveDisplayedSessionStatus,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
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
 * whitlockk (#5111): a fixed instant, and the clock the suite FREEZES to it.
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
 * whitlockk (#5111): a row whose PERSISTED `lastActivityAt` does not parse, on a
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

  it("keeps the long-silent row timing WITH the measured rows, not blanked below them (ISS-10364)", () => {
    // ISS-10364 (operator ruling 2026-09-23): the Indeterminate lifecycle this
    // pinned is gone — a long-silent `active` row now DISPLAYS active and
    // keeps timing rather than folding to Stale, so it no longer collects
    // below the measured rows. Inverted rather than deleted: the stale row
    // being outranked by every measured row would mean the old staleness
    // cutoff came back.
    const order = sortedIds("desc");
    const stalePosition = order.indexOf("d-stale-40h");
    for (const measured of DURATION_SORT_PARITY_CASES.filter(
      (c) => c.displayedSpanMs !== null && c.id !== "d-stale-40h"
    )) {
      assert.ok(
        stalePosition <= order.indexOf(measured.id),
        `stale row was unexpectedly outranked by ${measured.id}`
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
    // the fold rather than the projection it claimed to (test-strategist,
    // ISS-6270 review).
    for (const testCase of DURATION_SORT_PARITY_CASES) {
      assert.equal(
        sessionDurationMs(syncedSession(testCase, testCase.rawStatus), NOW_MS),
        testCase.displayedSpanMs,
        `${testCase.id} key disagreed with the rendered cell`
      );
    }
  });

  it("keys the DEFAULT clock path to that same span, not only the injected one", () => {
    // whitlockk (#5111): assertable only because the clock above is pinned.
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

  it("measures the staleness fold against the INJECTED clock", () => {
    // ISS-6270 review (bug_hunter_a / bug_hunter_b / unified_auditor, all
    // three independently): the staleness fold runs inside the SERVED
    // projection, so a `now` threaded only into the client fold left that
    // projection reading an ambient `Date.now()` — one row judged by two
    // clocks, the same defect this ticket fixed on the cloud comparator's
    // default clock.
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
  });

  it("keeps the awaiting-input row in the shared oracle, still timing", () => {
    // whitlockk (#5111 review): `d-awaiting-40h` is the row that makes the per-case
    // loop above non-vacuous. It is the only case the Waiting projection moves
    // (raw `active`, served `waiting`), and `waiting` is the one spelling EXEMPT
    // from the staleness fold — so if the projection stopped producing it, this
    // row would fold to Stale and key blank while its cell went on rendering
    // 40h. Every other case is served a status the fold is idempotent over,
    // which is why an oracle with no awaiting-input row would make that loop
    // pass without exercising the projection at all. These guards fail if the
    // case is ever dropped or drained of its evidence.
    const awaiting = DURATION_SORT_PARITY_CASES.find(
      (c) => c.id === "d-awaiting-40h"
    );
    assert.ok(
      awaiting,
      "the projection-variant population must still be in the shared oracle"
    );
    assert.notEqual(
      awaiting.awaitingInputSinceBeforeMs,
      null,
      "that case must actually carry awaiting-input evidence"
    );
    assert.notEqual(
      awaiting.displayedSpanMs,
      null,
      "and must render a measured span, or the projection cannot move its key"
    );
    assert.equal(
      sessionDurationMs(syncedSession(awaiting, awaiting.rawStatus), NOW_MS),
      awaiting.displayedSpanMs,
      "the awaiting-input row keeps timing rather than folding to a blank"
    );
  });

  it("keys a MALFORMED lastActivityAt to the running span its served row now displays (ISS-10364)", () => {
    // ISS-10364 (operator ruling 2026-09-23): `resolveDisplayedSessionStatus`
    // no longer reads `lastActivityAt` at all, so the epoch-floored malformed
    // value this case used to pin — the one that folded the row to Stale and
    // blanked its Duration cell — can no longer do that. The row stores
    // `active`, so it displays Active and keeps timing from its (valid) start.
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
      SESSION_STATUS.ACTIVE,
      "the served row DISPLAYS active regardless of the malformed activity timestamp"
    );
    assert.equal(
      sessionDurationMs(malformed, NOW_MS),
      2 * 3_600_000,
      "the sort key keeps timing from the start; the malformed timestamp no longer blanks it"
    );
  });

  it("keys an UNRECOGNIZED status to the running span its served row now displays (ISS-10364)", () => {
    // ISS-10364 (operator ruling 2026-09-23): an unrecognized spelling now
    // takes `normalizeSessionStatus`'s fail-open to Active instead of folding
    // to the display-only Unknown, so it keeps timing from its start rather
    // than rendering blank.
    //
    // ISS-7019: deliberately NO `awaitingInputSince` — kept from the original
    // case, though the awaiting-input/unrecognized ordering it isolated is no
    // longer the point; this case still pins the unrecognized-status shape on
    // its own.
    const session = {
      externalSessionId: "d-unknown-40h",
      status: UNRECOGNIZED_SESSION_STATUS,
      startedAt: new Date(NOW_MS - 40 * 3_600_000).toISOString(),
      lastActivityAt: new Date(NOW_MS - 30 * 3_600_000).toISOString(),
      endedAt: null,
      awaitingInputSince: null,
      updatedAt: new Date(NOW_MS).toISOString(),
      agents: [],
      events: [],
      prs: [],
      tokenUsageByModel: [],
    } as unknown as SyncedAgentSession;

    // Asserted through the PRODUCER rather than against a restated expectation:
    // the served status is what the renderer folds, so the claim about what it
    // displays is read off `mapListItem`'s own output.
    const served = mapListItem(session);
    assert.equal(
      served.rawStatus,
      UNRECOGNIZED_SESSION_STATUS,
      "the producer preserves the raw lifecycle evidence beside its display fold"
    );
    assert.equal(
      resolveDisplayedSessionStatus({
        status: served.status,
        lastActivityAt: served.lastActivityAt,
        startedAt: served.startedAt,
        now: new Date(NOW_MS),
      }),
      SESSION_STATUS.ACTIVE,
      "the served row DISPLAYS active, folding open like any other unrecognized spelling"
    );
    assert.equal(
      sessionDurationMs(session, NOW_MS),
      40 * 3_600_000,
      "the sort key keeps timing from the start rather than blanking"
    );
  });

  it("keeps the MALFORMED-lastActivityAt row from collecting with a genuinely blank one (ISS-10364)", () => {
    // ISS-10364 (operator ruling 2026-09-23): the malformed row is no longer
    // blank (see the case above), so it no longer belongs at the bottom of
    // EVERY measured row — that premise is retired. What still must hold: it
    // does not collapse back into the nulls-last group with a row whose cell
    // is genuinely blank (`d-terminal-no-end`, no end instant recorded),
    // which is the FEA-4330 direction-flip shape this suite guards.
    const malformed = malformedActivitySession();
    const blank = DURATION_SORT_PARITY_CASES.find(
      (c) => c.id === "d-terminal-no-end"
    );
    assert.equal(
      blank?.displayedSpanMs,
      null,
      "the oracle control for this case must still be genuinely blank"
    );
    const sessions = [malformed, syncedSession(blank!, blank!.rawStatus)];

    for (const dir of ["desc", "asc"] as const) {
      const order = sortSyncedSessions(
        sessions,
        sessionSortQuery("duration", dir)
      ).map((session) => session.externalSessionId);
      assert.ok(
        order.indexOf(MALFORMED_ACTIVITY_ID) < order.indexOf(blank!.id),
        `${dir}: the malformed row collected with the genuinely blank one`
      );
    }
  });

  it("still measures a live run; a row served the legacy `stale` spelling now times unbounded (ISS-10364)", () => {
    // The control that survives: a fresh `active` run keeps timing against
    // `now`.
    const live = DURATION_SORT_PARITY_CASES.find(
      (c) => c.id === "d-running-2h"
    );
    assert.equal(live?.rawStatus, SESSION_STATUS.ACTIVE);
    assert.equal(
      sessionDurationMs(syncedSession(live!, live!.rawStatus), NOW_MS),
      live?.displayedSpanMs
    );

    // ISS-10364: `resolveDisplayedSessionStatus` folds the legacy `stale`
    // spelling straight to Active, and Active always times against the clock.
    const staleEnded = DURATION_SORT_PARITY_CASES.find(
      (c) => c.id === "d-stale-ended-1h"
    );
    assert.equal(
      sessionDurationMs(syncedSession(staleEnded!, "stale"), NOW_MS),
      staleEnded?.startedBeforeMs,
      "a row served the legacy `stale` spelling times unbounded against now, not its own recorded end"
    );
  });
});
