/**
 * @file rehearsal-verify-checks.test.ts
 * @description ISS-5104 — unit coverage for the pure Phase B decision logic of
 * the DATA_REVISION rebuild rehearsal (`scripts/rehearsal-verify-checks.ts`):
 * the tolerant manifest schema and every violation class the verify script can
 * report. Synthetic revision numbers are used throughout so this test does not
 * pin the live DATA_REVISION value.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  collectRehearsalViolations,
  type RehearsalManifest,
  type RehearsalSessionState,
  rehearsalManifestSchema,
} from "../scripts/rehearsal-verify-checks.js";

const CURRENT_REVISION = 7;
const PENDING_SENTINEL = -1;

// Hoisted per ultracite's useTopLevelRegex.
const RE_SUMMARY_FAILURE = /errors=2 parseErrors=1/;
const RE_SOURCE_RESOLUTION = /could not resolve sources/;
const RE_MISSING_SOURCE = /missingSource=3/;
const RE_UNMATCHED_SOURCE = /unmatchedSource=4/;
const RE_PENDING_SENTINEL = /DATA_REVISION_IMPORT_PENDING/;
const RE_SESSION_S1 = /s1/;
const RE_SESSION_S2 = /s2/;
const RE_STALE_REVISION = /stale data_revision/;
const RE_LOST_INVOCATIONS = /lost component-invocation rows/;
const RE_PARTIAL_INVOCATION_LOSS = /52→51/;
const RE_SESSION_HAD = /had/;
const RE_SESSION_NEVER_HAD_LISTED = /never-had,/;
const RE_LOST_ANALYTICS = /lost session_analytics rows/;
const RE_DISAPPEARED = /are gone after it/;
const RE_VACUOUS_INVOCATIONS = /invocation-preservation check would be vacuous/;
const RE_VACUOUS_ANALYTICS = /analytics-preservation check would be vacuous/;
const RE_ZERO_SESSIONS = /zero sessions/;

function session(
  overrides: Partial<RehearsalSessionState> & { id: string }
): RehearsalSessionState {
  return {
    dataRevision: CURRENT_REVISION,
    invocationCount: 3,
    analyticsCount: 1,
    ...overrides,
  };
}

function manifestOf(sessions: RehearsalSessionState[]): RehearsalManifest {
  return { rehearsalManifestVersion: 1, sessions };
}

function violationsFor(options: {
  manifest?: RehearsalManifest;
  postSessions?: RehearsalSessionState[];
  errors?: number;
  parseErrors?: number;
  missingSource?: number;
  unmatchedSource?: number;
}): string[] {
  const manifest =
    options.manifest ?? manifestOf([session({ id: "s1", dataRevision: 6 })]);
  return collectRehearsalViolations({
    manifest,
    postSessions: options.postSessions ?? [session({ id: "s1" })],
    outcome: {
      errors: options.errors ?? 0,
      parseErrors: options.parseErrors ?? 0,
      missingSource: options.missingSource ?? 0,
      unmatchedSource: options.unmatchedSource ?? 0,
    },
    currentRevision: CURRENT_REVISION,
    importPendingSentinel: PENDING_SENTINEL,
  });
}

describe("rehearsalManifestSchema", () => {
  test("accepts a manifest with unknown extra fields (version-skew tolerance)", () => {
    const parsed = rehearsalManifestSchema.parse({
      rehearsalManifestVersion: 1,
      sessions: [
        {
          id: "s1",
          dataRevision: 3,
          invocationCount: 2,
          analyticsCount: 0,
          futureField: "written by a newer build-store",
        },
      ],
      futureTopLevel: true,
    });
    assert.equal(parsed.sessions.length, 1);
    assert.equal(parsed.sessions[0].id, "s1");
  });

  test("rejects a manifest with zero sessions", () => {
    assert.throws(() =>
      rehearsalManifestSchema.parse({
        rehearsalManifestVersion: 1,
        sessions: [],
      })
    );
  });

  test("rejects a manifest whose projection fields are not counts", () => {
    assert.throws(() =>
      rehearsalManifestSchema.parse({
        rehearsalManifestVersion: 1,
        sessions: [
          {
            id: "s1",
            dataRevision: 3,
            invocationCount: true,
            analyticsCount: 0,
          },
        ],
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

  test("unresolved sources are flagged: every corpus source must be found", () => {
    const violations = violationsFor({ missingSource: 3, unmatchedSource: 4 });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_SOURCE_RESOLUTION);
    assert.match(violations[0], RE_MISSING_SOURCE);
    assert.match(violations[0], RE_UNMATCHED_SOURCE);
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
      session({ id: "never-had", dataRevision: 6, invocationCount: 0 }),
    ]);
    const violations = violationsFor({
      manifest,
      postSessions: [
        session({ id: "had", invocationCount: 0 }),
        session({ id: "never-had", invocationCount: 0 }),
      ],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_LOST_INVOCATIONS);
    assert.match(violations[0], RE_SESSION_HAD);
    assert.doesNotMatch(violations[0], RE_SESSION_NEVER_HAD_LISTED);
  });

  test("PARTIAL invocation loss is flagged — an EXISTS probe would miss it", () => {
    const manifest = manifestOf([
      session({ id: "s1", dataRevision: 6, invocationCount: 52 }),
    ]);
    const violations = violationsFor({
      manifest,
      postSessions: [session({ id: "s1", invocationCount: 51 })],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_LOST_INVOCATIONS);
    assert.match(violations[0], RE_PARTIAL_INVOCATION_LOSS);
  });

  test("a rebuild that ADDS invocation rows is not a loss", () => {
    const manifest = manifestOf([
      session({ id: "s1", dataRevision: 6, invocationCount: 2 }),
    ]);
    assert.deepEqual(
      violationsFor({
        manifest,
        postSessions: [session({ id: "s1", invocationCount: 9 })],
      }),
      []
    );
  });

  test("a session that loses its analytics rows is flagged", () => {
    const violations = violationsFor({
      postSessions: [session({ id: "s1", analyticsCount: 0 })],
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], RE_LOST_ANALYTICS);
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
  });

  test("a vacuous manifest (no invocations/analytics anywhere) is flagged", () => {
    const manifest = manifestOf([
      session({
        id: "s1",
        dataRevision: 6,
        invocationCount: 0,
        analyticsCount: 0,
      }),
    ]);
    const violations = violationsFor({
      manifest,
      postSessions: [
        session({ id: "s1", invocationCount: 0, analyticsCount: 0 }),
      ],
    });
    assert.equal(violations.length, 2);
    assert.match(violations[0], RE_VACUOUS_INVOCATIONS);
    assert.match(violations[1], RE_VACUOUS_ANALYTICS);
  });

  test("an empty post-rebuild store is flagged", () => {
    const violations = violationsFor({ postSessions: [] });
    assert.match(violations.join("\n"), RE_ZERO_SESSIONS);
  });
});
