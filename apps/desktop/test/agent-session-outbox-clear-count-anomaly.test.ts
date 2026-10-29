/**
 * @file agent-session-outbox-clear-count-anomaly.test.ts
 * @description ISS-8179 — a durable outbox clear whose reply carries a
 * `deletedRowCount` that cannot be believed must be DISTINGUISHABLE from a
 * version-skewed peer that carries no count at all.
 *
 * Before this, both collapsed into one `undefined`, so IPC corruption or a
 * producer defect read as ordinary version skew and nothing said otherwise.
 *
 * The whole point is that the two arms are asserted SEPARATELY, and that neither
 * assertion could be satisfied by the other arm's behavior:
 *
 *  - the reader names MALFORMED for a reply that HAS the field, once per shape
 *    the boundary schema rejects (a string, a negative, a non-finite, a
 *    fractional, a `null`, an explicit `undefined`, an integer past the safe
 *    range) — a single-shape test would leave the rest of the branch uncovered;
 *  - the reader names ABSENT for every reply that carries no OWN field at all,
 *    which is every legitimate older peer, and must stay silent;
 *  - the writer emits the MONITORED `sync.outbox_clear_count.invalid` category
 *    on the first arm and emits NOTHING on the second, driven through the real
 *    `Observability` emit path rather than a mocked reporter;
 *  - and both arms still report the clear as COMMITTED with the count OMITTED,
 *    because reporting the anomaly may not change what the ack does.
 *
 * Counterfactual: restoring the collapsing reader (`return parsed.success ?
 * … : undefined` for every failure) fails the malformed reader cases and both
 * writer-emit cases, while the absent cases stay green — which is exactly the
 * distinction the ticket says one assertion must not be able to cover.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { clearOutboxOnAck } from "../src/main/agent-sync/agent-session-outbox-writers.js";
import type { OutboxClearResult } from "../src/main/agent-sync/outbox-clear-result.js";
import {
  OutboxClearCountKind,
  readClearedRowCount,
} from "../src/main/agent-sync/outbox-clear-result.js";
import { Observability } from "../src/main/telemetry/observability.js";
// Imported rather than re-typed: the reporter owns this name, so a rename moves
// the producer and this assertion together instead of leaving the test green
// against a category nothing emits (PR #6089 review, davetho).
import { MALFORMED_OUTBOX_CLEAR_COUNT_CATEGORY as MALFORMED_CATEGORY } from "../src/main/telemetry/sync-outbox-clear-count-telemetry.js";
import { setTelemetryDeliverable } from "../src/main/telemetry/telemetry-delivery-readiness.js";
import { FakeSyncSource } from "./fake-sync-source.js";

const SOURCE_KEY = "agent_sessions:target-iss-8179";

/**
 * Every reply shape that CARRIES a `deletedRowCount` the boundary rejects.
 *
 * Named one by one rather than folded into a single "bad value" case: the four
 * the ticket calls out (a string, a negative, a non-finite, an unsafe integer)
 * fail three different schema clauses, and a reader that only rejected one of
 * them would pass a test that checked only one.
 */
const MALFORMED_REPLIES: ReadonlyArray<readonly [string, unknown]> = [
  ["a string where a number belongs", { deletedRowCount: "2" }],
  ["a negative row count", { deletedRowCount: -1 }],
  ["a NaN", { deletedRowCount: Number.NaN }],
  ["an infinity", { deletedRowCount: Number.POSITIVE_INFINITY }],
  ["a fractional count", { deletedRowCount: 1.5 }],
  ["an integer past the safe range", { deletedRowCount: 2 ** 64 }],
  [
    "the first integer a JS number can no longer name exactly",
    { deletedRowCount: Number.MAX_SAFE_INTEGER + 1 },
  ],
  // Root AGENTS.md: an absent optional cross-process field is OMITTED, never
  // serialized as `null`. A peer that nulls it is therefore a producer defect,
  // not the older peer the ABSENT arm exists for.
  ["an explicit null", { deletedRowCount: null }],
  // Same footing as the `null` above, and the case that separates own-property
  // presence from a schema check: structured clone PRESERVES an explicitly-
  // `undefined` key, and a peer predating the field cannot name it at all, so a
  // reply carrying the key with no value is a producer that knows the field and
  // failed to compute it. Reading this as skew is the collapse in miniature —
  // it is the one shape a Zod probe cannot tell from an omitted key.
  [
    "the field present and explicitly undefined",
    { deletedRowCount: undefined },
  ],
];

