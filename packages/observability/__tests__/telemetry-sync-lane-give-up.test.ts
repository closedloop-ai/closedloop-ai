/**
 * @file telemetry-sync-lane-give-up.test.ts
 * @description ISS-9418 - the `syncLaneGaveUp` / `syncLaneReArmed` diagnostics
 * must survive the wire validator, because a lane give-up has NO user-facing
 * surface by explicit decision (PLN-1961 D-a) and these two events are the whole
 * channel through which anyone learns collection stopped.
 *
 * The top-level diagnostics object STRIPS unknown keys, so a field the desktop
 * emits and this schema does not mirror vanishes silently and the grouped query
 * returns nothing. That is worse here than on the sibling stall family: there a
 * dropped dimension costs a breakdown, here it can cost the only signal.
 *
 * `reason` and `trigger` are TOLERANT vocabularies, so the cases come in pairs:
 * every in-tree value must survive as ITSELF, and a value only a newer desktop
 * knows must survive COARSENED. Desktop and cl-api deploy independently, so the
 * event has to land either way.
 */
import {
  LaneGiveUpSource,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { describe, expect, it } from "vitest";
import { sanitizeDesktopTelemetryDiagnostics } from "../telemetry/emitter";
import { desktopTelemetryEventSchema } from "../telemetry/schema";
import { TelemetryCategory } from "../telemetry/telemetry-category";

/**
 * The RAW reason strings the desktop producer can emit, written out rather than
 * taken from the schema's own const - a case written against the thing it
 * polices moves in lockstep with it and stays green while the two halves drift.
 * Pinned back to the canonical owner below, which is the other half of that
 * discipline.
 */
const PRODUCER_REASONS = [
  "ack_clear_failed",
  "ack_omitted",
  "ack_timeout",
  "generation_conflict",
  "part_conflict",
  "protocol_unsupported",
  "rate_limited",
  "session_missing",
  "source_missing",
  "transport_timeout",
  "transport_unavailable",
  "ingestion_failed",
  "upload_conflict",
  "validation_failed",
  "feature_disabled",
  "locally_oversized",
  "target_not_owned",
  "transport_error",
  "unauthenticated",
  "unhydratable",
  "lane_gave_up",
  "local_read_failed",
] as const;

/**
 * The raw triggers `LaneReArmTrigger` emits. HAND-WRITTEN: the const lives in
 * `apps/desktop/src/shared/lane-give-up.ts`, app code this package cannot
 * import, so adding a door means editing this list and the schema together.
 */
const PRODUCER_TRIGGERS = ["event", "window"] as const;

/**
 * The raw producers `LaneGiveUpSource` emits (PLN-2028 D7), written out for the
 * reason the reasons above are: a case written against the thing it polices
 * moves in lockstep with it and stays green while the two halves drift.
 *
 * Unlike the triggers, this one HAS a canonical owner a test can reach -
 * `LaneGiveUpSource` in `packages/telemetry-contract/sync.ts`, which this
 * package's vitest aliases to source while the schema module itself resolves
 * that subpath to a `dist` the script lanes never build. So the pin below is
 * what holds the two together, and it is the only place that can see both.
 */
const PRODUCER_SOURCES = ["environmental_gate", "row_ceiling"] as const;

/** What both tolerant vocabularies coarsen an unrecognised string onto. */
const SENTINEL_UNKNOWN = "unknown";

const VALID_GAVE_UP = {
  lane: "component_inventory",
  reason: "unauthenticated",
  stalledForMs: 86_400_123,
  itemsOwed: 11,
} as const;

function eventWith(diagnostics: unknown, category: TelemetryCategory) {
  return {
    schemaVersion: "1",
    category,
    severity: "error",
    timestamp: "2026-09-10T00:00:00.000Z",
    trace: { commandId: "", operationId: "", computeTargetId: "target-1" },
    diagnostics,
  };
}

function parsedGaveUp(syncLaneGaveUp: unknown) {
  const parsed = desktopTelemetryEventSchema.safeParse(
    eventWith({ syncLaneGaveUp }, TelemetryCategory.SyncLaneGaveUp)
  );
  return parsed.success ? parsed.data.diagnostics?.syncLaneGaveUp : undefined;
}

function parsedReArmed(syncLaneReArmed: unknown) {
  const parsed = desktopTelemetryEventSchema.safeParse(
    eventWith({ syncLaneReArmed }, TelemetryCategory.SyncLaneReArmed)
  );
  return parsed.success ? parsed.data.diagnostics?.syncLaneReArmed : undefined;
}

/**
 * Whether the WHOLE event validated - the distinction the two helpers above
 * cannot make, since each answers `undefined` both for a rejected event and for
 * a family merely stripped from an accepted one.
 */
function eventAccepts(diagnostics: unknown, category: TelemetryCategory) {
  return desktopTelemetryEventSchema.safeParse(eventWith(diagnostics, category))
    .success;
}

describe("syncLaneGaveUp wire schema (ISS-9418)", () => {
  it("pins the producer reason list to the canonical SyncReason", () => {
    // The literals above defend against this schema changing; this pin defends
    // against the PRODUCER changing. Without it a reason added upstream leaves
    // both copies untouched and green, and every give-up carrying it reports
    // under the `unknown` sentinel - alerting but naming no cause.
    expect([...PRODUCER_REASONS].sort()).toEqual(
      Object.values(SyncReason).sort()
    );
  });

  it("pins the producer source list to the canonical LaneGiveUpSource", () => {
    // Same discipline as the reason pin above, one layer further out: the
    // literals defend against this schema changing, and this defends against the
    // PRODUCER changing. A third producer added to the contract leaves the
    // schema's enum untouched and green, and every give-up carrying it reports
    // under the `unknown` sentinel - so the monitor grouped by producer stops
    // separating a terminal outage from a routine ceiling with nothing red.
    expect([...PRODUCER_SOURCES].sort()).toEqual(
      Object.values(LaneGiveUpSource).sort()
    );
  });

  it("carries every dimension an operator groups by", () => {
    expect(parsedGaveUp(VALID_GAVE_UP)).toEqual(VALID_GAVE_UP);
  });

  it("keeps every in-tree reason as ITSELF", () => {
    for (const reason of PRODUCER_REASONS) {
      expect(parsedGaveUp({ ...VALID_GAVE_UP, reason })?.reason).toBe(reason);
    }
  });

  it("coarsens a reason only a newer desktop knows, and keeps the event", () => {
    const parsed = parsedGaveUp({
      ...VALID_GAVE_UP,
      reason: "quantum_entanglement_lost",
    });

    expect(parsed?.reason).toBe(SENTINEL_UNKNOWN);
    // The dimensions that still mean something must come through untouched: the
    // whole point of coarsening is that the give-up itself is not lost.
    expect(parsed?.lane).toBe(VALID_GAVE_UP.lane);
    expect(parsed?.stalledForMs).toBe(VALID_GAVE_UP.stalledForMs);
  });

  it("keeps an OMITTED reason omitted, and keeps the event", () => {
    const { reason, ...withoutReason } = VALID_GAVE_UP;
    const parsed = parsedGaveUp(withoutReason);

    // A desktop that RELAUNCHED inside an outage resumes the give-up from a
    // durable column that records an instant and no cause, so it omits this
    // rather than naming a `SyncReason` that means something else. The event is
    // the whole channel, so the lane and the counts must still land - a required
    // field here would have rejected the object and taken them with it.
    expect(parsed).not.toBeUndefined();
    expect(Object.hasOwn(parsed ?? {}, "reason")).toBe(false);
    expect(parsed?.lane).toBe(VALID_GAVE_UP.lane);
    expect(parsed?.stalledForMs).toBe(VALID_GAVE_UP.stalledForMs);
    expect(parsed?.itemsOwed).toBe(VALID_GAVE_UP.itemsOwed);
  });

  it("keeps an OMITTED itemsOwed omitted rather than defaulting it to zero", () => {
    const { itemsOwed, ...withoutOwed } = VALID_GAVE_UP;
    const parsed = parsedGaveUp(withoutOwed);

    expect(parsed).not.toBeUndefined();
    expect(parsed?.itemsOwed).toBeUndefined();
    // A `0` here would read as "nothing was owed" on the exact event that says
    // collection has stopped, which is why the producer omits it for a lane
    // that keeps no queue.
    expect(Object.hasOwn(parsed ?? {}, "itemsOwed")).toBe(false);
  });

  it("REFUSES a negative duration rather than recording it", () => {
    expect(
      eventAccepts(
        { syncLaneGaveUp: { ...VALID_GAVE_UP, stalledForMs: -1 } },
        TelemetryCategory.SyncLaneGaveUp
      )
    ).toBe(false);
  });

  it("keeps an OMITTED stalledForMs omitted rather than defaulting it to zero", () => {
    const { stalledForMs, ...withoutDuration } = VALID_GAVE_UP;
    const parsed = parsedGaveUp(withoutDuration);

    // The producer omits this when the value it holds is not a measurement, and
    // the refusal above is why it cannot simply send the bad number instead. A
    // `0` reads as "gave up instantly" on the one field that says how long the
    // outage has been running, so the absence has to survive - and the lane, the
    // reason and the counts have to survive with it.
    expect(parsed).not.toBeUndefined();
    expect(Object.hasOwn(parsed ?? {}, "stalledForMs")).toBe(false);
    expect(parsed?.lane).toBe(VALID_GAVE_UP.lane);
    expect(parsed?.reason).toBe(VALID_GAVE_UP.reason);
    expect(parsed?.itemsOwed).toBe(VALID_GAVE_UP.itemsOwed);
  });

  it("keeps every in-tree producer as ITSELF", () => {
    // PLN-2028 D7. The producer is what makes a grouped query mean something on
    // the session lane, which has two of them writing one give-up: a coarsened
    // value would put a terminal lane-wide give-up in the same bucket as a
    // per-row ceiling the lane keeps attempting past.
    for (const source of PRODUCER_SOURCES) {
      expect(parsedGaveUp({ ...VALID_GAVE_UP, source })?.source).toBe(source);
    }
  });

  it("coarsens a producer only a newer desktop knows, and keeps the event", () => {
    const parsed = parsedGaveUp({
      ...VALID_GAVE_UP,
      source: "a_producer_this_build_never_heard_of",
    });

    expect(parsed?.source).toBe(SENTINEL_UNKNOWN);
    expect(parsed?.lane).toBe(VALID_GAVE_UP.lane);
    expect(parsed?.reason).toBe(VALID_GAVE_UP.reason);
    expect(parsed?.stalledForMs).toBe(VALID_GAVE_UP.stalledForMs);
  });

  it("keeps an OMITTED producer omitted, and keeps the event", () => {
    const parsed = parsedGaveUp(VALID_GAVE_UP);

    // Two producers omit it, and this schema deploys ahead of both: a desktop
    // older than PLN-2028 M5 sends no producer at all, and a give-up RESUMED off
    // a row written before migration 0091 has none on record. Defaulting it
    // would attribute a give-up to a producer nobody observed.
    expect(parsed).not.toBeUndefined();
    expect(Object.hasOwn(parsed ?? {}, "source")).toBe(false);
    expect(parsed?.lane).toBe(VALID_GAVE_UP.lane);
  });

  it("carries the count the ceiling ABANDONED, distinct from the remainder", () => {
    // The one dimension the sibling stall event already carries under this exact
    // name. The top-level diagnostics object STRIPS unknown keys, so a field the
    // desktop emits and this schema does not mirror vanishes silently.
    const parsed = parsedGaveUp({ ...VALID_GAVE_UP, deadLetteredCount: 7 });

    expect(parsed?.deadLetteredCount).toBe(7);
    expect(parsed?.itemsOwed).toBe(VALID_GAVE_UP.itemsOwed);
  });

  it("keeps an OMITTED deadLetteredCount omitted - a lane with no queue abandoned nothing", () => {
    const parsed = parsedGaveUp(VALID_GAVE_UP);

    expect(Object.hasOwn(parsed ?? {}, "deadLetteredCount")).toBe(false);
  });

  it("survives the redaction pass beside a scrubbed sibling", () => {
    const sanitized = sanitizeDesktopTelemetryDiagnostics({
      syncLaneGaveUp: { ...VALID_GAVE_UP },
      logTail: "/Users/someone/Library/Application Support/secret.log",
    });

    // Counts and bounded vocabularies, so this family must come through
    // byte-for-byte even while a free-text sibling is being scrubbed.
    expect(sanitized?.syncLaneGaveUp).toEqual(VALID_GAVE_UP);
  });
});

describe("syncLaneReArmed wire schema (ISS-9418)", () => {
  it("keeps every in-tree trigger as ITSELF", () => {
    for (const trigger of PRODUCER_TRIGGERS) {
      expect(
        parsedReArmed({ lane: "component_inventory", trigger })?.trigger
      ).toBe(trigger);
    }
  });

  it("coarsens a door only a newer desktop knows, and keeps the event", () => {
    const parsed = parsedReArmed({
      lane: "component_inventory",
      trigger: "a_door_this_build_never_heard_of",
    });

    expect(parsed?.trigger).toBe(SENTINEL_UNKNOWN);
    expect(parsed?.lane).toBe("component_inventory");
  });

  it("keeps an ABSENT trigger absent - a lane that answered came through no door", () => {
    const parsed = parsedReArmed({ lane: "session_metadata" });

    expect(parsed).toEqual({ lane: "session_metadata" });
    // Defaulting this to a door would assert the precise distinction the field
    // exists to keep: `event` says the world changed, `window` says only that
    // time passed, and an answered batch is neither.
    expect(Object.hasOwn(parsed ?? {}, "trigger")).toBe(false);
  });

  it("carries the duration the lane was given up", () => {
    expect(
      parsedReArmed({
        lane: "component_inventory",
        trigger: "window",
        gaveUpForMs: 300_001,
      })
    ).toEqual({
      lane: "component_inventory",
      trigger: "window",
      gaveUpForMs: 300_001,
    });
  });
});
