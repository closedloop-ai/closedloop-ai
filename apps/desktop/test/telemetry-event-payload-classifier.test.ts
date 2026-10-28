/**
 * @file telemetry-event-payload-classifier.test.ts
 * @description ISS-7458 — pins the fault ORDER
 * {@link classifyTelemetryEventPayloadRefusal} documents but nothing exercised.
 *
 * The classifier's docstring declares severity → category → message →
 * diagnostics, first-fault-only, so an event that is bad in two ways is
 * attributed to the routing fault and `unknown_shape` keeps meaning "the routing
 * fields were fine and the diagnostics were not". Every case in the per-reason
 * table in `db-host-child-telemetry-relay.test.ts` carries exactly ONE fault, so
 * any order satisfies it — moving the diagnostics arm ahead of the severity
 * check left all twelve of those tests green.
 *
 * `diagnostics.dbHostTelemetryRefused.reason` is a monitored Datadog dimension.
 * A silent reorder does not break a build; it re-buckets real routing faults
 * under `unknown_shape` while the monitor keeps reporting confidently.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyTelemetryEventPayloadRefusal } from "../src/main/telemetry/telemetry-event-payload.js";
import { DbHostTelemetryRefusalReason } from "../src/main/telemetry/telemetry-protocol.js";

/** A `diagnostics` bag whose known primitive field carries the wrong type. */
const MISTYPED_DIAGNOSTICS = { logTail: {} };

/** A second one, so the ordering is not pinned to a single field's validator. */
const MISTYPED_DIAGNOSTICS_NUMERIC = { exitCode: "1" };

/**
 * One routing fault each, paired with the reason the docstring says wins.
 * The rest of the event is routable, so the ONLY fault is the named one.
 */
const ROUTING_FAULTS: {
  label: string;
  event: Record<string, unknown>;
  // The canonical union, not a bare `string`: a typo'd reason literal must fail
  // `tsc` here rather than only when the test runs.
  reason: DbHostTelemetryRefusalReason;
}[] = [
  {
    label: "unrecognised severity",
    event: { severity: "critical", category: "db-host", message: "m" },
    reason: DbHostTelemetryRefusalReason.InvalidSeverity,
  },
  {
    label: "empty category",
    event: { severity: "error", category: "", message: "m" },
    reason: DbHostTelemetryRefusalReason.MissingCategory,
  },
  {
    label: "non-string message",
    event: { severity: "error", category: "db-host", message: 42 },
    reason: DbHostTelemetryRefusalReason.MissingMessage,
  },
];

const ROUTABLE_EVENT = {
  severity: "error",
  category: "db-host",
  message: "m",
};

/**
 * The two positive controls the compound assertion below depends on. Without
 * them a fixture whose "routing fault" or "mistyped diagnostics" was not
 * actually faulty would satisfy the ordering test vacuously.
 */
test("each half of the compound fixtures is independently a real fault", () => {
  for (const { label, event, reason } of ROUTING_FAULTS) {
    assert.equal(
      classifyTelemetryEventPayloadRefusal(event),
      reason,
      `${label} alone must be refused as ${reason}`
    );
  }

  for (const diagnostics of [
    MISTYPED_DIAGNOSTICS,
    MISTYPED_DIAGNOSTICS_NUMERIC,
  ]) {
    assert.equal(
      classifyTelemetryEventPayloadRefusal({ ...ROUTABLE_EVENT, diagnostics }),
      DbHostTelemetryRefusalReason.UnknownShape,
      `${JSON.stringify(diagnostics)} alone must be refused as unknown_shape`
    );
  }

  // And the base event really is routable, so neither half is being reported
  // for a fault the fixture carries by accident.
  assert.equal(classifyTelemetryEventPayloadRefusal(ROUTABLE_EVENT), undefined);
});

/**
 * The ordering contract itself: routing fault AND mistyped diagnostics in the
 * SAME event, reported as the routing fault.
 *
 * Moving the diagnostics arm ahead of the severity check — the documented order
 * inverted — turns every one of these into `unknown_shape`.
 */
test("a routing fault outranks a mistyped diagnostics field in the same event", () => {
  for (const diagnostics of [
    MISTYPED_DIAGNOSTICS,
    MISTYPED_DIAGNOSTICS_NUMERIC,
  ]) {
    for (const { label, event, reason } of ROUTING_FAULTS) {
      assert.equal(
        classifyTelemetryEventPayloadRefusal({ ...event, diagnostics }),
        reason,
        `${label} + ${JSON.stringify(diagnostics)} must report ${reason}, not unknown_shape`
      );
    }
  }
});

/**
 * The routing arms are ordered among THEMSELVES too, and that order is equally
 * unpinned: an event missing all three routing fields is one refusal attributed
 * to `invalid_severity`, never three, and never the later two.
 */
test("the first routing fault wins when several are present at once", () => {
  assert.equal(
    classifyTelemetryEventPayloadRefusal({
      severity: "critical",
      category: "",
      message: 42,
      diagnostics: MISTYPED_DIAGNOSTICS,
    }),
    DbHostTelemetryRefusalReason.InvalidSeverity
  );

  assert.equal(
    classifyTelemetryEventPayloadRefusal({
      severity: "error",
      category: "",
      message: 42,
      diagnostics: MISTYPED_DIAGNOSTICS,
    }),
    DbHostTelemetryRefusalReason.MissingCategory
  );

  assert.equal(
    classifyTelemetryEventPayloadRefusal({
      severity: "error",
      category: "db-host",
      message: 42,
      diagnostics: MISTYPED_DIAGNOSTICS,
    }),
    DbHostTelemetryRefusalReason.MissingMessage
  );
});

/**
 * `not_an_object` precedes everything, including the routing arms. A non-object
 * cannot carry a severity to be faulted on, so this is the one arm whose
 * precedence is structural rather than a choice — pinned so a refactor that
 * reorders the guard cannot report a string as `invalid_severity`.
 */
test("a non-object is refused before any field is inspected", () => {
  for (const value of [undefined, null, "a string", 7]) {
    assert.equal(
      classifyTelemetryEventPayloadRefusal(value),
      DbHostTelemetryRefusalReason.NotAnObject,
      String(value)
    );
  }
});
