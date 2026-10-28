/**
 * @file sync-burndown-gated-backlog.test.ts
 * @description ISS-8768 — a lane whose gate is SHUT while the machine is
 * consented to deliver must be reported, and the backlog it is sitting on must
 * be counted honestly while it sits there.
 *
 * The two halves are one defect, which is why they are one file. On the install
 * that prompted this, cloud ingest was dark for three weeks while
 * `dataSyncLevel` said `full`: the invocation lane held 3,031 `pending` rows at
 * `attempt_count = 0` with `last_error = NULL`, and BOTH existing stall
 * detectors are blind to that by construction — `detectCursorStall` needs work
 * completed > 0, and `detectNoProgressStall` needs the lane RUNNING. Nothing had
 * failed, so nothing spoke.
 *
 * Closing only the detector half would have shipped a false green: with no
 * compute target the burn-down's own invocation read returned all-zeros, so the
 * new detector would have been measuring a fabricated `0` and could never have
 * fired on the very install it was written for.
 *
 * A new file rather than an addition to `sync-burndown-store.test.ts` (1,004
 * lines) or `sync-burndown-reporter-stalls.test.ts`, per the ISS-7401 split
 * precedent and the 1,000-line ceiling.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, test } from "vitest";
import { AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY } from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  SyncLaneId,
  SyncLaneRemainderBasis,
  SyncLaneStallKind,
} from "../src/shared/sync-burndown-contract.js";
import { seedOwedTemplateSession } from "./support/sync-burndown-fixtures.js";
import {
  buildHarness,
  emptySample,
  type Harness,
  messages,
} from "./sync-burndown-reporter-harness.js";

const COMPUTE_TARGET_ID = "ct-1";
const SESSION_SOURCE_KEY = "agent_sessions:ct-1";
const COMPONENT_SOURCE_KEY = "agent_components:v3:ct-1";
const SAMPLE_NOW = "2026-08-06T12:00:00.000Z";
const GATE_SHUT_RE = /LANE GATE SHUT/;

/**
 * The unpaired shape: `invocationSourceKey` null because no compute target has
 * ever been negotiated. Everything else is a normally-configured machine.
 */
function unpairedBurndownQuery() {
  return {
    sessionSourceKey: SESSION_SOURCE_KEY,
    invocationSourceKey: null,
    invocationTemplateSourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    componentSourceKey: COMPONENT_SOURCE_KEY,
    transcriptComputeTargetId: COMPUTE_TARGET_ID,
    identity: null,
    nowIso: SAMPLE_NOW,
  };
}

