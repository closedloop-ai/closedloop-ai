/**
 * @file derived-projection-promotion.test.ts
 * @description ISS-8741 — the build → validate → promote sequencing, driven
 * against a world that records the ORDER of every durable effect.
 *
 * The three cases the ticket names each get their own failure: a candidate a
 * target view refuses, an interruption between the build and the promotion, and
 * a promotion that lands. The point of every one of them is the same sentence:
 * the prior projection is still readable afterwards.
 *
 * The validators here are hand-written stubs with literal verdicts, deliberately
 * NOT the production schema — this suite polices the substrate's sequencing, and
 * a fixture that asked the real validator what "invalid" means would go green on
 * a substrate that never called a validator at all.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  DerivedProjectionPromotionOutcome,
  type DerivedProjectionValidator,
  promoteDerivedProjection,
} from "../src/main/database/derived-projection-promotion.js";
import { ProjectionTarget } from "../src/main/database/derived-projection-revision.js";

const RECORD = "session-1";
const REVISION = "data=95";
const GOOD_PROJECTION = "known-good rows";
const NO_VALIDATORS_MESSAGE = /at least one target validator/;
const REPLACEMENT_PROJECTION = "replacement rows";

type Candidate = { readonly rows: string };

/**
 * A stand-in for the durable state a promotion touches: the readable projection,
 * its known-good stamp, and the in-flight marker. Every mutation is appended to
 * `journal` so a test can assert that nothing cleared the projection BEFORE the
 * replacement was accepted — an assertion on final state alone cannot see a
 * destructive teardown that happened to be followed by a successful rebuild.
 */
function createWorld() {
  const journal: string[] = [];
  const state = {
    projection: GOOD_PROJECTION as string,
    knownGoodRevision: null as string | null,
    candidateRevision: null as string | null,
  };
  return {
    journal,
    state,
    store: {
      claimCandidate(recordKey: string, revision: string): Promise<void> {
        journal.push(`claim:${recordKey}:${revision}`);
        state.candidateRevision = revision;
        return Promise.resolve();
      },
      releaseCandidate(recordKey: string): Promise<void> {
        journal.push(`release:${recordKey}`);
        state.candidateRevision = null;
        return Promise.resolve();
      },
    },
    /** The caller's replacement: one all-or-nothing commit, like the real tx. */
    promote(candidate: Candidate, revision: string | null): Promise<string> {
      journal.push(`promote:${candidate.rows}`);
      state.projection = candidate.rows;
      state.knownGoodRevision = revision;
      state.candidateRevision = null;
      return Promise.resolve(candidate.rows);
    },
  };
}

function acceptingValidator(): DerivedProjectionValidator<Candidate> {
  return {
    target: ProjectionTarget.Sessions,
    validate: () => ({ valid: true }),
  };
}

function refusingValidator(
  target: ProjectionTarget
): DerivedProjectionValidator<Candidate> {
  return {
    target,
    validate: () => ({ valid: false, reason: "missing required field" }),
  };
}