/**
 * Every reply that carries no `deletedRowCount` at all. All of these are answers
 * a db-host peer predating ISS-7957 can legitimately give, so all of them must
 * degrade in silence — the cross-repo rule that a peer being older may never
 * raise an alarm.
 */
const ABSENT_REPLIES: ReadonlyArray<readonly [string, unknown]> = [
  ["the pre-ISS-7957 reply", undefined],
  ["a null reply", null],
  ["an object without the field", {}],
  ["a non-object reply", "2"],
  ["a bare number reply", 2],
  ["an array reply", []],
];

/**
 * A db-host peer whose reply is whatever the test hands it.
 *
 * The `as` is the subject, not a shortcut: `clearOutboxEntries` is the FEA-2038
 * forwarding Proxy, whose reply is delivered verbatim with no validation behind
 * a single main-process cast. The static type is an assertion about the peer, so
 * malformed input is reachable at runtime however firmly `tsc` forbids it here.
 */
class ScriptedClearSource extends FakeSyncSource {
  private readonly reply: unknown;

  constructor(reply: unknown) {
    super([]);
    this.reply = reply;
  }

  // ISS-8116 widened the base to the interface's own `| Promise<…>` union, so
  // the super call is awaited here; the fake's body is still synchronous.
  override async clearOutboxEntries(
    sourceKey: string,
    ids: string[]
  ): Promise<OutboxClearResult | undefined> {
    await super.clearOutboxEntries(sourceKey, ids);
    return this.reply as OutboxClearResult;
  }
}

/**
 * READER, MALFORMED ARM — one case per rejected shape.
 */
test("ISS-8179: the boundary names MALFORMED for a reply that carries an unbelievable count", () => {
  for (const [label, reply] of MALFORMED_REPLIES) {
    assert.equal(
      readClearedRowCount(reply).kind,
      OutboxClearCountKind.Malformed,
      `${label} is a present-but-unbelievable count and must not read as an older peer`
    );
  }
});

/**
 * READER, ABSENT ARM — the population that must stay silent.
 *
 * Paired with the arm above on purpose: a reader that answered MALFORMED for
 * everything it could not parse would pass that test and fail this one, which is
 * the collapse in the opposite direction.
 */
test("ISS-8179: the boundary names ABSENT for a reply that carries no count at all", () => {
  for (const [label, reply] of ABSENT_REPLIES) {
    assert.equal(
      readClearedRowCount(reply).kind,
      OutboxClearCountKind.Absent,
      `${label} is version skew and must degrade silently`
    );
  }
});

/**
 * READER, MEASURED ARM — the allow sibling. Without it, both refusals above are
 * satisfied by a reader that never believes anything.
 */
test("ISS-8179: the boundary still names MEASURED for a believable count", () => {
  for (const count of [0, 1, Number.MAX_SAFE_INTEGER]) {
    const reading = readClearedRowCount({ deletedRowCount: count });
    assert.equal(
      reading.kind,
      OutboxClearCountKind.Measured,
      `${count} is a believable row count`
    );
    assert.equal(
      reading.kind === OutboxClearCountKind.Measured
        ? reading.deletedRowCount
        : undefined,
      count,
      "and the number it carries is the one the delegate reported"
    );
  }
});

/**
 * WRITER, MALFORMED ARM — the monitored diagnostic, through the REAL emit path.
 *
 * `Observability.init` installs the test's own sink as the transport, so this
 * drives `clearOutboxOnAck` → `reportMalformedOutboxClearCount` →
 * `Observability.getTelemetryEmitter().emit` → the wire event, rather than
 * asserting that a mocked reporter was called.
 */
