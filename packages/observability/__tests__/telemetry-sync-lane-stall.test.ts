/**
 * @file telemetry-sync-lane-stall.test.ts
 * @description ISS-7401 — the `syncLaneStall` diagnostics must survive both
 * server boundaries the desktop event crosses before it reaches a log sink,
 * because the whole point of the family is a monitor that GROUPS BY lane and
 * kind.
 *
 * `sync.durable_cursor.stalled` previously carried both facts only inside
 * `message`. The panel could therefore count stalls and nothing else: a session
 * lane at healthy flat queue depth and a transcript lane sitting on thousands of
 * dead-letters were one undifferentiated number, and "which population
 * dominates" was unanswerable without reading events by hand.
 *
 *   1. `desktopTelemetryEventSchema` — the wire validator. The top-level
 *      diagnostics object STRIPS unknown keys, so a field the desktop emits and
 *      this schema does not mirror vanishes silently and the grouped query
 *      returns nothing.
 *   2. `sanitizeDesktopTelemetryDiagnostics` — the redaction pass run before
 *      logging. This family is counts and bounded vocabularies, so it must come
 *      through byte-for-byte, including while a SIBLING field is scrubbed.
 *
 * `lane` and `kind` are TOLERANT vocabularies, so the cases below come in pairs:
 * every in-tree value must survive as ITSELF, and a value only a newer desktop
 * knows must survive COARSENED — the event lands either way, which is the point,
 * since desktop and server deploy independently.
 */
import { SyncLane } from "@closedloop-ai/telemetry-contract/sync";
import { describe, expect, it } from "vitest";
import { sanitizeDesktopTelemetryDiagnostics } from "../telemetry/emitter";
import { desktopTelemetryEventSchema } from "../telemetry/schema";
import { TelemetryCategory } from "../telemetry/telemetry-category";

/**
 * The RAW lane strings the desktop producer emits, written out rather than
 * taken from the SCHEMA's own const — a case written against the thing it
 * polices moves in lockstep with it and stays green while the two halves drift,
 * exactly as `telemetry-tolerant-enum-mirror.test.ts` explains.
 *
 * Pinned back to the CANONICAL owner below, which is the other half of that
 * discipline: writing the literals out defends against the schema changing,
 * and the pin defends against the producer changing. Without it all three
 * copies — canonical, schema mirror, and this list — could diverge silently,
 * and a lane added upstream would report every one of its stalls under the
 * `unknown` sentinel, alerting but naming no lane, with nothing red in CI.
 * (Before the vocabulary was made tolerant it was worse: the unmirrored lane
 * failed validation and the WHOLE event became `telemetry.validation_failed`.)
 */
const PRODUCER_LANES = [
  "session_metadata",
  "invocation_parts",
  "transcript_archive",
  "component_inventory",
  "trace_comments",
] as const;

/**
 * The raw kinds `SyncLaneStallKind` emits from the desktop shared contract.
 *
 * HAND-WRITTEN, unlike {@link PRODUCER_LANES}'s pin below, because the const
 * lives in `apps/desktop` app code this package cannot import. That asymmetry is
 * a real gap and not a stylistic one: this list catches the SCHEMA regressing and
 * cannot catch a kind added UPSTREAM, which is how `gate_shut_with_backlog`
 * (ISS-8768) reached the coarsening sentinel with nothing red. Adding a kind
 * means editing this list and the schema together, by hand, until the const has
 * an importable owner.
 */
const PRODUCER_KINDS = [
  "cursor_frozen",
  "no_progress",
  "gate_shut_with_backlog",
  // ISS-9823.
  "resume_read_failed",
] as const;

/**
 * ISS-9744 — the raw bases `SyncLaneDeadLetteredBasis` emits from the desktop
 * shared contract. HAND-WRITTEN for the same reason as {@link PRODUCER_KINDS}:
 * the const lives in `apps/desktop` app code this package cannot import, so
 * adding a member means editing this list and the schema together.
 */
