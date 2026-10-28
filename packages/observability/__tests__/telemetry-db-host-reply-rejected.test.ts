/**
 * @file telemetry-db-host-reply-rejected.test.ts
 * @description ISS-8115 — the `dbHostReplyRejected` diagnostics must survive the
 * server boundaries the desktop event crosses before it reaches a log sink.
 *
 * This is the half the desktop suite cannot cover. `apps/desktop` has no
 * dependency on this package — the two `TelemetryCategory` declarations are
 * deliberate mirrors with no shared import — so the desktop test proves only that
 * main EMITS the rejection. If this schema does not mirror the category and the
 * op enum, that emit is dropped server-side as `telemetry.validation_failed` and
 * the signal is dark with nothing failing anywhere.
 *
 * That failure mode is the whole point of this file. ISS-8115's boundary schemas
 * degrade a bad db-host reply GRACEFULLY — the sync lane keeps running and
 * nothing throws — so the monitored event is the only evidence a version-skewed
 * peer exists at all. An event dropped at ingest would leave the degradation
 * looking exactly like a healthy peer, which is the silence the ticket exists to
 * end, reproduced one layer further out.
 */
import { describe, expect, it } from "vitest";
import { DbHostRejectedReplyOp } from "../telemetry/db-host-reply-rejection-reason";
import { sanitizeDesktopTelemetryDiagnostics } from "../telemetry/emitter";
import { desktopTelemetryEventSchema } from "../telemetry/schema";
import { TelemetryCategory } from "../telemetry/telemetry-category";

/** A well-formed payload as `reportRejectedDbHostReply` emits it. */
const VALID_REJECTION = {
  op: DbHostRejectedReplyOp.FindExistingSessionIds,
} as const;

function eventWith(dbHostReplyRejected: unknown) {
  return {
    schemaVersion: "1",
    category: TelemetryCategory.DbHostReplyRejected,
    severity: "error",
    timestamp: "2026-08-26T00:00:00.000Z",
    trace: {
      commandId: "",
      operationId: "",
      computeTargetId: "target-1",
    },
    diagnostics: { dbHostReplyRejected },
  };
}

/**
 * An op path this schema must never mirror, used to prove the enum actually
 * rejects rather than waving anything through.
 *
 * ISS-8135: this used to be a REAL op path that simply had not been covered yet
 * (`sync_source.load_pending_outbox_ids`), and the next batch to cover that op
 * turned this case vacuous — it was asserting that a now-valid value is invalid,
 * so it failed loudly, which is the good outcome. A plausible-but-uncovered op
 * is the wrong sentinel for a test that must keep meaning the same thing while
 * the enum grows. This one names its own impossibility instead, and the
 * `it("never becomes a real op")` case below fails the moment somebody declares
 * it anyway, so this cannot quietly rot into a test that proves nothing.
 */
const NEVER_A_REAL_OP = "sync_source.an_op_this_build_has_never_heard_of";

function parsedRejection(dbHostReplyRejected: unknown) {
  const parsed = desktopTelemetryEventSchema.safeParse(
    eventWith(dbHostReplyRejected)
  );
  return parsed.success
    ? parsed.data.diagnostics?.dbHostReplyRejected
    : undefined;
}

describe("dbHostReplyRejected wire schema (ISS-8115)", () => {
  it("keeps the legacy retry-state op spelling as an alias", () => {
    expect(DbHostRejectedReplyOp.LoadPendingOutboxRetryState).toBe(
      DbHostRejectedReplyOp.LoadPendingSessionOutboxEngineState
    );
  });

  it("carries the category, severity and op through validation", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith(VALID_REJECTION)
    );
    expect(parsed.success).toBe(true);
    const event = parsed.success ? parsed.data : undefined;
    // The facets a Datadog log monitor keys on must survive verbatim.
    expect(event?.category).toBe("desktop.db_host.reply_rejected");
    expect(event?.severity).toBe("error");
    expect(event?.diagnostics?.dbHostReplyRejected).toEqual(VALID_REJECTION);
  });

  it("accepts every op this schema declares", () => {
    // Scoped deliberately, exactly as the ISS-7201 sibling is: this loop reads
    // the INGEST enum and feeds it back into the ingest schema, so it proves
    // only that every declared member survives `z.enum` + `.strip()`. It CANNOT
    // see a producer-only member (`apps/desktop` is not importable here); the
    // desktop↔ingest mirror is enforced by the
    // `no-unmirrored-desktop-telemetry-enum` source gate, not by this test.
    for (const op of Object.values(DbHostRejectedReplyOp)) {
      expect(parsedRejection({ op })).toEqual({ op });
    }
  });

  it("rejects an op this schema does not mirror", () => {
    // davetho (#6041): `parsedRejection()` collapses two outcomes into one
    // `undefined` — the schema REJECTING the event, and a future schema that
    // accepts the event while stripping or omitting `diagnostics.
    // dbHostReplyRejected`. Only the first is the contract the PR body relies
    // on (a producer-only op becomes `telemetry.validation_failed` at ingest),
    // so assert the parse failure itself and pin the issue to the field that
    // must cause it. Asserted against the schema, not the helper.
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith({ op: NEVER_A_REAL_OP })
    );
    expect(parsed.success).toBe(false);
    const issuePaths = parsed.success
      ? []
      : parsed.error.issues.map((issue) => issue.path.join("."));
    expect(issuePaths).toContain("diagnostics.dbHostReplyRejected.op");
  });

  it("never becomes a real op — the rejection sentinel stays impossible", () => {
    // The guard that keeps the case above from going vacuous. Without it, a
    // later batch that happens to declare the sentinel would turn "rejects an op
    // this schema does not mirror" into a test that asserts a VALID value is
    // rejected — or, worse if the assertion were ever loosened, one that passes
    // while proving nothing. That is precisely how ISS-8135 found this file.
    expect(Object.values(DbHostRejectedReplyOp)).not.toContain(NEVER_A_REAL_OP);
  });

  it("strips a field the schema does not mirror", () => {
    // The content guard, enforced by the schema rather than by review: the
    // rejected reply is exactly what could not be trusted, so a producer that
    // "helpfully" attached it to aid debugging must not get it onto the wire.
    const result = parsedRejection({
      ...VALID_REJECTION,
      rejectedValue: ["session-id-that-must-not-travel"],
      replyPreview: "/Users/someone/.claude/projects/x",
    });
    expect(result).toEqual(VALID_REJECTION);
    expect(result).not.toHaveProperty("rejectedValue");
    expect(result).not.toHaveProperty("replyPreview");
  });

  it("keeps the event valid when the family is absent", () => {
    // The field is optional: every other desktop category must still validate.
    const parsed = desktopTelemetryEventSchema.safeParse({
      ...eventWith(VALID_REJECTION),
      diagnostics: {},
    });
    expect(parsed.success).toBe(true);
    expect(
      parsed.success ? parsed.data.diagnostics?.dbHostReplyRejected : "unset"
    ).toBeUndefined();
  });
});

describe("dbHostReplyRejected through sanitizeDesktopTelemetryDiagnostics (ISS-8115)", () => {
  it("survives alongside a sibling field that IS scrubbed", () => {
    // The sanitizer rewrites `logTail`; a shallow-copy regression there is
    // exactly how an untouched sibling gets dropped.
    const sanitized = sanitizeDesktopTelemetryDiagnostics({
      dbHostReplyRejected: { ...VALID_REJECTION },
      logTail: "password=hunter2\nstill here",
    });
    expect(sanitized?.dbHostReplyRejected).toEqual(VALID_REJECTION);
    expect(sanitized?.logTail).not.toContain("hunter2");
  });
});
