import {
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "@repo/api/src/types/session-status";
import { resolveSessionDetailDisplayStatus } from "@repo/app/agents/lib/session-detail-display-status";
import {
  DURATION_NO_START_REASON,
  isSessionDetailDurationClockRelevant,
  resolveSessionDetailDurationEmptyReason,
  resolveSessionDetailDurationWindow,
} from "@repo/app/agents/lib/session-detail-duration-window";
import { resolveSessionWallClockLabel } from "@repo/app/agents/lib/session-duration";
import { agentSessionToSessionTableRow } from "@repo/app/agents/lib/session-table-row";
import { describe, expect, it } from "vitest";
import { createAgentSessionListItemFixture } from "../../components/sessions/session-list-fixtures";

/**
 * ISS-5575: the session-detail Duration window, and the invariant that it agrees
 * with the Sessions LIST for every input.
 *
 * ISS-6455: the comparison runs the LIST MAPPER ITSELF
 * (`agentSessionToSessionTableRow`) and reads the Duration it produces. An
 * earlier mirror restated the list's derivation in this file, which stopped
 * proving anything the moment both surfaces called one shared resolver: the
 * mirror and the function under test then ran the same code, so reverting the
 * fix left every assertion here green. Comparing the two RENDERED labels is the
 * only form of this file's claim that a divergence can red.
 */

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date("2026-06-11T12:00:00.000Z");
const STARTED_AT = new Date(NOW.getTime() - 3 * HOUR_MS);
/** Past the cutoff, so the display fold fires. */
const SILENT_SINCE = new Date(
  NOW.getTime() - (STALE_SESSION_DISPLAY_THRESHOLD_HOURS + 6) * HOUR_MS
);
/** A status string no build recognizes — the version-skew case. */
const UNRECOGNIZED_STATUS = "quantum-flux";

type DurationRecord = {
  status: string;
  awaitingInputSince?: Date | null;
  lastActivityAt?: Date | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
};

/**
 * The Duration the Sessions LIST cell actually renders for this record.
 *
 * Every optional field is spread EXPLICITLY, defaulted to `null`. Spreading the
 * record alone would let `createAgentSessionListItemFixture`'s own non-null
 * defaults (`endedAt`, `lastActivityAt`, `startedAt` all land in June 2026) fill
 * a field the detail half reads as absent — so the two halves would be comparing
 * two different records while claiming to prove parity for one.
 */
function listDurationLabelFor(record: DurationRecord): string | null {
  return agentSessionToSessionTableRow(
    createAgentSessionListItemFixture({
      awaitingInputSince: record.awaitingInputSince ?? null,
      endedAt: record.endedAt ?? null,
      lastActivityAt: record.lastActivityAt ?? null,
      startedAt: record.startedAt ?? null,
      status: record.status,
    }),
    null,
    { now: NOW }
  ).durationLabel;
}

/**
 * The Duration the DETAIL renders — the window resolved once and handed to the
 * label helper, the composition `SessionDurationProperty` runs.
 */
function detailDurationLabelFor(record: DurationRecord): string | null {
  return resolveSessionWallClockLabel(
    record.startedAt ?? null,
    resolveSessionDetailDurationWindow({ ...record, now: NOW }),
    NOW.getTime()
  );
}

describe("ISS-5575: the detail Duration window matches the list's", () => {
  it("ISS-10364: keeps timing a silent active run now that the staleness fold is retired", () => {
    // Counterfactual for the operator's 2026-09-23 ruling ("don't distinguish
    // between active and stale"): this used to fold to `unmeasurable` once
    // `lastActivityAt` passed the 24h cutoff. There is no endedAt to bound the
    // span, so it now measures start -> now like any other undistinguished
    // `active` row — STARTED_AT is NOW - 3h, so the span is 3h. Kept so a
    // future change restoring the cutoff has to edit this assertion.
    const record = {
      endedAt: null,
      lastActivityAt: SILENT_SINCE,
      startedAt: STARTED_AT,
      status: SESSION_STATUS.ACTIVE,
    };

    expect(resolveSessionDetailDurationWindow({ ...record, now: NOW })).toEqual(
      {
        kind: "running",
      }
    );
    expect(detailDurationLabelFor(record)).toBe(listDurationLabelFor(record));
  });

  it("keeps measuring a live run, exactly as the list does", () => {
    const record = {
      endedAt: null,
      lastActivityAt: new Date(NOW.getTime() - HOUR_MS),
      startedAt: STARTED_AT,
      status: SESSION_STATUS.ACTIVE,
    };

    expect(resolveSessionDetailDurationWindow({ ...record, now: NOW })).toEqual(
      {
        kind: "running",
      }
    );
    const label = detailDurationLabelFor(record);
    expect(label).toBe(listDurationLabelFor(record));
    // Both MEASURED, not both empty — the shape a parity assertion alone would
    // accept while the two surfaces agreed on the wrong answer.
    expect(label).not.toBeNull();
  });

  /**
   * Historical context: an adversarial review found that an earlier revision
   * derived through `resolveSessionDetailDisplayStatus`, whose Waiting
   * projection fail-opened `unknown` to `active` and produced a RUNNING window
   * the list's own (narrower) resolver still blanked.
   * `resolveDisplayedSessionStatusWithWaiting`'s recognition gate
   * (`recognized === SESSION_STATUS.ACTIVE`) closed that split by requiring the
   * RAW status to already fold to `active` before granting the projection.
   *
   * ISS-10364 (operator ruling, 2026-09-23) retired the display-only words the
   * gate used to SORT these three out by. The gate itself still rejects all
   * three — it is a membership test now, not a fold (see `projectLiveWaiting`)
   * — so none of them reaches the Waiting projection. What changed is what they
   * fall THROUGH to: `resolveDisplayedSessionStatus` answers `active` for each,
   * where it used to answer `unknown`/`stale`. So the window TIMES rather than
   * staying unmeasurable — STARTED_AT is NOW - 3h, so the span is 3h — and the
   * two surfaces still agree, which is the claim this case owns. Kept as the
   * counterfactual so restoring either retired fold has to edit this assertion.
   */
  it.each(["unknown", "stale", UNRECOGNIZED_STATUS])(
    "ISS-10364: times an awaiting-input %s run, since the retired fold now answers active",
    (status) => {
      const record = {
        endedAt: null,
        lastActivityAt: SILENT_SINCE,
        startedAt: STARTED_AT,
        status,
      };

      const window = resolveSessionDetailDurationWindow({
        ...record,
        awaitingInputSince: NOW,
        now: NOW,
      });

      expect(window).toEqual({ kind: "running" });
      expect(
        detailDurationLabelFor({ ...record, awaitingInputSince: NOW })
      ).toBe(listDurationLabelFor({ ...record, awaitingInputSince: NOW }));
    }
  );

  /**
   * ISS-5575 (whitlockk, #4971): the un-projected detail shape. A version-skewed
   * producer can still serve the RAW canonical status, so an awaiting-input
   * session reaches this view as `active` with `awaitingInputSince` beside it.
   * Fold
   * that to Stale after 24h and the Duration stops while the title chip on the
   * SAME screen — `resolveSessionDetailDisplayStatus`, which does read the
   * field — still reads "Waiting".
   *
   * ISS-6455: and the LIST has to reach the same window. The exemption shipped
   * on the detail alone, so this record was the one input for which the two
   * surfaces disagreed — a Duration climbing against `now()` one click from an
   * empty cell.
   */
  it("keeps timing a silent raw-active run that is awaiting input", () => {
    const record = {
      awaitingInputSince: new Date(NOW.getTime() - 30 * HOUR_MS),
      endedAt: null,
      lastActivityAt: SILENT_SINCE,
      now: NOW,
      startedAt: STARTED_AT,
      status: SESSION_STATUS.ACTIVE,
    };

    expect(resolveSessionDetailDurationWindow(record)).toEqual({
      kind: "running",
    });
    const label = detailDurationLabelFor(record);
    expect(label).toBe(listDurationLabelFor(record));
    // The agreed answer is the MEASURED one. Two em-dashes would satisfy the
    // equality above while both surfaces took the wrong side of it.
    expect(label).not.toBeNull();
    // ISS-10364 (operator ruling, 2026-09-23/24) retired the title chip's
    // Waiting projection too: `resolveSessionDetailDisplayStatus` no longer
    // reads `awaitingInputSince` at all, so this row's chip now agrees with
    // every other non-terminal row and reads Active, not Waiting.
    expect(
      resolveSessionDetailDisplayStatus({ ...record, status: record.status })
    ).toBe(SESSION_STATUS.ACTIVE);
    expect(isSessionDetailDurationClockRelevant(record)).toBe(true);
    expect(emptyReasonFor(record)).toBeNull();
  });

  it("does not project a TERMINAL straggler that still carries the signal", () => {
    const record = {
      awaitingInputSince: new Date(NOW.getTime() - 30 * HOUR_MS),
      endedAt: null,
      lastActivityAt: SILENT_SINCE,
      now: NOW,
      startedAt: STARTED_AT,
      status: SESSION_STATUS.INACTIVE,
    };

    expect(resolveSessionDetailDurationWindow(record)).toEqual({
      kind: "unmeasurable",
    });
  });

  /**
   * ISS-4654: a VALID `endedAt` settles the awaiting-input evidence to `None`
   * before the projection even runs, so this record is never projected
   * Waiting — that part is UNCHANGED.
   *
   * ISS-10364 (operator ruling, 2026-09-23) changed what happens after that.
   * The retired staleness fold used to be what bounded this row to its own
   * `endedAt` once it read Stale; there is no fold left, and the cell derives
   * no terminal status from `endedAt` itself. A served raw `active` status with
   * a real end instant therefore measures to `now` like any other live row. A
   * producer that stores `inactive`/`error` is still measured to its own end —
   * see "does not project a TERMINAL straggler" above.
   */
  it("ISS-10364: measures a served raw-active row to now, even with a recorded end", () => {
    const endedAt = new Date(NOW.getTime() - HOUR_MS);

    expect(
      resolveSessionDetailDurationWindow({
        awaitingInputSince: new Date(NOW.getTime() - 30 * HOUR_MS),
        endedAt,
        lastActivityAt: SILENT_SINCE,
        now: NOW,
        startedAt: STARTED_AT,
        status: SESSION_STATUS.ACTIVE,
      })
    ).toEqual({ kind: "running" });
  });

  /**
   * ISS-10364 (operator ruling, 2026-09-23/24) retired the evidence-disclaim
   * path this case used to pin: `resolveSessionDetailDisplayStatus` no longer
   * reads `endedAt` at all when deciding the STATUS, and the window's lifecycle
   * check (`resolveSessionDurationLifecycle("active")` → Running) short-circuits
   * before the window logic ever looks at `endedAt` — so a raw `active` status
   * measures to `now` regardless of whether its `endedAt` is corrupt, absent, or
   * a real past instant (see "measures a served raw-active row to now" above,
   * which pins the same answer for a VALID end instant). Kept as the
   * counterfactual for the withdrawn disclaim.
   */
  it("ISS-10364: keeps timing a raw-active run even with an unparseable endedAt, on both surfaces", () => {
    const record = {
      awaitingInputSince: new Date(NOW.getTime() - 30 * HOUR_MS),
      endedAt: new Date("not-a-date"),
      lastActivityAt: SILENT_SINCE,
      startedAt: STARTED_AT,
      status: SESSION_STATUS.ACTIVE,
    };

    const label = detailDurationLabelFor(record);
    expect(label).toBe(listDurationLabelFor(record));
    expect(label).not.toBeNull();
    expect(resolveSessionDetailDurationWindow({ ...record, now: NOW })).toEqual(
      {
        kind: "running",
      }
    );
    expect(resolveSessionDetailDisplayStatus({ ...record, now: NOW })).toBe(
      SESSION_STATUS.ACTIVE
    );
    expect(emptyReasonFor(record)).toBeNull();
  });

  /**
   * ISS-6455 (whitlockk, #5099 review) pinned that an unparseable
   * `awaitingInputSince` withholds the staleness EXEMPTION without disclaiming
   * the row — a corrupt exemption anchor should cost nothing but the exemption
   * itself, which then used to land on Stale.
   *
   * ISS-10364 (operator ruling, 2026-09-23) retired the staleness fold this
   * case fell back to, so there is no fold left to withhold from: every
   * `active` row measures start -> now regardless of silence, corrupt
   * `awaitingInputSince` included. Kept as the counterfactual for the
   * withdrawn fold.
   */
  it("ISS-10364: keeps a run measured on an unparseable awaitingInputSince, on both surfaces", () => {
    const record = {
      awaitingInputSince: new Date("not-a-date"),
      endedAt: null,
      lastActivityAt: SILENT_SINCE,
      startedAt: STARTED_AT,
      status: SESSION_STATUS.ACTIVE,
    };

    const label = detailDurationLabelFor(record);
    expect(label).toBe(listDurationLabelFor(record));
    expect(label).not.toBeNull();
    expect(resolveSessionDetailDisplayStatus({ ...record, now: NOW })).toBe(
      SESSION_STATUS.ACTIVE
    );
    expect(emptyReasonFor(record)).toBeNull();
  });

  it("keeps a LIVE run measured when only its awaitingInputSince is unparseable", () => {
    // The control for the case above: a corrupt exemption anchor must not cost a
    // run its Duration when nothing else about it is in doubt.
    const record = {
      awaitingInputSince: new Date("not-a-date"),
      endedAt: null,
      lastActivityAt: new Date(NOW.getTime() - HOUR_MS),
      startedAt: STARTED_AT,
      status: SESSION_STATUS.ACTIVE,
    };

    const label = detailDurationLabelFor(record);
    expect(label).toBe(listDurationLabelFor(record));
    expect(label).not.toBeNull();
  });

  it("ISS-10364: a legacy 'waiting' status folds to Active and keeps its clock running", () => {
    const record = {
      endedAt: null,
      lastActivityAt: SILENT_SINCE,
      startedAt: STARTED_AT,
      // Plain literal: ISS-10364 retired `DISPLAYED_SESSION_STATUS.WAITING`.
      status: "waiting",
    };

    expect(resolveSessionDetailDurationWindow({ ...record, now: NOW })).toEqual(
      {
        kind: "running",
      }
    );
    expect(detailDurationLabelFor(record)).toBe(listDurationLabelFor(record));
    expect(isSessionDetailDurationClockRelevant(record)).toBe(true);
  });

  it("leaves an absent status evidence-bounded rather than coercing one", () => {
    expect(
      resolveSessionDetailDurationWindow({
        endedAt: null,
        now: NOW,
        startedAt: STARTED_AT,
        status: null,
      })
    ).toEqual({ kind: "unmeasurable" });
    expect(isSessionDetailDurationClockRelevant({ status: null })).toBe(false);
  });

  it("never reports a running window it would refuse to tick", () => {
    // The invariant the tick gate rests on, asserted across the vocabulary
    // rather than trusted: a frozen number under a "Start to now" caption is the
    // failure mode, so `running` must always imply a live clock.
    for (const status of [
      SESSION_STATUS.ACTIVE,
      "waiting",
      SESSION_STATUS.INACTIVE,
      SESSION_STATUS.ERROR,
      "unknown",
      "stale",
      UNRECOGNIZED_STATUS,
    ]) {
      const window = resolveSessionDetailDurationWindow({
        endedAt: null,
        lastActivityAt: new Date(NOW.getTime() - HOUR_MS),
        now: NOW,
        startedAt: STARTED_AT,
        status,
      });
      if (window.kind === "running") {
        expect(isSessionDetailDurationClockRelevant({ status })).toBe(true);
      }
    }
  });
});

describe("ISS-5575: the empty Duration says why", () => {
  it("ISS-10364: gives no reason for a silent run that just keeps timing, since the staleness sentence is retired", () => {
    // Counterfactual: this used to be the case that explained a Stale fold.
    // There is no fold left to explain — the row measures start -> now like any
    // other active row, so the Duration renders a real label and the reason is
    // null.
    expect(
      emptyReasonFor({
        endedAt: null,
        lastActivityAt: SILENT_SINCE,
        startedAt: STARTED_AT,
        status: SESSION_STATUS.ACTIVE,
      })
    ).toBeNull();
  });

  it("keeps the no-start sentence for a record that genuinely has no start", () => {
    expect(
      emptyReasonFor({
        endedAt: null,
        lastActivityAt: null,
        startedAt: null,
        status: SESSION_STATUS.INACTIVE,
      })
    ).toBe(DURATION_NO_START_REASON);
  });

  it("explains nothing when the Duration is measured", () => {
    expect(
      emptyReasonFor({
        endedAt: null,
        lastActivityAt: new Date(NOW.getTime() - HOUR_MS),
        startedAt: STARTED_AT,
        status: SESSION_STATUS.ACTIVE,
      })
    ).toBeNull();
  });

  /**
   * An awaiting-input run with no start instant gets the NO-START sentence, not
   * the staleness one: its window projects to `running`, so nothing on the
   * screen has stopped believing it is live — the start time is simply missing.
   */
  it("does not tell an awaiting-input run its agent has gone quiet", () => {
    expect(
      emptyReasonFor({
        awaitingInputSince: new Date(NOW.getTime() - 30 * HOUR_MS),
        endedAt: null,
        lastActivityAt: SILENT_SINCE,
        startedAt: null,
        status: SESSION_STATUS.ACTIVE,
      })
    ).toBe(DURATION_NO_START_REASON);
  });

  /**
   * ISS-5575 (whitlockk, #4971): the reason is keyed off the rendered LABEL's
   * inputs, not off `window.kind`. Both a `running` and an `ended` window print
   * the em-dash when `startedAt` is absent, and an earlier revision short-
   * circuited to `null` for both — losing the pre-existing "No start time
   * recorded" sentence for exactly the population it was written for.
   */
  it.each([
    { case: "running", endedAt: null, status: SESSION_STATUS.ACTIVE },
    {
      case: "ended",
      endedAt: new Date(NOW.getTime() - HOUR_MS),
      status: SESSION_STATUS.INACTIVE,
    },
  ])(
    "keeps the no-start sentence on a measurable $case window with no start",
    ({ endedAt, status }) => {
      const record = {
        endedAt,
        lastActivityAt: new Date(NOW.getTime() - HOUR_MS),
        now: NOW,
        startedAt: null,
        status,
      };

      // The window itself is measurable — only the label is empty.
      expect(resolveSessionDetailDurationWindow(record).kind).not.toBe(
        "unmeasurable"
      );
      expect(
        resolveSessionWallClockLabel(
          record.startedAt,
          resolveSessionDetailDurationWindow(record),
          NOW.getTime()
        )
      ).toBeNull();
      expect(emptyReasonFor(record)).toBe(DURATION_NO_START_REASON);
    }
  );
});

/**
 * The reason as the two consumers compute it: resolve the window ONCE, then ask
 * it. That is the composition `SessionDurationProperty` and
 * `SessionTimelineSummary` run (tamsinb, #4971), so a test cannot pass a window
 * the render would never produce.
 */
function emptyReasonFor(record: {
  status?: string | null;
  awaitingInputSince?: Date | string | null;
  endedAt?: Date | string | null;
  lastActivityAt?: Date | string | null;
  startedAt?: Date | string | null;
}): string | null {
  return resolveSessionDetailDurationEmptyReason({
    // ISS-6455: the same two fields the window read, exactly as both render
    // sites forward them — a reason resolved from fewer inputs than the number
    // can describe a state the number was not resolved from.
    awaitingInputSince: record.awaitingInputSince,
    endedAt: record.endedAt,
    lastActivityAt: record.lastActivityAt,
    now: NOW,
    startedAt: record.startedAt,
    status: record.status,
    window: resolveSessionDetailDurationWindow({ ...record, now: NOW }),
  });
}