test("ISS-8768: an unpaired machine reports the template backlog it owes, not zero", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8768-unpaired-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => SAMPLE_NOW,
    });
    try {
      const owedSessions = 7;
      for (let index = 0; index < owedSessions; index += 1) {
        await seedOwedTemplateSession(db, `tmpl-${index}`);
      }

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown(unpairedBurndownQuery());

      // The whole point: before this, a null delivery key short-circuited to
      // all-zeros and this read answered `0` on a real backlog.
      assert.equal(
        sample.invocationOutbox.pendingTemplateSessions,
        owedSessions,
        `an unpaired machine owes its WHOLE template backlog (${owedSessions}), and reporting 0 is what hid three weeks of undelivered work`
      );
      // Delivery-scoped counts stay honestly zero: nothing has been promoted,
      // which is a different fact from "nothing is owed".
      assert.equal(
        sample.invocationOutbox.pending,
        0,
        "no rows exist under a delivery key that was never negotiated"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8768: a paired-but-OFFLINE machine does not report an inflated backlog", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8768-offline-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => SAMPLE_NOW,
    });
    try {
      for (let index = 0; index < 7; index += 1) {
        await seedOwedTemplateSession(db, `tmpl-${index}`);
      }
      // The distinguishing fact: this machine HAS promoted before, so a null
      // delivery key here means offline, not unpaired.
      await db.run(
        `INSERT INTO agent_component_invocation_sync_cursors
           (source_key, external_session_id, external_generation_id,
            source_sequence, updated_at)
         VALUES (?, ?, ?, 1, ?)`,
        `${AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY}:ct-1`,
        "tmpl-0",
        "tmpl-0-gen",
        "2026-08-01T00:00:00.000Z"
      );

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown(unpairedBurndownQuery());

      // Without the real delivery key the probe cannot evaluate its
      // already-delivered half, so counting would report every template session
      // as owed — a fabricated number in the other direction, and one that would
      // page a healthy machine over a three-minute connectivity blip.
      assert.equal(
        sample.invocationOutbox.pendingTemplateSessions,
        0,
        "an offline machine's backlog is not computable without its target, and a guess would page on a blip"
      );
      // ISS-10082: and the zeros say so. This is the branch that shares its null
      // key with the never-promoted one above and differs on everything else.
      assert.equal(
        sample.invocationOutbox.remainderBasis,
        SyncLaneRemainderBasis.Unqueried,
        "nothing was read on this branch, so its zeros are placeholders and must not be republished as a measurement"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8768 (davetho review): a never-paired identity's backlog is not suppressed by a DIFFERENT identity's promoted cursor", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8768-cross-account-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => SAMPLE_NOW,
    });
    try {
      const owedSessions = 7;
      for (let index = 0; index < owedSessions; index += 1) {
        await seedOwedTemplateSession(db, `tmpl-${index}`);
      }
      // Account A previously signed into THIS machine, paired to `ct-A`, and
      // promoted — leaving a durable cursor row behind that survives the
      // account switch.
      await db.run(
        `INSERT INTO agent_component_invocation_sync_cursors
           (source_key, external_session_id, external_generation_id,
            source_sequence, updated_at)
         VALUES (?, ?, ?, 1, ?)`,
        `${AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY}:ct-A`,
        "tmpl-0",
        "tmpl-0-gen",
        "2026-08-01T00:00:00.000Z"
      );

      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      // Account B is signed in now, consented, offline, and has NEVER paired to
      // any target of its own — `sessionSourceKey` null is the identity-bound
      // signal for that, distinct from account A's leftover cursor.
      const sample = await readSyncBurndown({
        ...unpairedBurndownQuery(),
        sessionSourceKey: null,
      });

      assert.equal(
        sample.invocationOutbox.pendingTemplateSessions,
        owedSessions,
        "account A's cursor must not read as proof that account B has paired — B still owes its whole backlog"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * ISS-10082. The store's OWN derivation, pinned against real SQLite — without
 * this, replacing every `SyncLaneRemainderBasis.Unqueried` in
 * `sync-burndown-store.ts` with `Counted` leaves the whole suite green: the
 * reporter cases hand-set the field on a fake store, and the case above asserts
 * only the `Counted` branch.
 */
test("ISS-10082: the store labels every short-circuited lane read as unqueried", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss10082-unqueried-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => SAMPLE_NOW,
    });
    try {
      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown({
        ...unpairedBurndownQuery(),
        sessionSourceKey: null,
        componentSourceKey: null,
      });

      assert.equal(
        sample.sessionOutbox.remainderBasis,
        SyncLaneRemainderBasis.Unqueried,
        "`readSessionOutbox` and `readSessionParked` are both skipped on a null key, so the fold's zeros are placeholders"
      );
      assert.equal(
        sample.componentInventory.remainderBasis,
        SyncLaneRemainderBasis.Unqueried,
        "`readComponentInventoryCounts` returns before touching the cursor row"
      );
      // The counter-case in the same read, so this cannot pass by labelling
      // everything unqueried: the transcript ledger is target-independent and
      // genuinely measures on the very same sample.
      assert.equal(
        sample.transcript.unmeasuredRows,
        0,
        "the unscoped lanes still read, so a blanket `unqueried` would be wrong"
      );

      const scoped = await readSyncBurndown(unpairedBurndownQuery());
      assert.equal(
        scoped.sessionOutbox.remainderBasis,
        SyncLaneRemainderBasis.Counted,
        "with a key the session reads DO run, so labelling them unqueried would strand a measurable lane at remaining_unknown forever"
      );
      assert.equal(
        scoped.componentInventory.remainderBasis,
        SyncLaneRemainderBasis.Counted
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The reporter half. `detectGatedBacklogStall` is unit-tested as a pure function
 * next door in `sync-burndown-contract.test.ts`; the consecutive-sample tally,
 * the per-episode latch, the consent discriminator, and the `onLaneStall`
 * emission all live HERE — without these cases, deleting `maybeWarnGatedBacklog`
 * outright would leave the whole suite green.
 */
describe("SyncBurndownReporter — gate-shut backlog (ISS-8768)", () => {
  /** A consented machine whose session lane is gated off with work owed. */
  function gatedSessionSample() {
    const sample = emptySample();
    sample.sessionOutbox = {
      pending: 985,
      readyPending: 985,
      deadLettered: 0,
      withheld: 0,
      oldestPendingSinceIso: "2026-08-10T18:36:27.817Z",
      unmeasuredRows: 0,
      parkedPending: 0,
      remainderBasis: SyncLaneRemainderBasis.Counted,
    };
    return sample;
  }

  const sessionStalls = (harness: Harness) =>
    harness.stalls.filter((stall) => stall.lane === SyncLaneId.SessionMetadata);

  it("raises a monitored stall for a consented lane whose gate is shut", async () => {
    const harness = buildHarness({
      sample: gatedSessionSample(),
      running: false,
      consented: true,
    });
    harness.reporter.start();

    for (let pass = 0; pass < 4; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    harness.reporter.stop();

    const stalls = sessionStalls(harness);
    assert.equal(
      stalls.length,
      1,
      "a consented machine that is not delivering must reach the monitored sink, once per episode"
    );
    assert.equal(
      stalls[0]?.kind,
      SyncLaneStallKind.GateShutWithBacklog,
      "the operator acts on a shut gate differently from a lane that is running and stuck"
    );
    assert.equal(
      stalls[0]?.itemsRemaining,
      985,
      "the alert must carry the real backlog, not a fabricated zero"
    );
    assert.match(messages(harness.lines), GATE_SHUT_RE);
  });

  it("stays silent when the machine is not consented to deliver", async () => {
    const harness = buildHarness({
      sample: gatedSessionSample(),
      running: false,
      consented: false,
    });
    harness.reporter.start();

    for (let pass = 0; pass < 4; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    harness.reporter.stop();

    assert.equal(
      sessionStalls(harness).length,
      0,
      "a shut gate is the CORRECT state for a machine whose user turned delivery off; alerting on it would be noise on every deliberately-local install"
    );
    assert.doesNotMatch(messages(harness.lines), GATE_SHUT_RE);
  });

  /**
   * The lanes do not share ONE consent axis, and a machine-wide predicate is
   * wrong rather than merely coarse. `metadata` tier permits session metadata
   * while deliberately keeping transcripts local, so answering the transcript
   * lane from the session-metadata tier pages a metadata-tier user for the
   * configuration they chose — the exact noise the consent check exists to
   * prevent. Caught in review; this pins it.
   */
  it("does not page a metadata-tier machine for its deliberately-local transcripts", async () => {
    const sample = gatedSessionSample();
    sample.transcript.inFlightFiles = 12;
    const harness = buildHarness({
      sample,
      running: false,
      // Exactly what `laneDeliveryConsented` computes on `metadata` tier.
      consentedLanes: (lane) => lane !== SyncLaneId.TranscriptArchive,
    });
    harness.reporter.start();

    for (let pass = 0; pass < 4; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    harness.reporter.stop();

    assert.equal(
      harness.stalls.filter(
        (stall) => stall.lane === SyncLaneId.TranscriptArchive
      ).length,
      0,
      "a transcript backlog on a machine that never consented to ship transcripts is the chosen configuration, not a defect"
    );
    assert.equal(
      sessionStalls(harness).length,
      1,
      "and the session lane, which the SAME machine did consent to, still reports"
    );
  });

  it("re-arms once the gate opens, so a recurrence is reported again", async () => {
    const harness = buildHarness({
      sample: gatedSessionSample(),
      running: false,
      consented: true,
    });
    harness.reporter.start();
    for (let pass = 0; pass < 4; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    assert.equal(sessionStalls(harness).length, 1);

    harness.setRunning(true);
    await harness.reporter.sampleOnce();
    harness.setRunning(false);
    for (let pass = 0; pass < 4; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    harness.reporter.stop();

    assert.equal(
      sessionStalls(harness).length,
      2,
      "a gate that shuts again after a genuine recovery is a new episode, not a suppressed one"
    );
  });

  /**
   * ISS-8768 (marisolashgrove review): a component lane's `rowsRemaining` is
   * `null` whenever it has no compute target to probe against — the flapping
   * case, not evidence the outage cleared. `maybeWarnNoProgress` already keeps
   * an exempted sample from clearing its episode latch; `maybeWarnGatedBacklog`
   * used to clear both on ANY non-gated-looking sample, including this one,
   * which re-armed the latch mid-outage and paged again for a backlog that
   * never actually recovered.
   */
  function gatedComponentSample(rowsRemaining: number | null) {
    const sample = emptySample();
    sample.componentInventory = {
      rowsRemaining,
      deadLetteredCount: 0,
      remainderBasis:
        rowsRemaining === null
          ? SyncLaneRemainderBasis.Unqueried
          : SyncLaneRemainderBasis.Counted,
    };
    return sample;
  }

  const componentStalls = (harness: Harness) =>
    harness.stalls.filter(
      (stall) => stall.lane === SyncLaneId.ComponentInventory
    );

  it("does not re-page an unbroken gate-shut outage when one sample's backlog is merely unmeasurable", async () => {
    const harness = buildHarness({
      sample: gatedComponentSample(412),
      running: false,
      consented: true,
    });
    harness.reporter.start();

    for (let pass = 0; pass < 3; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    assert.equal(
      componentStalls(harness).length,
      1,
      "the first episode crosses the threshold and reports"
    );

    // A flap: the compute target the component probe needs is briefly gone, so
    // the backlog is UNMEASURABLE this sample — the lane is still gated and
    // still consented, nothing about this sample says the outage ended.
    harness.setSample(gatedComponentSample(null));
    await harness.reporter.sampleOnce();

    // The outage never actually cleared. Once the backlog is measurable again
    // it re-crosses the sample threshold, but this is the SAME unbroken episode.
    harness.setSample(gatedComponentSample(412));
    for (let pass = 0; pass < 3; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    harness.reporter.stop();

    assert.equal(
      componentStalls(harness).length,
      1,
      "an unmeasurable sample must not re-arm the episode latch for a gate that was never actually reopened"
    );
  });

  /**
   * ISS-8768 (marisolashgrove review, operator decision): `NeverStarted` is
   * PERMANENT for an unpaired machine, so unlike the no-progress sibling
   * (which requires `Draining` and stops logging on its own once the lane
   * either drains or leaves that state), this WARN log would otherwise repeat
   * every sample forever. It must throttle to the first occurrence plus an
   * hourly cadence, and the monitored `onLaneStall` alert (already deduped
   * per episode) must be unaffected.
   */
  it("throttles the recurring gate-shut WARN log to hourly after the first occurrence", async () => {
    const harness = buildHarness({
      sample: gatedSessionSample(),
      running: false,
      consented: true,
      // 3 samples per throttle window (3,600,000ms / 1,200,000ms), so the
      // test observes the throttle in a handful of passes instead of the
      // 60+ the real 60s default would need.
      intervalMs: 20 * 60 * 1000,
    });
    harness.reporter.start();

    for (let pass = 0; pass < 10; pass += 1) {
      await harness.reporter.sampleOnce();
    }
    harness.reporter.stop();

    const gateShutLogLines = harness.lines.filter((line) =>
      GATE_SHUT_RE.test(line.message)
    );
    assert.equal(
      gateShutLogLines.length,
      3,
      "sample 3 (first occurrence) plus hourly re-prints at samples 6 and 9 — never every sample"
    );
    assert.equal(
      sessionStalls(harness).length,
      1,
      "the monitored alert must still dedupe per episode; only the local log line's cadence changes"
    );
  });
});

/**
 * ISS-10082. The join neither half of this file made before: the REAL store's
 * never-promoted sample, carried through the REAL reporter, to the alert.
 *
 * Both designs rejected for ISS-10082 gated the remainder on
 * `deadLetteredBasis === Unmeasured`, which is set from the source key and is
 * therefore true for BOTH of `readInvocationCounts`' null-key branches. The
 * never-promoted branch is not a placeholder — it runs the bounded template
 * probe above — so gating on that field nulls a measured backlog and makes
 * `detectGatedBacklogStall` unable to fire, retiring the very alert this file
 * exists for. Neither existing half could see it: the store cases stop at the
 * counts, and the reporter cases stub the counts through a harness that lets a
 * suite set the source key and the template count independently, so the coupling
 * the real store enforces was never exercised. This case is that coupling.
 */
test("ISS-10082: a never-promoted install's REAL backlog still raises the gate-shut alert", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss10082-never-promoted-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => SAMPLE_NOW,
    });
    try {
      const owedSessions = 7;
      for (let index = 0; index < owedSessions; index += 1) {
        await seedOwedTemplateSession(db, `tmpl-${index}`);
      }
      const readSyncBurndown = db.syncSource.readSyncBurndown;
      assert.ok(readSyncBurndown, "the sync source exposes the burn-down read");
      const sample = await readSyncBurndown(unpairedBurndownQuery());

      // The store's own answer, which no reporter-side derivation can reach: it
      // queried, so the remainder beside it is a count and not a placeholder.
      assert.equal(
        sample.invocationOutbox.remainderBasis,
        SyncLaneRemainderBasis.Counted,
        "the never-promoted branch runs a real probe, so its remainder is measured — this is the fact that distinguishes it from the offline branch, which shares its null key"
      );

      const harness = buildHarness({
        sample,
        running: false,
        consented: true,
      });
      // The same null delivery key the store just read under. It drives
      // `deadLetteredBasisFor` to `Unmeasured` — true of the dead letters, and
      // NOT a statement about the remainder the probe counted.
      harness.setSourceKeys({ invocation: null });
      harness.reporter.start();
      for (let pass = 0; pass < 4; pass += 1) {
        await harness.reporter.sampleOnce();
      }
      harness.reporter.stop();

      const invocationStalls = harness.stalls.filter(
        (stall) => stall.lane === SyncLaneId.InvocationParts
      );
      assert.equal(
        invocationStalls.length,
        1,
        "a consented, never-promoted, gated-off machine owing 7 sessions must still page — this is the 3,031-row silent backlog ISS-8768 was built after"
      );
      assert.equal(
        invocationStalls[0]?.kind,
        SyncLaneStallKind.GateShutWithBacklog
      );
      assert.equal(
        invocationStalls[0]?.itemsRemaining,
        owedSessions,
        "the alert carries the measured backlog; nulling it here is what silently retires the alert"
      );
      assert.match(messages(harness.lines), GATE_SHUT_RE);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