test("ISS-8179: a malformed clear reply reaches the monitored diagnostic", async () => {
  for (const [label, reply] of MALFORMED_REPLIES) {
    const events = await captureTelemetry(async () => {
      const verdict = await clearOutboxOnAck(
        { sourceKey: SOURCE_KEY, source: new ScriptedClearSource(reply) },
        ["s1", "s2"]
      );
      assert.equal(
        verdict.cleared,
        true,
        `${label}: the delete COMMITTED, so the ack must still be reported cleared`
      );
      assert.ok(
        !Object.hasOwn(verdict, "deletedRowCount"),
        `${label}: the count is still omitted rather than fabricated`
      );
    });
    assert.deepEqual(
      events.map((event) => event.category),
      [MALFORMED_CATEGORY],
      `${label}: must raise exactly one monitored diagnostic`
    );
    assert.equal(
      events[0]?.severity,
      "error",
      `${label}: reported at error severity, the field a monitor queries`
    );
  }
});

/**
 * WRITER, ABSENT ARM — silence.
 *
 * This is the half the collapse used to make impossible to state, and it is a
 * cross-repo requirement rather than a preference: an older db-host peer is
 * expected, not broken, and must never page anyone.
 */
test("ISS-8179: a version-skewed clear reply raises no diagnostic at all", async () => {
  for (const [label, reply] of ABSENT_REPLIES) {
    const events = await captureTelemetry(async () => {
      const verdict = await clearOutboxOnAck(
        { sourceKey: SOURCE_KEY, source: new ScriptedClearSource(reply) },
        ["s1", "s2"]
      );
      assert.equal(verdict.cleared, true, `${label}: the ack still proceeds`);
      assert.ok(
        !Object.hasOwn(verdict, "deletedRowCount"),
        `${label}: and reports no count, exactly as before`
      );
    });
    assert.deepEqual(
      events,
      [],
      `${label}: an older peer must not raise an alert`
    );
  }
});

/**
 * WRITER, MEASURED ARM — a healthy clear is silent AND reports its count.
 *
 * Without this the malformed-arm test above is satisfied by a writer that emits
 * on every clear, and the absent-arm test by one that never emits.
 */
test("ISS-8179: a believable clear reply reports its count and raises nothing", async () => {
  const source = new FakeSyncSource([]);
  source.seedOutbox(SOURCE_KEY, "s1");
  source.seedOutbox(SOURCE_KEY, "s2");
  let verdict: Awaited<ReturnType<typeof clearOutboxOnAck>> | undefined;
  const events = await captureTelemetry(async () => {
    verdict = await clearOutboxOnAck({ sourceKey: SOURCE_KEY, source }, [
      "s1",
      "s2",
    ]);
  });
  assert.equal(verdict?.deletedRowCount, 2, "the measured count still travels");
  assert.deepEqual(events, [], "and a healthy clear raises no diagnostic");
});

/**
 * CADENCE — at most one report per process.
 *
 * The condition is a STATE (a peer build whose reply is wrong), acks are
 * frequent, and a per-occurrence emit would flood the relay for one defect. This
 * is the ONLY case here that lets the reporter latch, so it runs last: every
 * case above holds the send gate closed, which is precisely what stops a report
 * raised while the lane is down from burning the single report this process
 * would ever make.
 */
test("ISS-8179: the diagnostic latches to one report per process", async () => {
  const events = await captureTelemetry(async () => {
    for (const _attempt of [1, 2]) {
      await clearOutboxOnAck(
        {
          sourceKey: SOURCE_KEY,
          source: new ScriptedClearSource({ deletedRowCount: "2" }),
        },
        ["s1"]
      );
    }
  }, true);
  assert.deepEqual(
    events.map((event) => event.category),
    [MALFORMED_CATEGORY],
    "two malformed clears in one process must raise one alert, not two"
  );
});

/**
 * Run `body` with the desktop telemetry transport pointed at a local array, and
 * return every event it emitted.
 *
 * `deliverable` is the lane's send gate. It is held CLOSED by default so the
 * reporter's once-per-process latch never sets and each case above is
 * independent of the ones before it — the emit itself happens either way,
 * because the latch is gated on acceptance and not on the attempt.
 */
async function captureTelemetry(
  body: () => Promise<void>,
  deliverable = false
): Promise<Array<{ category: string; severity: string }>> {
  const events: Array<{ category: string; severity: string }> = [];
  Observability.init({
    telemetrySend: (event) =>
      events.push({ category: event.category, severity: event.severity }),
  });
  setTelemetryDeliverable(() => deliverable);
  try {
    await body();
  } finally {
    setTelemetryDeliverable(null);
    Observability.initNoOp();
  }
  return events;
}
