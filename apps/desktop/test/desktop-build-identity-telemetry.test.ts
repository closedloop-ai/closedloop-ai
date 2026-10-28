/**
 * ISS-9743 — desktop telemetry must be able to name the build that emitted it.
 *
 * `desktopClientVersion` cannot. It carries `apps/desktop/package.json`'s
 * `version`, which is the bare series anchor on every build that is not a
 * release, so it partitions the fleet into "this release" and "some build from
 * source" and is a CONSTANT inside the second bucket. The regression these
 * tests hold is that two source builds at different commits are told apart, and
 * that a release still reports its minted `desktop-v*` version.
 *
 * The literals below are pinned independently of the modules under test. A
 * fixture that derived its expectation from `build-info.ts` or from
 * `resolveDesktopBuildCommit` would stay green if either were emptied.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { Observability } from "../src/main/telemetry/observability.js";
import { reportSyncLaneStall } from "../src/main/telemetry/sync-lane-stall-telemetry.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import { resolveDesktopBuildCommit } from "../src/main/util/desktop-build-commit.js";

/** Two source checkouts of the same series anchor, at different commits. */
const SOURCE_BUILD_COMMIT_A = "3fc32f406200b2a46b2a477f2f045527794f24bd";
const SOURCE_BUILD_COMMIT_B = "34dfd645e5b5005755deb1f302d511bf70a818a1";
/** The commit a release was cut from. */
const RELEASE_BUILD_COMMIT = "9a1c04e7b5d2f83610cc7be4a0d5f92718bb3c6e";

/**
 * The series anchor that sits in `apps/desktop/package.json` on `main`. Every
 * build from source reports this, which is precisely the defect.
 */
const SERIES_ANCHOR_VERSION = "0.16.69";
/** A minted `desktop-v*` version, as a release build reports it. */
const MINTED_RELEASE_VERSION = "0.16.1855";

afterEach(async () => {
  await Observability.shutdown();
  Observability.reset();
});

type TelemetryTrace = NonNullable<EnrichedTelemetryEvent["trace"]>;

/**
 * The trace of the one event a test provoked.
 *
 * Thrown rather than asserted: an assertion outside a test body trips
 * `noMisplacedAssertion`, and these are preconditions of the fixture rather
 * than the contract any caller is testing.
 */
function soleTrace(events: EnrichedTelemetryEvent[]): TelemetryTrace {
  const [event, ...extra] = events;
  if (!event || extra.length > 0) {
    throw new Error(
      `expected exactly one telemetry event, got ${events.length}`
    );
  }
  if (!event.trace) {
    throw new Error(`event ${event.category} carries no trace`);
  }
  return event.trace;
}

/**
 * Emit one `sync.durable_cursor.stalled` event and return its trace.
 *
 * That category is the one the 474 stall events in the ticket come from, and
 * its producer passes an EMPTY trace — so an assertion here proves the identity
 * is injected for every category, not only the two whose call sites happen to
 * build a trace themselves.
 */
function stallTraceForBuild(options: {
  desktopClientVersion?: string;
  desktopBuildCommit?: string;
}): TelemetryTrace {
  const events: EnrichedTelemetryEvent[] = [];
  Observability.init({
    telemetrySend: (event) => events.push(event),
    ...options,
  });

  reportSyncLaneStall({
    lane: "session_metadata",
    workCompletedSincePrevious: 12,
    durableCursorAgeMs: 900_000,
    deadLetteredCount: 0,
  });

  if (events[0]?.category !== "sync.durable_cursor.stalled") {
    throw new Error(`expected a stall event, got ${events[0]?.category}`);
  }
  return soleTrace(events);
}

