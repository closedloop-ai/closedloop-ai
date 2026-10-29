/**
 * @file rehearsal-verify-checks.test.ts
 * @description ISS-5104 (widened by ISS-5466 and ISS-9284) — unit coverage for
 * the pure Phase B decision logic of the DATA_REVISION rebuild rehearsal
 * (`scripts/rehearsal-verify-checks.ts`): the tolerant manifest schema and every
 * violation class the verify script can report, including the ISS-5466
 * stored-row-bridge positive control and the ISS-9284 per-view classification.
 * Synthetic revision numbers are used throughout so this test does not pin the
 * live DATA_REVISION value.
 *
 * THE VIEW NAMES BELOW ARE WRITTEN OUT AS LITERALS, NOT IMPORTED. This file
 * guards the claim that the manifest carries one count per view a rebuild can
 * destroy; a fixture that built its expectation from `ProjectionTarget` (or from
 * the builder's own copy of that list) would agree with any mutation of it and
 * could never fail. The duplication IS the test. Same reason, and same shape, as
 * `derived-projection-revision.test.ts`'s "names every projection a bad
 * replacement can destroy".
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  agentReferenceViolations,
  collectRehearsalViolations,
  type RehearsalManifest,
  type RehearsalSessionState,
  rehearsalManifestSchema,
} from "../scripts/rehearsal-verify-checks.js";

const CURRENT_REVISION = 7;
const PENDING_SENTINEL = -1;

/** The default manifest's missing-source fixture (ISS-5466). */
const FIXTURE_ID = "fx1";

/** The four consuming views, spelled out (see the file header). */
type ViewKey = "sessions" | "branches" | "owner" | "aggregate";

// Hoisted per ultracite's useTopLevelRegex.
const RE_SUMMARY_FAILURE = /errors=2 parseErrors=1/;
const RE_MISSING_SOURCE_POPULATION = /missing-source population is not the one/;
const RE_MISSING_SOURCE = /missingSource=3/;
const RE_EXPECTED_ONE = /expected exactly 1/;
const RE_UNMATCHED_SOURCE = /unmatchedSource=4/;
const RE_BRIDGE_NO_ROWS = /gained no component-invocation rows/;
const RE_BRIDGE_VACUOUS = /would be vacuous/;
const RE_BRIDGE_ABSENT_PRE = /absent from the manifest's own pre-state/;
const RE_BRIDGE_GONE = /is gone after the rebuild/;
const RE_FIXTURE_ID = /fx1/;
const RE_REF_NO_NULLED = /no invocation row with a NULL agent_id/;
const RE_REF_NO_RETAINED = /no invocation row carrying an agent_id/;
const RE_PENDING_SENTINEL = /DATA_REVISION_IMPORT_PENDING/;
const RE_SESSION_S1 = /s1/;
const RE_SESSION_S2 = /s2/;
const RE_STALE_REVISION = /stale data_revision/;
const RE_DISAPPEARED = /are gone after it/;
const RE_ZERO_SESSIONS = /zero sessions/;
// ISS-9284: one "loss in view X" matcher per view, written as literals.
const RE_LOSS_IN_SESSIONS = /projection loss in view "sessions"/;
const RE_LOSS_IN_BRANCHES = /projection loss in view "branches"/;
const RE_LOSS_IN_OWNER = /projection loss in view "owner"/;
const RE_LOSS_IN_AGGREGATE = /projection loss in view "aggregate"/;
const RE_LOST_INVOCATION_ROW = /lost component-invocation row\(s\)/;
const RE_LOST_BRANCH_LINK = /lost branch-attribution link\(s\)/;
const RE_LOST_OWNER_COLUMN = /lost owner identity column\(s\)/;
const RE_LOST_ANALYTICS_ROW = /lost session_analytics row\(s\)/;
const RE_PARTIAL_INVOCATION_LOSS = /52→51/;
const RE_BRANCH_PARTIAL_LOSS = /2→1/;
const RE_OWNER_BLANKED = /2→0/;
const RE_SESSION_HAD = /had/;
const RE_SESSION_NEVER_HAD_LISTED = /never-had,/;
const RE_VACUOUS_SESSIONS = /"sessions" projection-loss check would be vacuous/;
const RE_VACUOUS_BRANCHES = /"branches" projection-loss check would be vacuous/;
const RE_VACUOUS_OWNER = /"owner" projection-loss check would be vacuous/;
const RE_VACUOUS_AGGREGATE =
  /"aggregate" projection-loss check would be vacuous/;
