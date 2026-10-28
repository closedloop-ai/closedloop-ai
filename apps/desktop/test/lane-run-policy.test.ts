/**
 * @file lane-run-policy.test.ts
 * @description PLN-2028 (ISS-10043, ISS-9963): the lane-run READER and the
 * producer policy — what the four persisted columns mean once they are read back,
 * and which producer's give-up a relaunch may resume into a lane's gate.
 *
 * These are the decisions a corrupt or legacy row is decided by, and every one of
 * them is reachable only on a relaunch — the moment nothing in the process
 * remembers what the row means. That is why they are pinned here as pure
 * functions rather than only through a lane: a lane test that happened to seed a
 * well-formed row would exercise none of them.
 *
 * The producer VOCABULARY is not asserted here either, and since PLN-2028 D7 it
 * cannot be: `LaneGiveUpSource` is imported from the contract package the cloud
 * wire schema derives its own `z.enum` from, so there is no second copy left for
 * a test to hold against the first (tamsinb review).
 *
 * The exhaustiveness of `LANE_RUN_POLICY` and `LANE_RUN_LEGACY_SOURCE` is NOT
 * asserted here. Both are `Record`s over closed unions, so a new lane or producer
 * fails `tsc`; a runtime test re-stating today's members would pass against
 * exactly the omission the type already prevents.
 */