describe("ISS-8741 gated projection promotion", () => {
  test("a candidate a target refuses never reaches the replacement", async () => {
    const world = createWorld();
    const result = await promoteDerivedProjection<Candidate, string>({
      recordKey: RECORD,
      revision: REVISION,
      store: world.store,
      buildCandidate: () => ({ rows: REPLACEMENT_PROJECTION }),
      validators: [refusingValidator(ProjectionTarget.Sessions)],
      promote: world.promote,
    });

    assert.equal(
      result.outcome,
      DerivedProjectionPromotionOutcome.CandidateRejected
    );
    assert.equal(result.rejectedBy, ProjectionTarget.Sessions);
    assert.equal(result.reason, "missing required field");
    assert.equal(
      world.state.projection,
      GOOD_PROJECTION,
      "the prior projection must still be readable"
    );
    assert.equal(world.state.knownGoodRevision, null);
    assert.equal(
      world.state.candidateRevision,
      null,
      "an abandoned attempt releases its marker"
    );
    assert.deepEqual(world.journal, [
      `claim:${RECORD}:${REVISION}`,
      `release:${RECORD}`,
    ]);
  });

  test("the refusing target is named, not the first registered one", async () => {
    const world = createWorld();
    const result = await promoteDerivedProjection<Candidate, string>({
      recordKey: RECORD,
      revision: REVISION,
      store: world.store,
      buildCandidate: () => ({ rows: REPLACEMENT_PROJECTION }),
      validators: [
        acceptingValidator(),
        refusingValidator(ProjectionTarget.Branches),
      ],
      promote: world.promote,
    });

    assert.equal(result.rejectedBy, ProjectionTarget.Branches);
    assert.equal(world.state.projection, GOOD_PROJECTION);
  });

  test("an interruption between the build and the promotion leaves the prior projection and a durable marker", async () => {
    const world = createWorld();
    const boom = new Error("db host exited mid-transaction");
    // The throw PROPAGATES rather than being folded into an outcome. What makes
    // a failed replacement harmless is its transaction, not a catch here — and
    // swallowing it once broke the ISS-5808 db-host-exit re-drive, which is
    // driven by exactly this error escaping the rebuild.
    await assert.rejects(
      () =>
        promoteDerivedProjection<Candidate, string>({
          recordKey: RECORD,
          revision: REVISION,
          store: world.store,
          buildCandidate: () => ({ rows: REPLACEMENT_PROJECTION }),
          validators: [acceptingValidator()],
          // The seam: the replacement is one transaction, so an interruption
          // inside it commits nothing. Nothing in `world.state` is touched.
          promote: () => Promise.reject(boom),
        }),
      (error: unknown) => error === boom
    );

    assert.equal(
      world.state.projection,
      GOOD_PROJECTION,
      "the prior projection must still be readable"
    );
    assert.equal(world.state.knownGoodRevision, null, "no half-promoted stamp");
    assert.equal(
      world.state.candidateRevision,
      REVISION,
      "the claim survives as the record that a replacement was attempted"
    );
  });

  test("a build that produces nothing retires nothing", async () => {
    const world = createWorld();
    const result = await promoteDerivedProjection<Candidate, string>({
      recordKey: RECORD,
      revision: REVISION,
      store: world.store,
      buildCandidate: () => null,
      validators: [acceptingValidator()],
      promote: world.promote,
    });

    assert.equal(
      result.outcome,
      DerivedProjectionPromotionOutcome.CandidateBuildFailed
    );
    assert.equal(world.state.projection, GOOD_PROJECTION);
    assert.equal(world.state.candidateRevision, null);
    assert.equal(
      world.journal.includes(`promote:${REPLACEMENT_PROJECTION}`),
      false
    );
  });

  test("a build that throws retires nothing", async () => {
    const world = createWorld();
    const boom = new Error("transcript unreadable");
    const result = await promoteDerivedProjection<Candidate, string>({
      recordKey: RECORD,
      revision: REVISION,
      store: world.store,
      buildCandidate: () => Promise.reject(boom),
      validators: [acceptingValidator()],
      promote: world.promote,
    });

    assert.equal(
      result.outcome,
      DerivedProjectionPromotionOutcome.CandidateBuildFailed
    );
    assert.equal(result.error, boom);
    assert.equal(world.state.projection, GOOD_PROJECTION);
    assert.equal(world.state.candidateRevision, null);
  });

  test("an accepted candidate is promoted, and a replay converges rather than accumulating", async () => {
    const world = createWorld();
    const request = {
      recordKey: RECORD,
      revision: REVISION,
      store: world.store,
      buildCandidate: () => ({ rows: REPLACEMENT_PROJECTION }),
      validators: [acceptingValidator()],
      promote: world.promote,
    };

    const first = await promoteDerivedProjection<Candidate, string>(request);
    assert.equal(first.outcome, DerivedProjectionPromotionOutcome.Promoted);
    assert.equal(first.promoted, REPLACEMENT_PROJECTION);
    const afterFirst = { ...world.state };
    assert.equal(afterFirst.projection, REPLACEMENT_PROJECTION);
    assert.equal(afterFirst.knownGoodRevision, REVISION);
    assert.equal(afterFirst.candidateRevision, null);

    // Replay the promotion, do not merely re-read a flag: the durable state has
    // to be identical afterwards.
    const second = await promoteDerivedProjection<Candidate, string>(request);
    assert.equal(second.outcome, DerivedProjectionPromotionOutcome.Promoted);
    assert.deepEqual(world.state, afterFirst);
  });

  test("the claim is taken BEFORE the build, so the whole window is covered", async () => {
    const world = createWorld();
    await promoteDerivedProjection<Candidate, string>({
      recordKey: RECORD,
      revision: REVISION,
      store: world.store,
      buildCandidate: () => {
        world.journal.push("build");
        return { rows: REPLACEMENT_PROJECTION };
      },
      validators: [
        {
          target: ProjectionTarget.Sessions,
          validate: () => {
            world.journal.push("validate");
            return { valid: true };
          },
        },
      ],
      promote: world.promote,
    });

    assert.deepEqual(world.journal, [
      `claim:${RECORD}:${REVISION}`,
      "build",
      "validate",
      `promote:${REPLACEMENT_PROJECTION}`,
    ]);
  });

  test("a wiring with no marker store still gets the gate and the atomic replacement", async () => {
    const world = createWorld();
    const rejected = await promoteDerivedProjection<Candidate, string>({
      recordKey: RECORD,
      revision: REVISION,
      buildCandidate: () => ({ rows: REPLACEMENT_PROJECTION }),
      validators: [refusingValidator(ProjectionTarget.Sessions)],
      promote: world.promote,
    });
    assert.equal(
      rejected.outcome,
      DerivedProjectionPromotionOutcome.CandidateRejected
    );
    assert.equal(world.state.projection, GOOD_PROJECTION);

    const promoted = await promoteDerivedProjection<Candidate, string>({
      recordKey: RECORD,
      revision: REVISION,
      buildCandidate: () => ({ rows: REPLACEMENT_PROJECTION }),
      validators: [acceptingValidator()],
      promote: world.promote,
    });
    assert.equal(promoted.outcome, DerivedProjectionPromotionOutcome.Promoted);
    assert.equal(world.state.projection, REPLACEMENT_PROJECTION);
    assert.deepEqual(
      world.journal.filter((entry) => entry.startsWith("claim:")),
      [],
      "no store means no marker writes"
    );
  });

  test("an unformattable revision suppresses the stamp without suppressing the gate", async () => {
    const world = createWorld();
    const result = await promoteDerivedProjection<Candidate, string>({
      recordKey: RECORD,
      revision: null,
      store: world.store,
      buildCandidate: () => ({ rows: REPLACEMENT_PROJECTION }),
      validators: [acceptingValidator()],
      promote: world.promote,
    });

    assert.equal(result.outcome, DerivedProjectionPromotionOutcome.Promoted);
    assert.equal(world.state.projection, REPLACEMENT_PROJECTION);
    assert.equal(
      world.state.knownGoodRevision,
      null,
      "nothing may be stamped known-good at a revision that could not be computed"
    );
    assert.deepEqual(
      world.journal.filter((entry) => entry.startsWith("claim:")),
      []
    );
  });

  test("a store that cannot write its marker does not cost the replacement", async () => {
    const world = createWorld();
    const result = await promoteDerivedProjection<Candidate, string>({
      recordKey: RECORD,
      revision: REVISION,
      store: {
        claimCandidate: () => Promise.reject(new Error("store unavailable")),
        releaseCandidate: () => Promise.reject(new Error("store unavailable")),
      },
      buildCandidate: () => ({ rows: REPLACEMENT_PROJECTION }),
      validators: [acceptingValidator()],
      promote: world.promote,
    });

    assert.equal(result.outcome, DerivedProjectionPromotionOutcome.Promoted);
    assert.equal(world.state.projection, REPLACEMENT_PROJECTION);
  });

  test("refuses to run with no validators at all", async () => {
    const world = createWorld();
    await assert.rejects(
      () =>
        promoteDerivedProjection<Candidate, string>({
          recordKey: RECORD,
          revision: REVISION,
          store: world.store,
          buildCandidate: () => ({ rows: REPLACEMENT_PROJECTION }),
          validators: [],
          promote: world.promote,
        }),
      NO_VALIDATORS_MESSAGE
    );
    assert.equal(world.state.projection, GOOD_PROJECTION);
  });
});