const RE_INTACT_FOR_THE_OTHER_THREE = /intact for sessions, owner, aggregate/;
const RE_INTACT_FOR_ALL_BUT_OWNER = /intact for sessions, branches, aggregate/;
const RE_INTACT_FOR_ALL_BUT_SESSIONS = /intact for branches, owner, aggregate/;
// PR #6728 (whitlockk): the reattribution arm of the Owner projection.
const RE_OWNER_REATTRIBUTION = /owner reattribution/;
const RE_REATTRIBUTED_USER = /userId: user-a→user-b/;
const RE_REATTRIBUTED_ORG = /organizationId: org-a→org-b/;

/**
 * Per-view counts with every view populated by default, so a test that breaks
 * ONE view is measuring that view and not an ambient zero.
 */
function projections(
  overrides: Partial<Record<ViewKey, number>> = {}
): Record<ViewKey, number> {
  return { sessions: 3, branches: 2, owner: 2, aggregate: 1, ...overrides };
}

/** The owner pair a healthy session carries on both sides of the rebuild. */
const OWNER_USER_ID = "owner-user";
const OWNER_ORGANIZATION_ID = "owner-org";

function session(
  overrides: {
    id: string;
    dataRevision?: number;
    userId?: string | null;
    organizationId?: string | null;
  } & Partial<Record<ViewKey, number>>
): RehearsalSessionState {
  const { id, dataRevision, userId, organizationId, ...views } = overrides;
  return {
    id,
    dataRevision: dataRevision ?? CURRENT_REVISION,
    projections: projections(views),
    ownerIdentity: {
      userId: userId === undefined ? OWNER_USER_ID : userId,
      organizationId:
        organizationId === undefined ? OWNER_ORGANIZATION_ID : organizationId,
    },
  };
}

/**
 * Every manifest carries the ISS-5466 missing-source fixture, because the schema
 * requires at least one — a manifest without it is a shape production cannot
 * produce, so building the non-fixture cases on one would test an unreachable
 * state. `fixturePre` overrides the fixture's pre-rebuild row.
 */
function manifestOf(
  sessions: RehearsalSessionState[],
  fixturePre?: Partial<Record<ViewKey, number>>
): RehearsalManifest {
  return {
    rehearsalManifestVersion: 4,
    sessions: [
      ...sessions,
      session({
        id: FIXTURE_ID,
        dataRevision: 1,
        sessions: 0,
        aggregate: 0,
        ...fixturePre,
      }),
    ],
    missingSourceFixtureIds: [FIXTURE_ID],
  };
}

/**
 * `fixturePost` defaults to the row a HEALTHY bridge run leaves behind (rows
 * gained from a zero pre-state); pass overrides to break it, or `null` to drop
 * the fixture from the post-state entirely. `missingSource` defaults to the
 * staged fixture count, which is what a healthy run reports.
 */
function violationsFor(options: {
  manifest?: RehearsalManifest;
  postSessions?: RehearsalSessionState[];
  errors?: number;
  parseErrors?: number;
  missingSource?: number;
  unmatchedSource?: number;
  fixturePost?: Partial<Record<ViewKey, number>> | null;
}): string[] {
  const manifest =
    options.manifest ?? manifestOf([session({ id: "s1", dataRevision: 6 })]);
  const postSessions = [...(options.postSessions ?? [session({ id: "s1" })])];
  if (options.fixturePost !== null) {
    postSessions.push(
      session({ id: FIXTURE_ID, sessions: 4, ...options.fixturePost })
    );
  }
  return collectRehearsalViolations({
    manifest,
    postSessions,
    outcome: {
      errors: options.errors ?? 0,
      parseErrors: options.parseErrors ?? 0,
      missingSource:
        options.missingSource ?? manifest.missingSourceFixtureIds.length,
      unmatchedSource: options.unmatchedSource ?? 0,
    },
    currentRevision: CURRENT_REVISION,
    importPendingSentinel: PENDING_SENTINEL,
  });
}