describe("desktop build identity in telemetry (ISS-9743)", () => {
  test("two source builds at different commits are distinguishable", () => {
    const traceA = stallTraceForBuild({
      desktopClientVersion: SERIES_ANCHOR_VERSION,
      desktopBuildCommit: SOURCE_BUILD_COMMIT_A,
    });
    Observability.reset();
    const traceB = stallTraceForBuild({
      desktopClientVersion: SERIES_ANCHOR_VERSION,
      desktopBuildCommit: SOURCE_BUILD_COMMIT_B,
    });

    assert.equal(traceA.desktopBuildCommit, SOURCE_BUILD_COMMIT_A);
    assert.equal(traceB.desktopBuildCommit, SOURCE_BUILD_COMMIT_B);
    assert.notEqual(traceA.desktopBuildCommit, traceB.desktopBuildCommit);

    // And the commit is the ONLY thing telling them apart. ISS-8590 (#6832)
    // landed on main while this branch was open and made the stall event carry
    // `desktopClientVersion` — so the version is no longer ABSENT here, it is
    // IDENTICAL on both builds. That is the sharper statement of this ticket's
    // premise, and the reason ISS-8590 alone does not close it: the series
    // anchor is a constant across every build from source, so a query that
    // groups stalls by version still cannot separate these two.
    assert.equal(traceA.desktopClientVersion, SERIES_ANCHOR_VERSION);
    assert.equal(traceA.desktopClientVersion, traceB.desktopClientVersion);
    assert.deepEqual(traceA, {
      commandId: "",
      operationId: "",
      computeTargetId: "",
      desktopClientVersion: SERIES_ANCHOR_VERSION,
      desktopBuildCommit: SOURCE_BUILD_COMMIT_A,
    });
  });

  test("a release build still reports its minted version, and names its commit", () => {
    // A category that DOES attach the version, so both halves of the acceptance
    // criterion are observable on one event.
    const events: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => events.push(event),
      desktopClientVersion: MINTED_RELEASE_VERSION,
      desktopBuildCommit: RELEASE_BUILD_COMMIT,
    });

    Observability.tokenCostPricingMiss({
      model: "some-new-model-v1",
      surface: "synced_session",
      resolveReason: () => "unknown_model",
    });

    assert.deepEqual(soleTrace(events), {
      commandId: "",
      operationId: "",
      computeTargetId: "",
      desktopClientVersion: MINTED_RELEASE_VERSION,
      desktopBuildCommit: RELEASE_BUILD_COMMIT,
    });
    // A release is still told apart from a source build by the version alone —
    // this change does not touch what a release reports.
    assert.notEqual(MINTED_RELEASE_VERSION, SERIES_ANCHOR_VERSION);
  });

  test("the commit key is omitted, not defaulted, when none can be resolved", () => {
    const trace = stallTraceForBuild({
      desktopClientVersion: SERIES_ANCHOR_VERSION,
    });

    // Absent optional cross-process fields stay OMITTED so a build that could
    // not resolve a commit is distinguishable from an older client that reports
    // nothing (root AGENTS.md, Cross-Repo Compatibility Requirements).
    assert.equal(Object.hasOwn(trace, "desktopBuildCommit"), false);
    // Whole-trace, not a single `hasOwn`: this is what proves an unresolvable
    // commit adds NO key at all rather than a `null` or an "unknown"
    // placeholder. `desktopClientVersion` is here because ISS-8590 (#6832)
    // attaches it to stall events; it is a sibling field this ticket does not
    // own, and its presence is exactly why the commit is still needed.
    assert.deepEqual(trace, {
      commandId: "",
      operationId: "",
      computeTargetId: "",
      desktopClientVersion: SERIES_ANCHOR_VERSION,
    });
  });

  test("a caller cannot overwrite the build identity of the process it runs in", () => {
    const events: EnrichedTelemetryEvent[] = [];
    Observability.init({
      telemetrySend: (event) => events.push(event),
      desktopBuildCommit: SOURCE_BUILD_COMMIT_A,
    });

    // Pre-seed a CONFLICTING value so precedence itself is under test: the
    // build identity describes this process, so the service's value wins.
    Observability.getTelemetryEmitter().emit({
      severity: "info",
      category: "sync.durable_cursor.stalled",
      message: "stall",
      trace: { desktopBuildCommit: SOURCE_BUILD_COMMIT_B },
    });

    assert.equal(soleTrace(events).desktopBuildCommit, SOURCE_BUILD_COMMIT_A);
  });

  test("a caller forwarding an absent commit does not put an undefined key on the wire", () => {
    const events: EnrichedTelemetryEvent[] = [];
    Observability.init({ telemetrySend: (event) => events.push(event) });

    Observability.getTelemetryEmitter().emit({
      severity: "info",
      category: "sync.durable_cursor.stalled",
      message: "stall",
      trace: { desktopBuildCommit: undefined },
    });

    assert.equal(Object.hasOwn(soleTrace(events), "desktopBuildCommit"), false);
  });
});

describe("resolveDesktopBuildCommit (ISS-9743)", () => {
  test("returns distinct commits unchanged, so two builds stay distinguishable", () => {
    assert.equal(
      resolveDesktopBuildCommit(SOURCE_BUILD_COMMIT_A),
      SOURCE_BUILD_COMMIT_A
    );
    assert.equal(
      resolveDesktopBuildCommit(SOURCE_BUILD_COMMIT_B),
      SOURCE_BUILD_COMMIT_B
    );
  });

  test("yields undefined for anything that is not a full commit sha", () => {
    // `BUILD_COMMIT_HASH` is typed `string`, so each of these is reachable if
    // the generator ever renders something other than `git rev-parse HEAD`.
    for (const notACommit of [
      "",
      "unknown",
      SERIES_ANCHOR_VERSION,
      // A short sha: real, but not what the generator writes, and accepting it
      // would let two different lengths name the same build.
      "3fc32f4",
      // Uppercase hex: git never emits it, and accepting it would make one
      // commit two distinct identities in a GROUP BY.
      SOURCE_BUILD_COMMIT_A.toUpperCase(),
      `${SOURCE_BUILD_COMMIT_A}0`,
    ]) {
      assert.equal(
        resolveDesktopBuildCommit(notACommit),
        undefined,
        `expected no identity for ${JSON.stringify(notACommit)}`
      );
    }
  });
});