import {
  LaneGiveUpSource,
  SyncLane,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { describe, expect, it } from "vitest";
import {
  LANE_RUN_POLICY,
  laneGateGiveUpSource,
  laneRunResumesHold,
  readLaneRunRecord,
} from "../src/main/sync/lane-run-policy.js";
import { LaneGiveUpStampDefect } from "../src/shared/lane-give-up.js";

const NOW_MS = Date.parse("2026-08-03T12:00:00.000Z");
const MINUTE_MS = 60_000;
const OPENED_MS = NOW_MS - 30 * 60 * MINUTE_MS;
const GAVE_UP_MS = NOW_MS - 60 * MINUTE_MS;
const OPENED_AT = new Date(OPENED_MS).toISOString();
const GAVE_UP_AT = new Date(GAVE_UP_MS).toISOString();

describe("readLaneRunRecord: a well-formed row", () => {
  it("reads all four columns back as the run the lane holds", () => {
    const read = readLaneRunRecord(
      {
        laneStalledSince: OPENED_AT,
        laneGaveUpAt: GAVE_UP_AT,
        laneGaveUpReason: SyncReason.IngestionFailed,
        laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
      },
      SyncLane.ComponentInventory,
      NOW_MS
    );

    expect(read.origin.atMs).toBe(OPENED_MS);
    expect(read.giveUp.atMs).toBe(GAVE_UP_MS);
    expect(read.reason).toBe(SyncReason.IngestionFailed);
    expect(read.source).toBe(LaneGiveUpSource.EnvironmentalGate);
  });

  it("reads an EMPTY row as a lane with no run and nothing to attach to one", () => {
    const read = readLaneRunRecord({}, SyncLane.ComponentInventory, NOW_MS);

    expect(read.origin.atMs).toBe(null);
    expect(read.giveUp.atMs).toBe(null);
    expect(read.origin.defect).toBe(null);
    expect(read.giveUp.defect).toBe(null);
    expect(read.reason).toBe(null);
    expect(read.source).toBe(null);
  });
});

describe("readLaneRunRecord: D6, a bad value degrades its own field", () => {
  it("adopts NO origin from an unreadable one, and still reads the give-up", () => {
    // An unreadable origin is not evidence that anything waited, so the lane
    // opens a fresh run rather than giving up on a duration it cannot
    // substantiate. The give-up beside it is untouched: degrading the pair
    // together would lose a terminal state to a single corrupt column.
    const read = readLaneRunRecord(
      { laneStalledSince: "not-a-date", laneGaveUpAt: GAVE_UP_AT },
      SyncLane.ComponentInventory,
      NOW_MS
    );

    expect(read.origin.atMs).toBe(null);
    expect(read.origin.defect).toBe(LaneGiveUpStampDefect.Unreadable);
    expect(read.giveUp.atMs).toBe(GAVE_UP_MS);
  });

  it("CLAMPS a future instant and keeps what the column holds, so the row can be repaired", () => {
    // A backwards clock jump or a corrupt row. Adopted verbatim, every elapsed
    // reading measures zero forever and the widening recovery door never opens.
    // `storedMs` diverging from `atMs` is what makes the repair write a genuine
    // change rather than an equality-gated no-op.
    const futureMs = NOW_MS + 90 * 24 * 60 * MINUTE_MS;
    const read = readLaneRunRecord(
      {
        laneStalledSince: new Date(futureMs).toISOString(),
        laneGaveUpAt: new Date(futureMs).toISOString(),
      },
      SyncLane.ComponentInventory,
      NOW_MS
    );

    expect(read.origin.atMs).toBe(NOW_MS);
    expect(read.origin.storedMs).toBe(futureMs);
    expect(read.origin.defect).toBe(LaneGiveUpStampDefect.Future);
    expect(read.giveUp.atMs).toBe(NOW_MS);
    expect(read.giveUp.defect).toBe(LaneGiveUpStampDefect.Future);
  });

  it.each(["0", "2000", "2026-08-03"])(
    "refuses %j as an instant rather than letting `Date.parse` invent one",
    (corrupt) => {
      // `Date.parse` accepts far more than the store writes: `"0"` reads back as
      // the year 2000. Adopted as a run ORIGIN that is a lane already 26 years
      // past its 24h ceiling, so the next failure gives up on the spot — the
      // worst outcome this ceiling can produce (whitlockk review). The accepted
      // domain is the column's own, the one the write refuses against.
      const read = readLaneRunRecord(
        { laneStalledSince: corrupt, laneGaveUpAt: corrupt },
        SyncLane.ComponentInventory,
        NOW_MS
      );

      expect(read.origin.atMs).toBe(null);
      expect(read.origin.defect).toBe(LaneGiveUpStampDefect.Unreadable);
      expect(read.giveUp.atMs).toBe(null);
      expect(read.giveUp.defect).toBe(LaneGiveUpStampDefect.Unreadable);
    }
  );

  it("drops an UNKNOWN reason rather than passing a newer build's word through", () => {
    const read = readLaneRunRecord(
      { laneGaveUpAt: GAVE_UP_AT, laneGaveUpReason: "quantum_flux" },
      SyncLane.ComponentInventory,
      NOW_MS
    );

    expect(read.reason).toBe(null);
    // The give-up itself survives: the lane is still terminal, it just cannot
    // say why — which is exactly what a resumed give-up already reports.
    expect(read.giveUp.atMs).toBe(GAVE_UP_MS);
  });

  it("drops `lane_gave_up` as a CAUSE, because it is the outcome's own name", () => {
    // Answering "why did this lane give up?" with "it gave up" sends an operator
    // after a precondition that was never the problem. This is the one member of
    // the closed reason set that is refused here.
    const read = readLaneRunRecord(
      { laneGaveUpAt: GAVE_UP_AT, laneGaveUpReason: SyncReason.LaneGaveUp },
      SyncLane.ComponentInventory,
      NOW_MS
    );

    expect(read.reason).toBe(null);
  });

  it("forces the reason and producer to null when there is no give-up to attach them to", () => {
    // A cause with no give-up is a contradiction, not a partial record. Carried
    // through, it would let a lane announce a give-up it is not holding.
    const read = readLaneRunRecord(
      {
        laneStalledSince: OPENED_AT,
        laneGaveUpAt: "not-a-date",
        laneGaveUpReason: SyncReason.IngestionFailed,
        laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
      },
      SyncLane.ComponentInventory,
      NOW_MS
    );

    expect(read.giveUp.atMs).toBe(null);
    expect(read.reason).toBe(null);
    expect(read.source).toBe(null);
    // The origin is independent and survives, so the lane resumes its run.
    expect(read.origin.atMs).toBe(OPENED_MS);
  });
});

describe("readLaneRunRecord: D3, a stamp with no recorded producer", () => {
  it("resolves a NULL producer to the only one that lane had", () => {
    // Every row written before migration 0091 reads this way, so this is the
    // ordinary path at upgrade and not a repair.
    const component = readLaneRunRecord(
      { laneGaveUpAt: GAVE_UP_AT },
      SyncLane.ComponentInventory,
      NOW_MS
    );
    const session = readLaneRunRecord(
      { laneGaveUpAt: GAVE_UP_AT },
      SyncLane.SessionMetadata,
      NOW_MS
    );

    expect(component.source).toBe(LaneGiveUpSource.EnvironmentalGate);
    // The asymmetry is the point: the session lane's only producer before
    // ISS-8610 was the row ceiling, and reading such a stamp as a GATE give-up
    // is the ISS-10043 bounce that holds a healthy lane.
    expect(session.source).toBe(LaneGiveUpSource.RowCeiling);
  });

  it("resolves an UNRECOGNISED producer to NONE, not to the lane's legacy answer", () => {
    // Only an ABSENT producer is a legacy row. A value present but unknown was
    // written by a build that had a producer this one does not, and sharing the
    // fallback makes it whatever that lane used to write — on the component lane,
    // the gate, which resumes a LANE-WIDE hold for a producer that may never have
    // been allowed one (whitlockk review).
    const component = readLaneRunRecord(
      { laneGaveUpAt: GAVE_UP_AT, laneGaveUpSource: "some_future_producer" },
      SyncLane.ComponentInventory,
      NOW_MS
    );

    expect(component.source).toBe(null);
    expect(
      laneRunResumesHold(SyncLane.ComponentInventory, component.source)
    ).toBe(false);
    // The give-up itself still survives on the row: unattributable is not corrupt,
    // and the lane keeps the instant it cannot attribute.
    expect(component.giveUp.atMs).toBe(GAVE_UP_MS);
  });

  it("adopts NO producer for a lane that writes no give-up", () => {
    // Inventing one would make a corrupt row look like a give-up the lane never
    // had, on a lane with no terminal path at all.
    const read = readLaneRunRecord(
      { laneGaveUpAt: GAVE_UP_AT },
      SyncLane.TraceComments,
      NOW_MS
    );

    expect(read.source).toBe(null);
  });
});

describe("LANE_RUN_POLICY: who may resume a hold", () => {
  it("resumes a GATE give-up into the lane gate on both gate-backed lanes", () => {
    expect(
      laneRunResumesHold(
        SyncLane.ComponentInventory,
        LaneGiveUpSource.EnvironmentalGate
      )
    ).toBe(true);
    expect(
      laneRunResumesHold(
        SyncLane.SessionMetadata,
        LaneGiveUpSource.EnvironmentalGate
      )
    ).toBe(true);
  });

  it("answers NO for a row-ceiling give-up on the session lane (ISS-10043)", () => {
    // The bounce. A per-row ceiling says enough individual rows exhausted their
    // own budgets; resuming it as a LANE-wide terminal hold stops a lane that is
    // not lane-wide broken, and it stays stopped across every later relaunch.
    // This pins the POLICY's answer. The component lane already consults it
    // (`ComponentLaneGiveUp.adoptPersisted`); the session lane joins in M4.
    expect(
      laneRunResumesHold(SyncLane.SessionMetadata, LaneGiveUpSource.RowCeiling)
    ).toBe(false);
    // ...while the lane still genuinely HAS that producer, so the record it
    // writes is not a corrupt one to be discarded.
    expect(
      LANE_RUN_POLICY[SyncLane.SessionMetadata][LaneGiveUpSource.RowCeiling]
        .produces
    ).toBe(true);
  });

  it("resumes nothing for a give-up whose producer could not be resolved", () => {
    expect(laneRunResumesHold(SyncLane.SessionMetadata, null)).toBe(false);
  });

  it("attributes a GATE give-up only on a lane that produces one", () => {
    // The write half of the same table. A lane naming the producer itself would
    // leave the `Record` exhaustive on the read path only, so a lane wired with
    // `produces: false` could still stamp a gate give-up and typecheck clean
    // (marisolashgrove review). `null` is the fail-safe answer: an unattributed
    // stamp resumes no hold anywhere it is read.
    expect(laneGateGiveUpSource(SyncLane.ComponentInventory)).toBe(
      LaneGiveUpSource.EnvironmentalGate
    );
    expect(laneGateGiveUpSource(SyncLane.TraceComments)).toBe(null);
  });
});