describe("rehearsalManifestSchema", () => {
  test("accepts a manifest with unknown extra fields (version-skew tolerance)", () => {
    const parsed = rehearsalManifestSchema.parse({
      rehearsalManifestVersion: 4,
      sessions: [
        {
          id: "s1",
          dataRevision: 3,
          ownerIdentity: {
            userId: OWNER_USER_ID,
            organizationId: OWNER_ORGANIZATION_ID,
          },
          projections: { sessions: 2, branches: 1, owner: 2, aggregate: 0 },
          futureField: "written by a newer build-store",
        },
      ],
      missingSourceFixtureIds: [FIXTURE_ID],
      futureTopLevel: true,
    });
    assert.equal(parsed.sessions.length, 1);
    assert.equal(parsed.sessions[0].id, "s1");
    assert.deepEqual(parsed.missingSourceFixtureIds, [FIXTURE_ID]);
  });

  test("ISS-9284: carries one count per view a rebuild can destroy — exactly these four", () => {
    // The keys are written out, not derived from ProjectionTarget: this is the
    // assertion that fails when a view is dropped from the manifest schema
    // (which is how Branches and Owner went unwatched in the first place). Zod
    // strips unknown keys, so what comes back IS the schema's own key set.
    const parsed = rehearsalManifestSchema.parse({
      rehearsalManifestVersion: 4,
      sessions: [
        {
          id: "s1",
          dataRevision: 3,
          ownerIdentity: {
            userId: OWNER_USER_ID,
            organizationId: OWNER_ORGANIZATION_ID,
          },
          projections: {
            sessions: 5,
            branches: 4,
            owner: 2,
            aggregate: 1,
            futureView: 9,
          },
        },
      ],
      missingSourceFixtureIds: [FIXTURE_ID],
    });
    assert.deepEqual(Object.keys(parsed.sessions[0].projections).sort(), [
      "aggregate",
      "branches",
      "owner",
      "sessions",
    ]);
    assert.deepEqual(parsed.sessions[0].projections, {
      sessions: 5,
      branches: 4,
      owner: 2,
      aggregate: 1,
    });
  });

  test("ISS-9284: rejects a session with no projections block at all", () => {
    // The pre-ISS-9284 shape. Accepting it would mean a Phase A that never
    // snapshotted a view handed Phase B a manifest it could not fail on.
    assert.throws(() =>
      rehearsalManifestSchema.parse({
        rehearsalManifestVersion: 4,
        sessions: [
          {
            id: "s1",
            dataRevision: 3,
            invocationCount: 2,
            analyticsCount: 1,
            ownerIdentity: {
              userId: OWNER_USER_ID,
              organizationId: OWNER_ORGANIZATION_ID,
            },
          },
        ],
        missingSourceFixtureIds: [FIXTURE_ID],
      })
    );
  });

  test("ISS-9284: rejects a manifest that omits any single view", () => {
    for (const omitted of ["sessions", "branches", "owner", "aggregate"]) {
      const counts: Record<string, number> = {
        sessions: 2,
        branches: 1,
        owner: 2,
        aggregate: 1,
      };
      delete counts[omitted];
      assert.throws(
        () =>
          rehearsalManifestSchema.parse({
            rehearsalManifestVersion: 4,
            sessions: [
              {
                id: "s1",
                dataRevision: 3,
                projections: counts,
                ownerIdentity: {
                  userId: OWNER_USER_ID,
                  organizationId: OWNER_ORGANIZATION_ID,
                },
              },
            ],
            missingSourceFixtureIds: [FIXTURE_ID],
          }),
        `a manifest missing the "${omitted}" view must be rejected`
      );
    }
  });

  test("rejects a manifest with zero sessions", () => {
    assert.throws(() =>
      rehearsalManifestSchema.parse({
        rehearsalManifestVersion: 4,
        sessions: [],
        missingSourceFixtureIds: [FIXTURE_ID],
      })
    );
  });

  test("rejects a manifest whose projection fields are not counts", () => {
    assert.throws(() =>
      rehearsalManifestSchema.parse({
        rehearsalManifestVersion: 4,
        sessions: [
          {
            id: "s1",
            dataRevision: 3,
            ownerIdentity: {
              userId: OWNER_USER_ID,
              organizationId: OWNER_ORGANIZATION_ID,
            },
            projections: {
              sessions: true,
              branches: 1,
              owner: 2,
              aggregate: 0,
            },
          },
        ],
        missingSourceFixtureIds: [FIXTURE_ID],
      })
    );
  });

  test("ISS-5466: rejects a manifest with no missing-source fixture ids", () => {
    const sessions = [
      {
        id: "s1",
        dataRevision: 3,
        ownerIdentity: {
          userId: OWNER_USER_ID,
          organizationId: OWNER_ORGANIZATION_ID,
        },
        projections: { sessions: 2, branches: 1, owner: 2, aggregate: 1 },
      },
    ];
    // Absent: a Phase A that predates or silently stopped injecting.
    assert.throws(() =>
      rehearsalManifestSchema.parse({
        rehearsalManifestVersion: 4,
        sessions,
      })
    );
    // Empty: injected nothing. Both must fail rather than pass vacuously.
    assert.throws(() =>
      rehearsalManifestSchema.parse({
        rehearsalManifestVersion: 4,
        sessions,
        missingSourceFixtureIds: [],
      })
    );
  });
});

