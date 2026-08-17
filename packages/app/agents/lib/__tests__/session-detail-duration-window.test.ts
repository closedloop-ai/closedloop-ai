import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "@repo/api/src/types/session-status";
import { SESSION_STALE_TOOLTIP } from "@repo/api/src/types/session-status-display";
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
  it("folds a silent active run to unmeasurable, exactly as the list does", () => {
    const record = {
      endedAt: null,
      lastActivityAt: SILENT_SINCE,
      startedAt: STARTED_AT,
      status: SESSION_STATUS.ACTIVE,
    };

    expect(resolveSessionDetailDurationWindow({ ...record, now: NOW })).toEqual(
      {
        kind: "unmeasurable",
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
   * The regression an adversarial review found before this shipped.
   *
   * An earlier revision derived through `resolveSessionDetailDisplayStatus`,
   * whose Waiting projection normalizes with a resolver that FAIL-OPENS the
   * display-only and unrecognized statuses to `active`. A version-skewed desktop
   * payload spelling `unknown` while carrying `awaitingInputSince` therefore
   * projected to `waiting` and produced a RUNNING window — turning the list's
   * em-dash into a climbing number on the detail, a NEW split in exactly the
   * direction this ticket exists to close. The tick gate reads the RAW lifecycle
   * and would have said "no tick", so that number was also frozen at mount.
   *
   * The narrow projection added for the raw-`active` case below must not reopen
   * it, which is why `awaitingInputSince` is SET here.
   */
  it.each([
    DISPLAYED_SESSION_STATUS.UNKNOWN,
    DISPLAYED_SESSION_STATUS.STALE,
    UNRECOGNIZED_STATUS,
  ])("never times an awaiting-input %s run the list cannot measure", (status) => {
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

    expect(window).toEqual({ kind: "unmeasurable" });
    expect(detailDurationLabelFor({ ...record, awaitingInputSince: NOW })).toBe(
      listDurationLabelFor({ ...record, awaitingInputSince: NOW })
    );
  });

  /**
   * ISS-5575 (wongk, #4971): the desktop LOCAL detail shape. `mapDetail`
   * inherits the RAW canonical status unless the independent
   * `sessions-displayed-status-parity` Labs flag is on, so an awaiting-input
   * local session arrives as `active` with `awaitingInputSince` beside it. Fold
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
    // The projected status is what the title chip already shows, so the two
    // agree instead of contradicting each other one row apart.
    expect(
      resolveSessionDetailDisplayStatus({ ...record, status: record.status })
    ).toBe(DISPLAYED_SESSION_STATUS.WAITING);
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

  it("does not project an ENDED run that still carries the signal", () => {
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
    ).toEqual({ end: endedAt, kind: "ended" });
  });

  /**
   * ISS-6455: the detail passed `endedAt` through raw while the list parsed it,
   * so a present-but-UNPARSEABLE value read as "this run has ended" on the
   * detail (Stale, em-dash) and as "no end recorded" in the list — a second
   * split, in the same field, opened by the fix for the first.
   *
   * wongk (#5099 review) settled which side both surfaces take: NEITHER. Reading
   * corrupt evidence as an absent end instant is what let an awaiting-input
   * projection start a duration against `now()` for a run we cannot show is
   * still live. Unreadable evidence degrades to an unmeasurable state, so the
   * agreed answer here is the em-dash — the control that this is not the fix
   * blanking every Duration is the measured awaiting-input case above.
   */
  it("degrades to unmeasurable on an unparseable endedAt, on both surfaces", () => {
    const record = {
      awaitingInputSince: new Date(NOW.getTime() - 30 * HOUR_MS),
      endedAt: new Date("not-a-date"),
      lastActivityAt: SILENT_SINCE,
      startedAt: STARTED_AT,
      status: SESSION_STATUS.ACTIVE,
    };

    const label = detailDurationLabelFor(record);
    expect(label).toBe(listDurationLabelFor(record));
    expect(label).toBeNull();
    expect(resolveSessionDetailDurationWindow({ ...record, now: NOW })).toEqual(
      {
        kind: "unmeasurable",
      }
    );
    // The title chip on the SAME screen disclaims too — it reads the shared
    // evidence classifier, so it cannot badge "Waiting" over this em-dash.
    expect(resolveSessionDetailDisplayStatus({ ...record, now: NOW })).toBe(
      DISPLAYED_SESSION_STATUS.UNKNOWN
    );
    // ...and the dash is NOT captioned "No activity for over 24 hours". Both
    // facts are true of this row, but the reason the NUMBER is missing is the
    // corruption, and the chip beside it already names that.
    expect(emptyReasonFor(record)).toBeNull();
  });

  /**
   * ISS-6455 (wongk, #5099 review): the other half of the pair, and it lands
   * differently. An `awaitingInputSince` this build cannot parse is not evidence
   * that a run is blocked on a human — the truthiness test it replaces let the
   * malformed string through and timed the run anyway — but it is not evidence
   * against the rest of the row either, so the fold simply runs without the
   * exemption. Silent past the cutoff, that is Stale and the em-dash.
   */
  it("withholds the staleness exemption on an unparseable awaitingInputSince, on both surfaces", () => {
    const record = {
      awaitingInputSince: new Date("not-a-date"),
      endedAt: null,
      lastActivityAt: SILENT_SINCE,
      startedAt: STARTED_AT,
      status: SESSION_STATUS.ACTIVE,
    };

    const label = detailDurationLabelFor(record);
    expect(label).toBe(listDurationLabelFor(record));
    expect(label).toBeNull();
    // Stale, NOT Unknown: the row is folded, not disclaimed, and the dash keeps
    // the staleness sentence that actually explains it.
    expect(resolveSessionDetailDisplayStatus({ ...record, now: NOW })).toBe(
      DISPLAYED_SESSION_STATUS.STALE
    );
    expect(emptyReasonFor(record)).toBe(SESSION_STALE_TOOLTIP);
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

  it("measures a waiting run against now, and keeps its clock running", () => {
    const record = {
      endedAt: null,
      lastActivityAt: SILENT_SINCE,
      startedAt: STARTED_AT,
      status: DISPLAYED_SESSION_STATUS.WAITING,
    };

    // A run blocked on a human is exempt from the staleness fold: it is still
    // live, so its span still grows.
    expect(resolveSessionDetailDurationWindow({ ...record, now: NOW })).toEqual(
      {
        kind: "running",
      }
    );
    expect(detailDurationLabelFor(record)).toBe(listDurationLabelFor(record));
    // The gate that froze this at mount before review caught it.
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
      DISPLAYED_SESSION_STATUS.WAITING,
      SESSION_STATUS.INACTIVE,
      SESSION_STATUS.ERROR,
      DISPLAYED_SESSION_STATUS.UNKNOWN,
      DISPLAYED_SESSION_STATUS.STALE,
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
  it("explains a stale fold with the canonical staleness sentence", () => {
    expect(
      emptyReasonFor({
        endedAt: null,
        lastActivityAt: SILENT_SINCE,
        startedAt: STARTED_AT,
        status: SESSION_STATUS.ACTIVE,
      })
    ).toBe(SESSION_STALE_TOOLTIP);
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
   * ISS-5575 (wongk, #4971): the reason is keyed off the rendered LABEL's
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
  ])("keeps the no-start sentence on a measurable $case window with no start", ({
    endedAt,
    status,
  }) => {
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
  });
});

/**
 * The reason as the two consumers compute it: resolve the window ONCE, then ask
 * it. That is the composition `SessionDurationProperty` and
 * `SessionTimelineSummary` run (thadeusb, #4971), so a test cannot pass a window
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