const PRODUCER_DEAD_LETTERED_BASES = [
  "queue_status_count",
  "abandoned_id_ledger",
  "no_dead_letter_state",
  "unmeasured",
] as const;

/**
 * The member all three tolerant vocabularies coarsen an unrecognised string
 * onto, written out rather than imported for the same reason as the lists above.
 */
const SENTINEL_UNKNOWN = "unknown";

/** A well-formed payload as `reportSyncLaneStall` emits it. */
const VALID_STALL = {
  lane: "session_metadata",
  kind: "no_progress",
  workCompletedSincePrevious: 0,
  deadLetteredCount: 62,
  durableCursorAgeMs: 7_000_000,
  itemsRemaining: 2928,
  itemsRemainingIsLowerBound: false,
} as const;

function eventWith(syncLaneStall: unknown) {
  return {
    schemaVersion: "1",
    category: TelemetryCategory.SyncDurableCursorStalled,
    severity: "error",
    timestamp: "2026-08-23T00:00:00.000Z",
    trace: {
      commandId: "",
      operationId: "",
      computeTargetId: "target-1",
    },
    diagnostics: { syncLaneStall },
  };
}

function parsedStall(syncLaneStall: unknown) {
  const parsed = desktopTelemetryEventSchema.safeParse(
    eventWith(syncLaneStall)
  );
  return parsed.success ? parsed.data.diagnostics?.syncLaneStall : undefined;
}

/**
 * Whether the WHOLE event validated — the distinction `parsedStall` cannot make.
 * It answers `undefined` both when the event was rejected outright and when the
 * family was merely stripped from an otherwise-valid event, so a negative case
 * written against it alone would stay green if this schema ever started
 * discarding the field instead of failing the payload.
 */
function eventAccepts(syncLaneStall: unknown): boolean {
  return desktopTelemetryEventSchema.safeParse(eventWith(syncLaneStall))
    .success;
}

/** The parsed family, as the wire schema hands it back. */
type ParsedSyncLaneStall = NonNullable<ReturnType<typeof parsedStall>>;

/** Its number-valued members — the fields carrying a `.int().nonnegative()`. */
type StallCounts = {
  [K in keyof ParsedSyncLaneStall as NonNullable<
    ParsedSyncLaneStall[K]
  > extends number
    ? K
    : never]: ParsedSyncLaneStall[K];
};

/**
 * Every count the schema bounds, written out and then held to `StallCounts` by
 * `satisfies`. A sixth count added to the schema widens `keyof StallCounts`,
 * which this literal no longer covers, so `tsc` fails here instead of the new
 * field silently joining the set nothing probes — the state four of these five
 * were in until ISS-8113. A bare array or `ReadonlySet<string>` would not:
 * both stay assignable when a member is added.
 */
const NONNEGATIVE_COUNT_FIELDS = {
  workCompletedSincePrevious: true,
  deadLetteredCount: true,
  durableCursorAgeMs: true,
  itemsRemaining: true,
  queueRowsClearedSincePrevious: true,
} as const satisfies Record<keyof StallCounts, true>;

const COUNT_FIELD_NAMES = Object.keys(NONNEGATIVE_COUNT_FIELDS);

