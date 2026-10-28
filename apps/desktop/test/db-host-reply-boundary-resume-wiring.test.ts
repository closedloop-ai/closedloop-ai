/**
 * @file db-host-reply-boundary-resume-wiring.test.ts
 * @description ISS-8135 — the SERVICE call site, driven end to end.
 *
 * `db-host-reply-boundary-work-selection.test.ts` covers the readers and the
 * disposition functions that consume them. Neither reaches the two lines in the
 * grandfathered `agent-session-sync-service.ts` that hand the raw reply through,
 * and those lines are exactly where the flattening lived: a `?? []` between the
 * db host and the boundary reader converts "the peer answered a shape this build
 * cannot read" into "the outbox is empty", which is a positive claim that
 * COMPLETES a read the lane performs at most once per identity.
 *
 * So this drives the real `AgentSessionSyncService` with a source whose first
 * resume read answers `null`, and asserts the un-acked row still reaches the
 * cloud on a later pass. Written at the service so re-introducing the `??` fails
 * a named test rather than passing every unit around it.
 *
 * Started with `historicalBackfill: false` deliberately: that is the
 * configuration in which the resume read is the ONLY door back to the row —
 * `reconcilePendingOutboxIfIdle` is gated on the same flag — so the assertion
 * measures the resume path rather than a rescue by a sibling loop.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import type { AgentSessionSyncBatch } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import {
  DB_HOST_REPLY_REJECTED_CATEGORY,
  resetDbHostReplyRejectionThrottle,
} from "../src/main/telemetry/db-host-reply-rejection.js";
import type { TelemetryEventPayload } from "../src/main/telemetry/telemetry-protocol.js";
import { DbHostRejectedReplyOp } from "../src/main/telemetry/telemetry-protocol.js";
import {
  armTelemetry,
  makeAcceptingService as makeService,
  sentIds,
  settle,
} from "./agent-session-sync-service-fixture.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const COMPUTE_TARGET = "resume-boundary-target";
/** The identity the service actually resolves for `COMPUTE_TARGET`. */
const SOURCE_KEY = buildAgentSessionSyncSourceKey(COMPUTE_TARGET);
const UNACKED_ID = "unacked-1";
const TOP_UPDATED_AT = "2026-07-20T00:00:00.000Z";

// The monitored rejection facet is throttled per op by module-level state, so a
// second case asserting the same op would otherwise read the first case's claim.
beforeEach(() => {
  resetDbHostReplyRejectionThrottle();
});

/**
 * Decide what the db host answers for the Nth pending-outbox read of a run.
 *
 * `readIndex` is 1-based and `real` produces the healthy reply, so a script can
 * put the skew on whichever read the case is about without the two cases below
 * needing two near-identical fixtures.
 */
type OutboxReadScript = (
  readIndex: number,
  real: () => string[] | Promise<string[]>
) => unknown;

/**
 * A source whose durable pending-outbox read follows a script. Counts the reads,
 * so a test can prove the resume was actually re-attempted rather than merely
 * succeeding on a first call it never made.
 */
class ScriptedOutboxSource extends FakeSyncSource {
  reads = 0;
  script: OutboxReadScript = (_readIndex, real) => real();

  override loadPendingOutboxIds(
    sourceKey: string
  ): string[] | Promise<string[]> {
    this.reads += 1;
    // The cast is the point of the fixture, not a shortcut around it: the static
    // type says this must be a `string[]`, and the db-host boundary is exactly
    // where that stops being true.
    return this.script(this.reads, () =>
      super.loadPendingOutboxIds(sourceKey)
    ) as string[];
  }
}

/** A source scripted to answer `reply` on read `onRead`, healthily otherwise. */
function scriptedSource(onRead: number, reply: unknown): ScriptedOutboxSource {
  const source = new ScriptedOutboxSource([
    makeSyncedSession(UNACKED_ID, TOP_UPDATED_AT),
  ]);
  source.script = (readIndex, real) => (readIndex === onRead ? reply : real());
  return source;
}

function makeAcceptingService(
  source: FakeSyncSource,
  sent: AgentSessionSyncBatch[]
): AgentSessionSyncService {
  return makeService(source, sent, COMPUTE_TARGET);
}

/**
 * Seed the state a kill-then-restart leaves behind: a persisted cursor whose
 * watermark already covers the session (so no full walk and no incremental scan
 * will re-select it), plus a still-`pending` outbox row for it. The resume read
 * is the only thing that can put it back on a queue.
 */
