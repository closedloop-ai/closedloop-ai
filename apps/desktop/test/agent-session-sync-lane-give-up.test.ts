/**
 * @file agent-session-sync-lane-give-up.test.ts
 * @description ISS-9418 and PLN-2028 (ISS-10053, ISS-9963, ISS-10043) coverage
 * for the SESSION lane's durable lane RUN, driven through the real
 * `AgentSessionSyncService` and its durable outbox.
 *
 * The session lane's shape differs from the component sweep's in the one way
 * that matters here: its ceiling is crossed per ROW, and it has TWO give-up
 * producers rather than one. `lane_stalled_since` on the outbox row is per-row,
 * so through a long outage the rows added at different times run out at
 * different real instants and each dead-letter fold stamps from its own
 * `Date.now()`. That is what makes these cases independent of everything
 * `lane-give-up.test.ts` already covers on the gate-backed lane:
 *
 *  1. the stamp must be ANCHORED to the first give-up, or the column slides
 *     forward for as long as the outage lasts and never means what it says;
 *  2. the clear is owed on a VERIFIED ACK, not only on the row-attributable
 *     rejection the fold path happens to sit on — a corpus that recovers the
 *     normal way may never reject another row;
 *  3. the RUN ORIGIN has to outlive the process, or an install that keeps
 *     restarting inside an outage never accumulates 24h of anything (ISS-10053);
 *  4. WHICH producer wrote a stamp decides whether a relaunch may resume it as a
 *     lane-wide hold, and the policy that says so had no production consumer
 *     until M4 (ISS-10043).
 *
 * The give-up cases do not assert "the next tick is quiet" for the ROW-CEILING
 * producer: for it the terminal path is the recoverable per-row dead-letter,
 * which is unchanged, so the record is the only observable. The GATE producer is
 * lane-wide and the held tick IS observable, which is what the relaunch pair
 * below turns on.
 */