describe("syncLaneStall wire schema (ISS-7401)", () => {
  it("pins the producer lane list to the canonical SyncLane", () => {
    // The other half of the mirror discipline: the literals above defend
    // against this schema changing, this pin defends against the PRODUCER
    // changing. Without it a lane added upstream leaves all three copies
    // untouched and green, and that lane's stall alert dies in production.
    expect([...PRODUCER_LANES].sort()).toEqual(Object.values(SyncLane).sort());
  });

  it("carries every field a stall breakdown groups or thresholds on", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith(VALID_STALL)
    );
    expect(parsed.success).toBe(true);
    const event = parsed.success ? parsed.data : undefined;
    expect(event?.category).toBe("sync.durable_cursor.stalled");
    expect(event?.severity).toBe("error");
    expect(event?.diagnostics?.syncLaneStall).toEqual(VALID_STALL);
  });

  it("accepts every lane the burn-down reports, as ITSELF", () => {
    // The in-tree half of the mirror. A lane this schema does not list is
    // COARSENED to `unknown` rather than rejected, so `toEqual` on the whole
    // family — not merely "the event validated" — is what makes an unmirrored
    // producer lane red here instead of silently undimensioned in production.
    for (const lane of PRODUCER_LANES) {
      expect(parsedStall({ ...VALID_STALL, lane })).toEqual({
        ...VALID_STALL,
        lane,
      });
    }
  });

  it("keeps a lane only a NEWER desktop knows, coarsened rather than dropped", () => {
    // Version skew, the shape this tolerance exists for: desktop and server
    // deploy independently, so an installed build WILL name a lane this list
    // does not have. A closed enum sank the WHOLE event on that one string, and
    // re-sank it on every retry, so the newest lane's stalls were the ones that
    // went dark. The event must land with its other dimensions intact.
    const skewed = { ...VALID_STALL, lane: "trace_ingest" };
    expect(eventAccepts(skewed)).toBe(true);
    expect(parsedStall(skewed)).toEqual({
      ...VALID_STALL,
      lane: SENTINEL_UNKNOWN,
    });
  });

  it("does not pass an unmirrored lane through verbatim", () => {
    // The contract is COARSEN, not widen: this fails if the schema is ever
    // relaxed to a bare `z.string()`, which would accept the skewed event and
    // keep every positive case above green while losing the closed vocabulary a
    // dashboard groups by.
    expect(parsedStall({ ...VALID_STALL, lane: "session_meta" })?.lane).toBe(
      SENTINEL_UNKNOWN
    );
    // Non-strings are still invalid — tolerance is for unknown MEMBERS, not for
    // a structurally wrong payload.
    expect(eventAccepts({ ...VALID_STALL, lane: 3 })).toBe(false);
  });

  it("accepts every stall kind, as itself", () => {
    for (const kind of PRODUCER_KINDS) {
      expect(parsedStall({ ...VALID_STALL, kind })?.kind).toBe(kind);
    }
  });

  it("keeps a kind only a NEWER desktop knows, coarsened rather than dropped", () => {
    // The desktop declares `SyncLaneStallKind` in app code this package cannot
    // import, so the two are mirrored by hand and skew is guaranteed. An
    // unmirrored kind costs the breakdown ONE dimension; it must not take the
    // alert down. Deliberately NOT folded onto `cursor_frozen`: a coarsened
    // value counted beside genuinely frozen cursors would overstate them.
    const skewed = { ...VALID_STALL, kind: "cursor_wedged" };
    expect(eventAccepts(skewed)).toBe(true);
    expect(parsedStall(skewed)).toEqual({
      ...VALID_STALL,
      kind: SENTINEL_UNKNOWN,
    });
    expect(eventAccepts({ ...VALID_STALL, kind: 7 })).toBe(false);
  });

  it("validates without the optional measurements, which are omitted not zeroed", () => {
    // A lane that cannot measure its remainder, or has never written a cursor,
    // sends neither field. `0` on either would state the opposite of the alert.
    const parsed = parsedStall({
      lane: "component_inventory",
      kind: "cursor_frozen",
      workCompletedSincePrevious: 47,
      deadLetteredCount: 0,
    });
    expect(parsed).toEqual({
      lane: "component_inventory",
      kind: "cursor_frozen",
      workCompletedSincePrevious: 47,
      deadLetteredCount: 0,
    });
    expect(parsed).not.toHaveProperty("itemsRemaining");
    expect(parsed).not.toHaveProperty("durableCursorAgeMs");
  });

  it("carries a reported cleared-row count of ZERO, which is not the same as absent", () => {
    // The whole point of the field for triage: `0` says the lane cleared
    // nothing, `absent` says nobody counted. Collapsing them would erase the
    // distinction the stall breakdown exists to draw.
    expect(
      parsedStall({ ...VALID_STALL, queueRowsClearedSincePrevious: 0 })
    ).toEqual({ ...VALID_STALL, queueRowsClearedSincePrevious: 0 });
    expect(parsedStall(VALID_STALL)).not.toHaveProperty(
      "queueRowsClearedSincePrevious"
    );
  });

  it.each(COUNT_FIELD_NAMES)("rejects a negative %s", (field) => {
    const payload = { ...VALID_STALL, [field]: -1 };
    expect(eventAccepts(payload)).toBe(false);
    expect(parsedStall(payload)).toBe(undefined);
  });

  it.each(COUNT_FIELD_NAMES)("rejects a fractional %s", (field) => {
    // A count is a tally of rows or milliseconds elapsed; a fraction is as
    // impossible as a negative, and reads as a real measurement either way.
    const payload = { ...VALID_STALL, [field]: 1.5 };
    expect(eventAccepts(payload)).toBe(false);
    expect(parsedStall(payload)).toBe(undefined);
  });

  it("strips a field the schema does not mirror", () => {
    const result = parsedStall({
      ...VALID_STALL,
      transcriptPath: "/Users/someone/.claude/projects/x/a.jsonl",
    });
    expect(result).toEqual(VALID_STALL);
    expect(result).not.toHaveProperty("transcriptPath");
  });

  it("ISS-9744: accepts every dead-letter basis the producer states, as ITSELF", () => {
    // The field exists so a consumer can tell a live queue status count from a
    // durable abandoned-id ledger WITHOUT knowing which lane emitted the event.
    // A basis coarsened to `unknown` on the way in gives that consumer nothing,
    // so `toEqual` on the whole family — not merely "the event validated" — is
    // what makes an unmirrored member red here rather than undimensioned in
    // production.
    for (const deadLetteredBasis of PRODUCER_DEAD_LETTERED_BASES) {
      expect(parsedStall({ ...VALID_STALL, deadLetteredBasis })).toEqual({
        ...VALID_STALL,
        deadLetteredBasis,
      });
    }
  });

  it("ISS-9744: keeps a basis only a NEWER desktop knows, coarsened rather than dropped", () => {
    const skewed = {
      ...VALID_STALL,
      deadLetteredBasis: "permanent_loss_total",
    };
    expect(eventAccepts(skewed)).toBe(true);
    expect(parsedStall(skewed)).toEqual({
      ...VALID_STALL,
      deadLetteredBasis: SENTINEL_UNKNOWN,
    });
    expect(eventAccepts({ ...VALID_STALL, deadLetteredBasis: 3 })).toBe(false);
  });

  it("ISS-9744: keeps absent and stated bases DISTINGUISHABLE", () => {
    // An older desktop states no basis at all. Absent must stay absent — a
    // defaulted member would tell the dashboard the count was measured a way
    // nobody claimed, which is the collapse this field closed — and a stated one
    // must arrive. Both halves in one case on purpose: an absence assertion
    // alone is satisfied by a schema that does not carry the field either.
    expect(parsedStall(VALID_STALL)).not.toHaveProperty("deadLetteredBasis");
    expect(
      parsedStall({ ...VALID_STALL, deadLetteredBasis: "abandoned_id_ledger" })
    ).toHaveProperty("deadLetteredBasis", "abandoned_id_ledger");
  });

  it("keeps the event valid when the family is absent", () => {
    const parsed = desktopTelemetryEventSchema.safeParse({
      ...eventWith(VALID_STALL),
      diagnostics: {},
    });
    expect(parsed.success).toBe(true);
    expect(
      parsed.success ? parsed.data.diagnostics?.syncLaneStall : "unset"
    ).toBeUndefined();
  });
});

describe("syncLaneStall through sanitizeDesktopTelemetryDiagnostics (ISS-7401)", () => {
  it("survives alongside a sibling field that IS scrubbed", () => {
    const sanitized = sanitizeDesktopTelemetryDiagnostics({
      syncLaneStall: { ...VALID_STALL },
      logTail: "password=hunter2\nstill here",
    });
    expect(sanitized?.syncLaneStall).toEqual(VALID_STALL);
    expect(sanitized?.logTail).not.toContain("hunter2");
  });
});