async function seedUnackedPrefix(source: FakeSyncSource): Promise<void> {
  source.advanceSyncState(SOURCE_KEY, {
    observedTopUpdatedAt: TOP_UPDATED_AT,
    observedIdsAtTopUpdatedAt: [UNACKED_ID],
    deadLetteredIds: [],
  });
  // ISS-8116 widened this write to the source contract's own `void |
  // Promise<void>` so a subclass can defer it. Awaited, not voided: the seed must
  // be COMMITTED before `service.start()` — the premise of the whole fixture is
  // the durable state a kill-then-restart left behind.
  await source.enqueueOutboxEntries(SOURCE_KEY, [
    { externalSessionId: UNACKED_ID, syncClass: "backfill" },
  ]);
}

test("resume wiring: an unreadable first reply re-arms the resume, and the un-acked row still reaches the cloud", async () => {
  // The skew lands on read 1 — the once-per-identity resume read.
  const source = scriptedSource(1, null);
  await seedUnackedPrefix(source);
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeAcceptingService(source, sent);

  service.start({ historicalBackfill: false });
  await settle(service);
  // The first resume read answered `null`. Flattened to `[]` it would have read
  // as "nothing is owed", completed the once-per-identity read, and left this
  // row unreachable for the life of the process.
  assert.equal(source.reads, 1, "the resume read ran");
  assert.deepEqual(
    sentIds(sent),
    [],
    "nothing was sent off an unreadable read"
  );

  service.refresh();
  await settle(service);
  service.refresh();
  await settle(service);

  assert.ok(
    source.reads >= 2,
    "the identity was re-armed and the read retried"
  );
  assert.deepEqual(
    sentIds(sent),
    [UNACKED_ID],
    "the un-acked prefix reached the cloud once the peer answered a readable shape"
  );
  service.stop();
});

let restoreTelemetry: (() => void) | null = null;
afterEach(() => {
  restoreTelemetry?.();
  restoreTelemetry = null;
});

/** Arm the telemetry lane for one case, restored unconditionally in `afterEach`. */
function captureTelemetry(): TelemetryEventPayload[] {
  const armed = armTelemetry();
  restoreTelemetry = armed.restore;
  return armed.events;
}

test("idle-reconcile wiring: an unreadable reply on the idle tick is COUNTED, not flattened into an empty outbox", async () => {
  // The idle door re-reads every tick, so an unreadable reply and an empty one
  // converge on the same behaviour here — nothing is reconciled either way.
  // What does NOT converge is whether the version skew is observable: flattening
  // the reply before the boundary hands the reader a perfectly good `[]`, and
  // the degradation becomes indistinguishable from a healthy caught-up device.
  const sink = captureTelemetry();
  // Read 1 is the healthy resume; the skew lands on read 2, the idle tick.
  const source = scriptedSource(2, null);
  await seedUnackedPrefix(source);
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeAcceptingService(source, sent);

  service.start();
  await settle(service);
  service.refresh();
  await settle(service);
  service.refresh();
  await settle(service);

  assert.deepEqual(
    sentIds(sent),
    [UNACKED_ID],
    "the healthy resume read still delivered the un-acked row"
  );
  assert.ok(source.reads >= 2, "the idle tick re-read the outbox");
  const rejected = sink
    .filter((event) => event.category === DB_HOST_REPLY_REJECTED_CATEGORY)
    .map((event) => event.diagnostics?.dbHostReplyRejected?.op);
  assert.ok(
    rejected.includes(DbHostRejectedReplyOp.LoadPendingOutboxIds),
    "the idle tick's unreadable reply reached the monitored path"
  );
  service.stop();
});

test("resume wiring: a readable first reply hydrates on the first pass (positive sibling)", async () => {
  // The sibling that stops the case above passing by simply never hydrating: a
  // healthy peer must complete the resume on its first read, not re-arm forever.
  // No skew on any read — `scriptedSource(0, …)` can never match a 1-based index.
  const source = scriptedSource(0, null);
  await seedUnackedPrefix(source);
  const sent: AgentSessionSyncBatch[] = [];
  const service = makeAcceptingService(source, sent);

  service.start({ historicalBackfill: false });
  await settle(service);

  assert.equal(source.reads, 1, "one read was enough");
  assert.deepEqual(sentIds(sent), [UNACKED_ID]);
  service.stop();
});