import assert from "node:assert/strict";
import {
  LaneGiveUpSource,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { test } from "vitest";
import { createOutboxWriters } from "../src/main/agent-sync/agent-session-outbox-writers.js";
import { SESSION_LANE_STALL_CEILING_MS } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { LaneEnvironmentalDeferGate } from "../src/main/sync/lane-environmental-defer.js";
import {
  flushAgentSessionSync,
  makeServiceWithIdentity,
  runWithMockedNow,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.parse("2026-08-03T12:00:00.000Z");
const UPDATED_AT = "2026-06-08T12:00:00.000Z";
/**
 * Four launches of seven hours each: a 28h outage in which no single process is
 * up for the 24h ceiling. That is the ISS-10053 install — the one that restarts
 * inside the outage — and the only thing that can carry the run across the gaps
 * is the persisted origin.
 */
const RELAUNCH_COUNT = 4;
const PROCESS_UPTIME_MS = 7 * HOUR_MS;

test("ISS-9418: the session lane anchors its give-up stamp to the FIRST give-up, not to the latest dead-letter fold", async () => {
  const TARGET = "target-give-up-anchor";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([makeSyncedSession("early", UPDATED_AT)]);
  const outboxRowFor = (id: string) =>
    [...source.outbox.values()].find((r) => r.sourceKey === key && r.id === id);
  const service = makeServiceWithIdentity(
    source,
    () =>
      Promise.resolve({
        accepted: false as const,
        reason: DesktopAgentSessionsAckReason.IngestionFailed,
      }),
    TARGET
  );

  try {
    await runWithMockedNow(async ({ advance }) => {
      service.start();
      await flushAgentSessionSync();

      // The first row crosses the 24h ceiling. The lane gave up HERE.
      advance(SESSION_LANE_STALL_CEILING_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
      const laneGaveUpAt = new Date(
        NOW_MS + SESSION_LANE_STALL_CEILING_MS + 1
      ).toISOString();
      if (outboxRowFor("early")?.status !== "dead_lettered") {
        throw new Error(
          "fixture: the first row must reach its per-row terminal path here"
        );
      }
      assert.deepEqual(
        source.laneRunWrites.at(-1),
        {
          sourceKey: key,
          run: {
            // No lane-wide run is open: this lane's ceiling is crossed per ROW,
            // and the gate never failed. The origin stays NULL rather than being
            // borrowed from the row that expired.
            laneStalledSince: null,
            laneGaveUpAt,
            // PLN-2028 (ISS-9963, ISS-10043): the fold's own cause, and the
            // producer that makes this a per-row ceiling rather than a lane-wide
            // give-up a relaunch would resume as a hold.
            laneGaveUpReason: SyncReason.IngestionFailed,
            laneGaveUpSource: LaneGiveUpSource.RowCeiling,
          },
        },
        "the first row across the ceiling stamps the lane-level give-up"
      );
      const writesAtFirstGiveUp = source.laneRunWrites.length;

      // A session collected LATER opens its own stall clock inside the same
      // outage, and crosses its own ceiling a day after the first one did. The
      // staggered origin is the defect's entire mechanism — this second fold
      // knows only its own `Date.now()`, so an unanchored write re-stamps here.
      source.upsert(makeSyncedSession("late", "2026-06-08T13:00:00.000Z"));
      advance(HOUR_MS);
      service.refresh();
      await flushAgentSessionSync();
      const lateStall = outboxRowFor("late")?.laneStalledSince;
      if (lateStall !== new Date(Date.now()).toISOString()) {
        throw new Error(
          `fixture: the second row must open its own stall clock now, got ${lateStall}`
        );
      }

      advance(SESSION_LANE_STALL_CEILING_MS + 1);
      service.refresh();
      await flushAgentSessionSync();
      if (outboxRowFor("late")?.status !== "dead_lettered") {
        throw new Error("fixture: the second fold must really have happened");
      }
      assert.equal(
        source.laneRunWrites.length,
        writesAtFirstGiveUp,
        "and it wrote NOTHING: the give-up is still anchored to the first one"
      );
      assert.equal(
        source.persistedSyncState(key)?.laneGaveUpAt,
        laneGaveUpAt,
        "so the column an operator reads still names when the lane gave up"
      );
    }, NOW_MS);
  } finally {
    service.stop();
  }
});

test("ISS-9418: a VERIFIED ACK clears the session lane's durable give-up", async () => {
  // The recovery a healthy corpus actually takes. Before this the only clear sat
  // on the row-attributable rejection path, so a lane that started being accepted
  // again kept `lane_gave_up_at` set indefinitely — a recovered lane frozen in a
  // terminal state, on a column whose own contract says NULL is "has not given
  // up".
  const TARGET = "target-give-up-clear";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const gaveUpAt = new Date(
    NOW_MS - SESSION_LANE_STALL_CEILING_MS
  ).toISOString();
  const source = new FakeSyncSource([
    makeSyncedSession("recovered", UPDATED_AT),
  ]);
  source.seedSyncState(key, {
    observedTopUpdatedAt: null,
    observedIdsAtTopUpdatedAt: [],
    laneStalledSince: new Date(
      NOW_MS - 2 * SESSION_LANE_STALL_CEILING_MS
    ).toISOString(),
    laneGaveUpAt: gaveUpAt,
    laneGaveUpReason: SyncReason.Unauthenticated,
    laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
  });
  const service = makeServiceWithIdentity(
    source,
    () => Promise.resolve({ accepted: true as const }),
    TARGET
  );

  try {
    await runWithMockedNow(async () => {
      service.start();
      await flushAgentSessionSync();
    }, NOW_MS);
  } finally {
    service.stop();
  }

  assert.deepEqual(
    source.laneRunWrites,
    [
      {
        sourceKey: key,
        run: {
          // PLN-2028: all FOUR columns, in one write. A clear that nulled only
          // the stamp would leave the previous outage's origin on the row, so
          // the next failure would open against a run that ended weeks ago and
          // give up on its first attempt.
          laneStalledSince: null,
          laneGaveUpAt: null,
          laneGaveUpReason: null,
          laneGaveUpSource: null,
        },
      },
    ],
    "the accepted batch clears the whole record, exactly once"
  );
  assert.equal(
    source.persistedSyncState(key)?.laneGaveUpAt,
    undefined,
    "and the column is genuinely NULL again, not merely written"
  );
});

test("ISS-9418: a lane that never gave up pays no give-up write at all", async () => {
  // The counterweight to the case above, and the reason hydration adopts an
  // ABSENT stamp as "nothing on record". Without that belief the first accepted
  // batch of every boot would write a NULL over a column that is already NULL,
  // on the same single-connection queue every other lane's writes serialize
  // behind.
  const TARGET = "target-give-up-healthy";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([makeSyncedSession("healthy", UPDATED_AT)]);
  source.seedSyncState(key, {
    observedTopUpdatedAt: null,
    observedIdsAtTopUpdatedAt: [],
  });
  const service = makeServiceWithIdentity(
    source,
    () => Promise.resolve({ accepted: true as const }),
    TARGET
  );

  try {
    await runWithMockedNow(async () => {
      service.start();
      await flushAgentSessionSync();
      service.refresh();
      await flushAgentSessionSync();
    }, NOW_MS);
  } finally {
    service.stop();
  }

  assert.deepEqual(source.laneRunWrites, []);
});

/**
 * Drive one outage across {@link RELAUNCH_COUNT} processes against one store.
 *
 * A fresh `AgentSessionSyncService` per launch is the whole point: everything the
 * gate holds dies with each one, so anything the fourth process knows about the
 * first three came off the `sync_state` row.
 */
async function outageAcrossRelaunches(
  source: FakeSyncSource,
  target: string
): Promise<void> {
  await runWithMockedNow(async ({ advance }) => {
    for (let launch = 0; launch < RELAUNCH_COUNT; launch += 1) {
      const service = makeServiceWithIdentity(
        source,
        () =>
          Promise.resolve({
            accepted: false as const,
            reason: DesktopAgentSessionsAckReason.Unauthenticated,
          }),
        target
      );
      try {
        service.start();
        await flushAgentSessionSync();
        advance(PROCESS_UPTIME_MS);
        service.refresh();
        await flushAgentSessionSync();
      } finally {
        service.stop();
      }
    }
  }, NOW_MS);
}

/**
 * The session lane exactly as it wrote before PLN-2028 M4: the give-up stamp and
 * nothing else.
 *
 * The discriminator for the case below, and a faithful one rather than a stub
 * that answers whatever is asked — it drops the one column M4 added and keeps
 * every other behaviour of the real store, including its refusal of an invalid
 * value. Without it the acceptance case would be indistinguishable from a lane
 * that gave up because 28h happened to pass, rather than because the origin was
 * restored four times.
 */
class StampOnlySyncSource extends FakeSyncSource {
  override recordLaneRun(
    sourceKey: string,
    run: Parameters<FakeSyncSource["recordLaneRun"]>[1]
  ): void {
    super.recordLaneRun(sourceKey, { ...run, laneStalledSince: null });
  }
}

test("ISS-10053: an outage spanning four relaunches reaches the 24h ceiling that no single process saw", async () => {
  // The invariant-5 violation this ticket exists to close. The environmental
  // gate's run lived only in memory, so a desktop restarting inside a long
  // outage opened a fresh 24h run on every launch and the terminal path was not
  // merely delayed but UNREACHABLE.
  const TARGET = "target-relaunch-ceiling";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([
    makeSyncedSession("stranded", UPDATED_AT),
  ]);

  await outageAcrossRelaunches(source, TARGET);

  const persisted = source.persistedSyncState(key);
  assert.equal(
    persisted?.laneGaveUpAt,
    new Date(NOW_MS + RELAUNCH_COUNT * PROCESS_UPTIME_MS).toISOString(),
    "the fourth process gives up, on an outage no single process was up for"
  );
  assert.equal(
    persisted?.laneGaveUpSource,
    LaneGiveUpSource.EnvironmentalGate,
    "and it is the LANE gate's give-up, so a later relaunch resumes it as a hold"
  );
  assert.equal(
    persisted?.laneStalledSince,
    new Date(NOW_MS).toISOString(),
    "still anchored to the outage's first failure, four processes back"
  );
});

test("ISS-10053: the SAME outage reaches no ceiling at all when the origin does not survive the relaunch", async () => {
  // The discriminator, and the reason the case above is not simply "28h passed".
  // Early in a run the pacing ladder produces the same quiet tick a give-up does
  // (PLN-1961), so without this the acceptance case would pass against a lane
  // that never terminated.
  const TARGET = "target-relaunch-no-origin";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new StampOnlySyncSource([
    makeSyncedSession("stranded", UPDATED_AT),
  ]);

  await outageAcrossRelaunches(source, TARGET);

  assert.equal(
    source.persistedSyncState(key)?.laneGaveUpAt,
    undefined,
    "every launch opens a fresh run, so 28h of outage terminates nothing"
  );
});

test("ISS-10043: a relaunch resumes a GATE give-up as a hold and a ROW-CEILING one as nothing", async () => {
  // The half of ISS-10043 that had no production consumer before M4: the policy
  // says a session row-ceiling stamp is not lane-wide, and nothing read it. The
  // bounce is the relaunch holding the WHOLE lane for a ceiling that only ever
  // applied to the rows whose own budgets ran out — so the lane stops collecting
  // for every other session too, for a cause that was never lane-wide.
  //
  // Both seeds are one minute old, which is inside the give-up's opening re-arm
  // window, so a resumed hold is the only thing that can keep the lane quiet.
  const attemptsBySource = new Map<string, number>();
  const seeds = [
    {
      target: "target-resume-gate",
      source: LaneGiveUpSource.EnvironmentalGate,
    },
    { target: "target-resume-ceiling", source: LaneGiveUpSource.RowCeiling },
  ] as const;

  for (const seed of seeds) {
    const source = new FakeSyncSource([
      makeSyncedSession("queued", UPDATED_AT),
    ]);
    source.seedSyncState(buildAgentSessionSyncSourceKey(seed.target), {
      observedTopUpdatedAt: null,
      observedIdsAtTopUpdatedAt: [],
      laneStalledSince: new Date(
        NOW_MS - SESSION_LANE_STALL_CEILING_MS
      ).toISOString(),
      laneGaveUpAt: new Date(NOW_MS - 60_000).toISOString(),
      laneGaveUpReason: SyncReason.Unauthenticated,
      laneGaveUpSource: seed.source,
    });
    let attempts = 0;
    const service = makeServiceWithIdentity(
      source,
      () => {
        attempts += 1;
        return Promise.resolve({ accepted: true as const });
      },
      seed.target
    );
    try {
      await runWithMockedNow(async () => {
        service.start();
        await flushAgentSessionSync();
      }, NOW_MS);
    } finally {
      service.stop();
    }
    attemptsBySource.set(seed.source, attempts);
  }

  assert.equal(
    attemptsBySource.get(LaneGiveUpSource.EnvironmentalGate),
    0,
    "a lane-wide give-up is resumed, so the relaunch sends nothing inside its re-arm window"
  );
  assert.equal(
    attemptsBySource.get(LaneGiveUpSource.RowCeiling),
    1,
    "but a per-row ceiling is not lane-wide, so the relaunch keeps collecting"
  );
});

/**
 * Let the tracker's serialized write chain drain (PLN-2028 D5).
 *
 * Only a tracker's FIRST write reaches the store synchronously; every later one
 * is queued behind the in-flight promise, which is what stops a clear racing the
 * give-up it replaces. So a case that issues two writes has to yield between
 * them or it reads the row before the second one exists.
 */
function settleLaneRunWrites(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

test("ISS-10043: a GATE give-up supersedes a row-ceiling stamp, and a later ceiling cannot demote it", async () => {
  // One give-up per (lane, target) and two producers writing it, so precedence
  // has to be decided rather than left to whichever fold ran last. The gate's
  // claim is strictly the stronger one — the WORLD was broken for this lane —
  // and it is the only one a relaunch may resume as a hold, so a staggered
  // per-row fold arriving afterwards must not overwrite it with its own.
  const TARGET = "target-producer-precedence";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([]);
  const writers = createOutboxWriters(() => ({ sourceKey: key, source }));
  const gate = new LaneEnvironmentalDeferGate();
  writers.laneRun.adopt(gate, {}, NOW_MS);

  writers.laneRun.noteEnvironmentalOutcome(
    gate,
    gate.noteEnvironmentalFailure(NOW_MS),
    SyncReason.Unauthenticated
  );
  writers.laneRun.noteRowCeilingGiveUp(
    gate,
    NOW_MS + HOUR_MS,
    SyncReason.IngestionFailed
  );
  await settleLaneRunWrites();
  assert.equal(
    source.persistedSyncState(key)?.laneGaveUpSource,
    LaneGiveUpSource.RowCeiling,
    "the row ceiling fires first and records itself, because nothing else had"
  );

  const gaveUpAtMs = NOW_MS + SESSION_LANE_STALL_CEILING_MS + 1;
  writers.laneRun.noteEnvironmentalOutcome(
    gate,
    gate.noteEnvironmentalFailure(gaveUpAtMs),
    SyncReason.Unauthenticated
  );
  await settleLaneRunWrites();
  assert.deepEqual(
    {
      laneGaveUpAt: source.persistedSyncState(key)?.laneGaveUpAt,
      laneGaveUpSource: source.persistedSyncState(key)?.laneGaveUpSource,
      laneGaveUpReason: source.persistedSyncState(key)?.laneGaveUpReason,
    },
    {
      laneGaveUpAt: new Date(gaveUpAtMs).toISOString(),
      laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
      laneGaveUpReason: SyncReason.Unauthenticated,
    },
    "and the gate's own give-up replaces it, instant, producer and cause together"
  );

  const writesBeforeLateFold = source.laneRunWrites.length;
  writers.laneRun.noteRowCeilingGiveUp(
    gate,
    gaveUpAtMs + HOUR_MS,
    SyncReason.IngestionFailed
  );
  await settleLaneRunWrites();
  assert.equal(
    source.laneRunWrites.length,
    writesBeforeLateFold,
    "a staggered fold an hour later writes NOTHING: it cannot demote a lane-wide give-up"
  );
});

/**
 * A store whose lane-run write and its one re-attempt both fail, as a db host
 * restarting under the lane does.
 */
class DroppedFirstWriteSyncSource extends FakeSyncSource {
  private dropsLeft = 2;
  override recordLaneRun(
    sourceKey: string,
    run: Parameters<FakeSyncSource["recordLaneRun"]>[1]
  ): void {
    if (this.dropsLeft > 0) {
      this.dropsLeft -= 1;
      throw new Error("db host restarting");
    }
    super.recordLaneRun(sourceKey, run);
  }
}

test("ISS-10053: a dropped row-ceiling write is re-issued by the next staggered fold", async () => {
  // `LaneRunRecord` forgets a believed value whose write failed precisely so the
  // next reconcile re-sends it, and on this lane the later per-row folds are the
  // only reconcile a give-up gets again — the gate path is reached by a different
  // ack class entirely, which a pure `ingestion_failed` outage never takes.
  // Returning at the anchor guard without one left the column empty for the rest
  // of the outage, so the relaunch this ticket exists for had nothing to resume.
  const TARGET = "target-dropped-ceiling-write";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new DroppedFirstWriteSyncSource([]);
  const writers = createOutboxWriters(() => ({ sourceKey: key, source }));
  const gate = new LaneEnvironmentalDeferGate();
  writers.laneRun.adopt(gate, {}, NOW_MS);

  writers.laneRun.noteRowCeilingGiveUp(
    gate,
    NOW_MS,
    SyncReason.IngestionFailed
  );
  await settleLaneRunWrites();
  assert.equal(
    source.persistedSyncState(key)?.laneGaveUpAt,
    undefined,
    "the write and its re-attempt are both dropped, so nothing reached the row"
  );

  writers.laneRun.noteRowCeilingGiveUp(
    gate,
    NOW_MS + HOUR_MS,
    SyncReason.IngestionFailed
  );
  await settleLaneRunWrites();
  assert.deepEqual(
    {
      laneGaveUpAt: source.persistedSyncState(key)?.laneGaveUpAt,
      laneGaveUpSource: source.persistedSyncState(key)?.laneGaveUpSource,
    },
    {
      laneGaveUpAt: new Date(NOW_MS).toISOString(),
      laneGaveUpSource: LaneGiveUpSource.RowCeiling,
    },
    "the later fold re-issues the ANCHORED instant, not the one it noticed"
  );
});

test("ISS-10053: a REFUSED hydration cannot move the row's run origin forward or erase its give-up", async () => {
  // tamsinb review. D4 keeps the ROW's give-up out of live state, and the very
  // next reconcile then wrote the live run over the row anyway: a 30h origin
  // replaced by one a minute old, and a terminal gate give-up nulled, by a
  // process that neither gave up itself nor saw the lane answer. That is this
  // ticket's own defect written back to disk — and the row is the only thing the
  // next launch has, so it is the durable half of the bug, not a cosmetic one.
  const TARGET = "target-refused-hydration-evidence";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const seeded = {
    laneStalledSince: new Date(NOW_MS - 30 * HOUR_MS).toISOString(),
    laneGaveUpAt: new Date(NOW_MS - 6 * HOUR_MS).toISOString(),
    laneGaveUpReason: SyncReason.Unauthenticated,
    laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
  };
  const source = new FakeSyncSource([]);
  source.seedSyncState(key, {
    observedTopUpdatedAt: null,
    observedIdsAtTopUpdatedAt: [],
    ...seeded,
  });
  const writers = createOutboxWriters(() => ({ sourceKey: key, source }));
  const gate = new LaneEnvironmentalDeferGate();

  // This process saw its own outage open first, so the gate is holding a run and
  // refuses the record (D4).
  writers.laneRun.noteEnvironmentalOutcome(
    gate,
    gate.noteEnvironmentalFailure(NOW_MS),
    SyncReason.TransportUnavailable
  );
  writers.laneRun.adopt(gate, seeded, NOW_MS);
  // One more environmental failure is all it took.
  writers.laneRun.noteEnvironmentalOutcome(
    gate,
    gate.noteEnvironmentalFailure(NOW_MS + 60_000),
    SyncReason.TransportUnavailable
  );
  await settleLaneRunWrites();

  const persisted = source.persistedSyncState(key);
  assert.deepEqual(
    {
      laneStalledSince: persisted?.laneStalledSince,
      laneGaveUpAt: persisted?.laneGaveUpAt,
      laneGaveUpReason: persisted?.laneGaveUpReason,
      laneGaveUpSource: persisted?.laneGaveUpSource,
    },
    seeded,
    "the outage the row records survives: refusing to adopt a run is not superseding it"
  );
  assert.deepEqual(
    source.laneRunWrites,
    [],
    "and no write was issued at all, because the merged record is what the row already held"
  );
});

test("ISS-10053: an unreadable run origin is NAMED rather than silently reopened", () => {
  // marisolashgrove review. This is the one defect nothing else can witness: the
  // reader hands back no origin, the lane opens a fresh run, and the install
  // reproduces the ISS-10053 defect on every launch — a column an operator would
  // act on, failing in the direction that looks exactly like a healthy new run.
  // `"0"` is the value the reader's own note names: `Date.parse` takes it as the
  // year 2000, which the column schema refuses.
  const TARGET = "target-unreadable-origin";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([]);
  const writers = createOutboxWriters(() => ({ sourceKey: key, source }));
  gatewayLog.clear();

  writers.laneRun.adopt(
    new LaneEnvironmentalDeferGate(),
    { laneStalledSince: "0" },
    NOW_MS
  );

  const named = gatewayLog
    .getEntries()
    .filter((entry) => entry.message.includes("run-origin-unreadable"));
  gatewayLog.clear();
  assert.equal(
    named.length,
    1,
    "the corrupt column is named on the lane's own channel, under the name the component twin uses"
  );
  assert.ok(
    named[0]?.message.includes(
      "opens a fresh run rather than giving up on a duration it cannot substantiate"
    ),
    "and says what the lane did about it, which is what makes the line actionable"
  );
});

test("PLN-2028 D4: a REFUSED hydration leaves the live lane's give-up state alone", async () => {
  // D4 binds the lane, not only the gate. A gate already holding the run THIS
  // process saw refuses the record, and the lane's belief about its give-up has
  // to obey the same refusal — a row's stale value taken there is what makes
  // `noteRowCeilingGiveUp`'s anchor guard swallow the next GENUINE ceiling, so
  // the row keeps a cause and a producer that describe a different outage.
  //
  // Reachable without a restart, though not by a race inside one pass: hydration
  // runs once per IDENTITY, and the lane opens a run under a null one — a desktop
  // that starts with no compute target defers `transport_unavailable` first, and
  // the row is read only when a target resolves and the identity changes.
  const TARGET = "target-refused-hydration";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([]);
  const writers = createOutboxWriters(() => ({ sourceKey: key, source }));
  const gate = new LaneEnvironmentalDeferGate();

  // This process saw the outage open, so the gate holds a run of its own.
  writers.laneRun.noteEnvironmentalOutcome(
    gate,
    gate.noteEnvironmentalFailure(NOW_MS),
    SyncReason.TransportUnavailable
  );
  writers.laneRun.adopt(
    gate,
    {
      laneStalledSince: new Date(
        NOW_MS - SESSION_LANE_STALL_CEILING_MS
      ).toISOString(),
      laneGaveUpAt: new Date(NOW_MS - HOUR_MS).toISOString(),
      laneGaveUpReason: SyncReason.Unauthenticated,
      laneGaveUpSource: LaneGiveUpSource.EnvironmentalGate,
    },
    NOW_MS
  );
  writers.laneRun.noteRowCeilingGiveUp(
    gate,
    NOW_MS + HOUR_MS,
    SyncReason.IngestionFailed
  );
  await settleLaneRunWrites();

  assert.deepEqual(
    {
      laneGaveUpAt: source.persistedSyncState(key)?.laneGaveUpAt,
      laneGaveUpReason: source.persistedSyncState(key)?.laneGaveUpReason,
      laneGaveUpSource: source.persistedSyncState(key)?.laneGaveUpSource,
    },
    {
      laneGaveUpAt: new Date(NOW_MS + HOUR_MS).toISOString(),
      laneGaveUpReason: SyncReason.IngestionFailed,
      laneGaveUpSource: LaneGiveUpSource.RowCeiling,
    },
    "the ceiling this process actually crossed is recorded, cause and producer together"
  );
});

test("PLN-2028: the clear writes for an identity this lane never adopted", async () => {
  // Premise correction 7. The tracker deliberately refuses no write, so this
  // precondition is the lane's — and the clear is the one write that must skip
  // it. Both answers reach it through the fold funnel on a path that has not
  // necessarily hydrated, and refusing it there would leave a give-up on the row
  // for a lane the server has demonstrably just judged.
  const TARGET = "target-clear-unadopted";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  const source = new FakeSyncSource([]);
  source.seedSyncState(key, {
    observedTopUpdatedAt: null,
    observedIdsAtTopUpdatedAt: [],
    laneStalledSince: new Date(NOW_MS - HOUR_MS).toISOString(),
    laneGaveUpAt: new Date(NOW_MS).toISOString(),
    laneGaveUpReason: SyncReason.IngestionFailed,
    laneGaveUpSource: LaneGiveUpSource.RowCeiling,
  });
  const writers = createOutboxWriters(() => ({ sourceKey: key, source }));

  writers.laneRun.clear();
  await settleLaneRunWrites();

  assert.deepEqual(
    source.laneRunWrites,
    [
      {
        sourceKey: key,
        run: {
          laneStalledSince: null,
          laneGaveUpAt: null,
          laneGaveUpReason: null,
          laneGaveUpSource: null,
        },
      },
    ],
    "the clear is issued although nothing consulted this row first"
  );
  assert.equal(
    source.persistedSyncState(key)?.laneGaveUpAt,
    undefined,
    "and the recovered lane's row genuinely carries no give-up"
  );
});