describe("collectRehearsalViolations", () => {
  test("clean rebuild over a populated store yields no violations", () => {
    assert.deepEqual(violationsFor({}), []);
  });

  test("rebuild summary failures are flagged", () => {
    const violations = violationsFor({ errors: 2, parseErrors: 1 });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_SUMMARY_FAILURE);
  });

  test("unmatched sources are flagged: every corpus source must map to a session", () => {
    const violations = violationsFor({ unmatchedSource: 4 });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_UNMATCHED_SOURCE);
  });

  test("ISS-5466: a missingSource above the staged fixture count is flagged", () => {
    // Corpus sources are all present by construction, so 3 missing where one
    // fixture was staged means a real source-mapping regression took the
    // stored-row fallback and stamped corpus sessions anyway.
    const violations = violationsFor({ missingSource: 3 });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_MISSING_SOURCE_POPULATION);
    assert.match(violations[0], RE_MISSING_SOURCE);
    assert.match(violations[0], RE_EXPECTED_ONE);
  });

  test("ISS-5466: a missingSource BELOW the staged fixture count is flagged too", () => {
    // The direction that matters most: zero means the fixture never reached the
    // repair tail, so the bridge was never exercised and the lane proved nothing.
    const violations = violationsFor({ missingSource: 0 });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_MISSING_SOURCE_POPULATION);
    assert.match(violations[0], RE_EXPECTED_ONE);
  });

  test("a session left at the import-pending sentinel is flagged with its id", () => {
    const violations = violationsFor({
      postSessions: [
        session({ id: "s1" }),
        session({ id: "s2", dataRevision: PENDING_SENTINEL }),
      ],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_PENDING_SENTINEL);
    assert.match(violations[0], RE_SESSION_S2);
  });

  test("a session left below the current revision is flagged with its id", () => {
    const violations = violationsFor({
      postSessions: [session({ id: "s1", dataRevision: CURRENT_REVISION - 1 })],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_STALE_REVISION);
    assert.match(violations[0], RE_SESSION_S1);
  });

  test("a session that loses its invocation rows is flagged; one that never had them is not", () => {
    const manifest = manifestOf([
      session({ id: "had", dataRevision: 6 }),
      session({ id: "never-had", dataRevision: 6, sessions: 0 }),
    ]);
    const violations = violationsFor({
      manifest,
      postSessions: [
        session({ id: "had", sessions: 0 }),
        session({ id: "never-had", sessions: 0 }),
      ],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_LOSS_IN_SESSIONS);
    assert.match(violations[0], RE_LOST_INVOCATION_ROW);
    assert.match(violations[0], RE_SESSION_HAD);
    assert.doesNotMatch(violations[0], RE_SESSION_NEVER_HAD_LISTED);
  });

  test("PARTIAL invocation loss is flagged — an EXISTS probe would miss it", () => {
    const manifest = manifestOf([
      session({ id: "s1", dataRevision: 6, sessions: 52 }),
    ]);
    const violations = violationsFor({
      manifest,
      postSessions: [session({ id: "s1", sessions: 51 })],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_LOSS_IN_SESSIONS);
    assert.match(violations[0], RE_PARTIAL_INVOCATION_LOSS);
  });

  test("a rebuild that ADDS invocation rows is not a loss", () => {
    const manifest = manifestOf([
      session({ id: "s1", dataRevision: 6, sessions: 2 }),
    ]);
    assert.deepEqual(
      violationsFor({
        manifest,
        postSessions: [session({ id: "s1", sessions: 9 })],
      }),
      []
    );
  });

  test("a session that loses its analytics rows is flagged", () => {
    const violations = violationsFor({
      postSessions: [session({ id: "s1", aggregate: 0 })],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_LOSS_IN_AGGREGATE);
    assert.match(violations[0], RE_LOST_ANALYTICS_ROW);
  });

  test("a manifest session the rebuild deleted is flagged, not tolerated", () => {
    const manifest = manifestOf([
      session({ id: "kept", dataRevision: 6 }),
      session({ id: "deleted-session", dataRevision: 6 }),
    ]);
    const violations = violationsFor({
      manifest,
      postSessions: [session({ id: "kept" })],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_DISAPPEARED);
    // A disappearance is the absence of the record for every view at once, not
    // four per-view verdicts — it must not also be reported as four losses.
    assert.doesNotMatch(violations[0], RE_LOSS_IN_SESSIONS);
  });

  test("a manifest vacuous in EVERY view is flagged once per view", () => {
    const manifest = manifestOf(
      [
        session({
          id: "s1",
          dataRevision: 6,
          sessions: 0,
          branches: 0,
          owner: 0,
          aggregate: 0,
        }),
      ],
      { sessions: 0, branches: 0, owner: 0, aggregate: 0 }
    );
    const violations = violationsFor({
      manifest,
      postSessions: [
        session({
          id: "s1",
          sessions: 0,
          branches: 0,
          owner: 0,
          aggregate: 0,
        }),
      ],
      fixturePost: { sessions: 4, branches: 0, owner: 0, aggregate: 0 },
    });
    assert.equal(violations.length, 4);
    assert.match(violations[0], RE_VACUOUS_SESSIONS);
    assert.match(violations[1], RE_VACUOUS_BRANCHES);
    assert.match(violations[2], RE_VACUOUS_OWNER);
    assert.match(violations[3], RE_VACUOUS_AGGREGATE);
  });

  test("an empty post-rebuild store is flagged", () => {
    // `fixturePost: null` too — otherwise the ambient healthy fixture makes the
    // post-state non-empty and this asserts nothing about the empty-store branch.
    const violations = violationsFor({ postSessions: [], fixturePost: null });
    assert.match(violations.join("\n"), RE_ZERO_SESSIONS);
  });
});

describe("ISS-9284 per-view projection loss", () => {
  test("a rebuild that REMOVES A BRANCH is flagged, naming the branches view", () => {
    // The defect this ticket exists for: before per-view state, the manifest
    // carried no branch count at all, so this rebuild was indistinguishable
    // from a clean one.
    const manifest = manifestOf([
      session({ id: "s1", dataRevision: 6, branches: 2 }),
    ]);
    const violations = violationsFor({
      manifest,
      postSessions: [session({ id: "s1", branches: 1 })],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_LOSS_IN_BRANCHES);
    assert.match(violations[0], RE_LOST_BRANCH_LINK);
    assert.match(violations[0], RE_SESSION_S1);
    assert.match(violations[0], RE_BRANCH_PARTIAL_LOSS);
  });

  test("a rebuild that keeps every branch link is not a branch loss", () => {
    // The sibling positive for the assertion above: the same view, the opposite
    // state. Without it, a check that flagged EVERY session would also pass.
    const manifest = manifestOf([
      session({ id: "s1", dataRevision: 6, branches: 2 }),
    ]);
    assert.deepEqual(
      violationsFor({
        manifest,
        postSessions: [session({ id: "s1", branches: 2 })],
      }),
      []
    );
  });

  test("a rebuild that GAINS a branch link is not a loss", () => {
    const manifest = manifestOf([
      session({ id: "s1", dataRevision: 6, branches: 1 }),
    ]);
    assert.deepEqual(
      violationsFor({
        manifest,
        postSessions: [session({ id: "s1", branches: 4 })],
      }),
      []
    );
  });

  test("a rebuild that REMOVES AN OWNER is flagged, naming the owner view", () => {
    // A session blanked back to unowned falls out of every owner facet. The
    // pre-ISS-9284 manifest had no owner state, so this too read as clean.
    const manifest = manifestOf([
      session({ id: "s1", dataRevision: 6, owner: 2 }),
    ]);
    const violations = violationsFor({
      manifest,
      postSessions: [session({ id: "s1", owner: 0 })],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_LOSS_IN_OWNER);
    assert.match(violations[0], RE_LOST_OWNER_COLUMN);
    assert.match(violations[0], RE_SESSION_S1);
    assert.match(violations[0], RE_OWNER_BLANKED);
  });

  test("losing ONE of the two owner identity columns is flagged too", () => {
    // Partial owner loss: user_id survives, organization_id is blanked. A
    // boolean "is owned" probe would call this preserved.
    const manifest = manifestOf([
      session({ id: "s1", dataRevision: 6, owner: 2 }),
    ]);
    const violations = violationsFor({
      manifest,
      postSessions: [session({ id: "s1", owner: 1 })],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_LOSS_IN_OWNER);
  });

  test("a rebuild that keeps both owner identity columns is not an owner loss", () => {
    // Sibling positive for the two owner assertions above.
    const manifest = manifestOf([
      session({ id: "s1", dataRevision: 6, owner: 2 }),
    ]);
    assert.deepEqual(
      violationsFor({
        manifest,
        postSessions: [session({ id: "s1", owner: 2 })],
      }),
      []
    );
  });

  test("a record VALID for sessions and BROKEN for branches is reported as exactly that", () => {
    // AC 2, literally. The record must not be collapsed into one pass/fail, and
    // the views it came through intact must be named rather than left implied.
    const manifest = manifestOf([
      session({ id: "s1", dataRevision: 6, sessions: 9, branches: 2 }),
    ]);
    const violations = violationsFor({
      manifest,
      postSessions: [session({ id: "s1", sessions: 9, branches: 1 })],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_LOSS_IN_BRANCHES);
    assert.doesNotMatch(violations[0], RE_LOSS_IN_SESSIONS);
    assert.match(violations[0], RE_INTACT_FOR_THE_OTHER_THREE);
  });

  test("a record BROKEN for sessions and valid elsewhere names the other three too", () => {
    // The mirror of the branches case above, so the "intact for" wording is
    // asserted as a positive literal for a second view rather than only for the
    // one the ticket happened to name.
    const manifest = manifestOf([
      session({ id: "s1", dataRevision: 6, sessions: 9 }),
    ]);
    const violations = violationsFor({
      manifest,
      postSessions: [session({ id: "s1", sessions: 8 })],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_LOSS_IN_SESSIONS);
    assert.doesNotMatch(violations[0], RE_LOSS_IN_BRANCHES);
    assert.match(violations[0], RE_INTACT_FOR_ALL_BUT_SESSIONS);
  });

  test("a disappearance and a per-view loss on DIFFERENT sessions both surface", () => {
    // The two violation classes share one loop, with a `continue` for the
    // disappeared branch. Neither test in isolation proves they coexist without
    // the `continue` swallowing the other session's per-view verdict.
    const manifest = manifestOf([
      session({ id: "s1", dataRevision: 6, branches: 2 }),
      session({ id: "deleted-session", dataRevision: 6 }),
    ]);
    const violations = violationsFor({
      manifest,
      postSessions: [session({ id: "s1", branches: 0 })],
    });
    assert.equal(violations.length, 2);
    assert.match(violations[0], RE_DISAPPEARED);
    assert.match(violations[1], RE_LOSS_IN_BRANCHES);
    assert.match(violations[1], RE_SESSION_S1);
  });

  test("two views broken on the SAME session yield two violations, one per view", () => {
    // Never one merged verdict: each view has to be able to name its own loss.
    const manifest = manifestOf([
      session({ id: "s1", dataRevision: 6, branches: 3, owner: 2 }),
    ]);
    const violations = violationsFor({
      manifest,
      postSessions: [session({ id: "s1", branches: 0, owner: 0 })],
    });
    assert.equal(violations.length, 2);
    assert.match(violations[0], RE_LOSS_IN_BRANCHES);
    assert.match(violations[1], RE_LOSS_IN_OWNER);
    // Each names only the views that actually held for this record.
    assert.doesNotMatch(violations[0], RE_INTACT_FOR_THE_OTHER_THREE);
  });

  test("two sessions broken in DIFFERENT views are not conflated", () => {
    const manifest = manifestOf([
      session({ id: "s1", dataRevision: 6, branches: 2 }),
      session({ id: "s2", dataRevision: 6, owner: 2 }),
    ]);
    const violations = violationsFor({
      manifest,
      postSessions: [
        session({ id: "s1", branches: 0 }),
        session({ id: "s2", owner: 0 }),
      ],
    });
    assert.equal(violations.length, 2);
    assert.match(violations[0], RE_LOSS_IN_BRANCHES);
    assert.match(violations[0], RE_SESSION_S1);
    assert.doesNotMatch(violations[0], RE_SESSION_S2);
    assert.match(violations[1], RE_LOSS_IN_OWNER);
    assert.match(violations[1], RE_SESSION_S2);
    assert.match(violations[1], RE_INTACT_FOR_ALL_BUT_OWNER);
  });

  test("a store with no branch links at all flags ONLY the branches view as vacuous", () => {
    // Per-view vacuity: three populated views must not license a fourth that
    // can never fail. This is the state the frozen corpus was in for Owner.
    const manifest = manifestOf(
      [session({ id: "s1", dataRevision: 6, branches: 0 })],
      { branches: 0 }
    );
    const violations = violationsFor({
      manifest,
      postSessions: [session({ id: "s1", branches: 0 })],
      fixturePost: { sessions: 4, branches: 0 },
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_VACUOUS_BRANCHES);
  });

  test("a store with no owner identity at all flags ONLY the owner view as vacuous", () => {
    const manifest = manifestOf(
      [session({ id: "s1", dataRevision: 6, owner: 0 })],
      { owner: 0 }
    );
    const violations = violationsFor({
      manifest,
      postSessions: [session({ id: "s1", owner: 0 })],
      fixturePost: { sessions: 4, owner: 0 },
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_VACUOUS_OWNER);
  });
});

describe("ISS-5466 stored-row bridge positive control", () => {
  test("a fixture that gained invocation rows yields no violations", () => {
    assert.deepEqual(violationsFor({}), []);
  });

  test("a fixture still at zero invocation rows is flagged — the ISS-5098 shape", () => {
    const violations = violationsFor({ fixturePost: { sessions: 0 } });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_BRIDGE_NO_ROWS);
    assert.match(violations[0], RE_FIXTURE_ID);
  });

  test("a fixture that already had invocation rows is flagged as vacuous", () => {
    // Otherwise "has rows after" is true without the bridge doing anything.
    const violations = violationsFor({
      manifest: manifestOf([session({ id: "s1", dataRevision: 6 })], {
        sessions: 2,
      }),
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_BRIDGE_VACUOUS);
    assert.match(violations[0], RE_FIXTURE_ID);
  });

  test("a fixture id with no pre-state is flagged", () => {
    const violations = violationsFor({
      manifest: {
        rehearsalManifestVersion: 4,
        sessions: [session({ id: "s1", dataRevision: 6 })],
        missingSourceFixtureIds: [FIXTURE_ID],
      },
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_BRIDGE_ABSENT_PRE);
  });

  test("a fixture the rebuild deleted is flagged as a bridge failure, not just a disappearance", () => {
    const violations = violationsFor({ fixturePost: null });
    assert.match(violations.join("\n"), RE_BRIDGE_GONE);
  });
});

/**
 * PR #6728 review (whitlockk): a non-null COUNT cannot detect a SUBSTITUTION. Every
 * case here holds `projections.owner` at 2 on BOTH sides, so the count arm is
 * silent throughout and anything reported is the reattribution arm's doing.
 */
describe("PR #6728 owner reattribution", () => {
  test("a DIFFERENT non-null pair is flagged, though the count never moves", () => {
    const violations = violationsFor({
      manifest: manifestOf([
        session({ id: "s1", userId: "user-a", organizationId: "org-a" }),
      ]),
      postSessions: [
        session({ id: "s1", userId: "user-b", organizationId: "org-b" }),
      ],
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_OWNER_REATTRIBUTION);
    assert.match(violations[0], RE_REATTRIBUTED_USER);
    assert.match(violations[0], RE_REATTRIBUTED_ORG);
    // The count arm stayed silent — 2 non-null columns before and after — so
    // this violation is the pair's and not a relabelled loss.
    assert.doesNotMatch(violations[0], RE_LOSS_IN_OWNER);
  });

  test("names the ONE column that moved when only the org was rewritten", () => {
    const violations = violationsFor({
      manifest: manifestOf([session({ id: "s1", organizationId: "org-a" })]),
      postSessions: [session({ id: "s1", organizationId: "org-b" })],
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_REATTRIBUTED_ORG);
    assert.doesNotMatch(violations[0], RE_REATTRIBUTED_USER);
  });

  test("an unchanged pair is not a violation", () => {
    assert.deepEqual(
      violationsFor({
        manifest: manifestOf([session({ id: "s1", userId: "user-a" })]),
        postSessions: [session({ id: "s1", userId: "user-a" })],
      }),
      []
    );
  });

  test("blanking stays the COUNT arm's verdict, reported once and not twice", () => {
    // A nulled column is already `projection loss in view "owner"`. Reporting it
    // here too would make one regression read as two.
    const violations = violationsFor({
      manifest: manifestOf([session({ id: "s1", owner: 2 })]),
      postSessions: [
        session({ id: "s1", owner: 0, userId: null, organizationId: null }),
      ],
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_LOSS_IN_OWNER);
    assert.doesNotMatch(violations[0], RE_OWNER_REATTRIBUTION);
  });

  test("a null→non-null gain is not a loss", () => {
    // Nothing in the rebuild should invent an owner, but a gain costs the reader
    // nothing and is not what this arm adjudicates.
    assert.deepEqual(
      violationsFor({
        manifest: manifestOf([
          session({ id: "s1", owner: 0, userId: null, organizationId: null }),
        ]),
        postSessions: [
          session({ id: "s1", userId: "user-a", organizationId: "org-a" }),
        ],
      }),
      []
    );
  });

  test("a session that vanished is reported once, by the loss arm only", () => {
    const violations = violationsFor({
      manifest: manifestOf([session({ id: "s1", userId: "user-a" })]),
      postSessions: [],
    });

    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_DISAPPEARED);
    assert.doesNotMatch(violations[0], RE_OWNER_REATTRIBUTION);
  });
});

describe("ISS-5466 agentReferenceViolations", () => {
  test("both outcomes present yields no violations", () => {
    assert.deepEqual(
      agentReferenceViolations([
        {
          id: FIXTURE_ID,
          invocationsWithNullAgent: 1,
          invocationsWithAgent: 1,
        },
      ]),
      []
    );
  });

  test("no nulled reference is flagged: the ISS-5098 guard did not run", () => {
    const violations = agentReferenceViolations([
      { id: FIXTURE_ID, invocationsWithNullAgent: 0, invocationsWithAgent: 2 },
    ]);
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_REF_NO_NULLED);
  });

  test("no retained reference is flagged: the nulled check can no longer prove anything", () => {
    // The decay this exists to catch — a builder that stopped copying
    // `events.agent_id` nulls every reference, which would otherwise read as the
    // guard working perfectly.
    const violations = agentReferenceViolations([
      { id: FIXTURE_ID, invocationsWithNullAgent: 2, invocationsWithAgent: 0 },
    ]);
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_REF_NO_RETAINED);
  });

  test("a fixture with no invocation rows at all trips both", () => {
    assert.equal(
      agentReferenceViolations([
        {
          id: FIXTURE_ID,
          invocationsWithNullAgent: 0,
          invocationsWithAgent: 0,
        },
      ]).length,
      2
    );
  });
});
