import assert from "node:assert/strict";
import { DirectCollaboratorSource } from "@repo/api/src/types/artifact-collaborators";
import { BranchStatus, encodeBranchId } from "@repo/api/src/types/branch";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
} from "@repo/api/src/types/branch-identity";
import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import { describe, test } from "vitest";
import {
  type DesktopBranchLastActiveProjection,
  projectDesktopBranchLastActive,
} from "../src/main/branch/branch-last-active-projection.js";
import {
  branchIdsForLinks,
  completeArtifactLoc,
  projectBranchListItems,
} from "../src/main/branch/branch-list-projection.js";
import type {
  BranchLinkRow,
  BranchPrRow,
} from "../src/main/database/branch-reads.js";
import type { BranchTokenAggregateRow } from "../src/main/database/branch-token-aggregate-reads.js";

describe("Desktop Branch list projection", () => {
  test("deduplicates and sorts stable encoded branch ids", () => {
    assert.deepEqual(
      branchIdsForLinks([
        link({ repoFullName: "zeta/repo", branchName: "feature/z" }),
        link({ repoFullName: "acme/web", branchName: "feature/a" }),
        link({
          repoFullName: "zeta/repo",
          branchName: "feature/z",
          sessionId: "session-2",
        }),
      ]),
      [
        encodeBranchId({ repoFullName: "acme/web", branchName: "feature/a" }),
        encodeBranchId({ repoFullName: "zeta/repo", branchName: "feature/z" }),
      ].sort()
    );
  });

  test("accepts complete zero LOC and rejects any partial LOC", () => {
    assert.deepEqual(
      completeArtifactLoc({ linesAdded: 0, linesRemoved: 0, filesChanged: 0 }),
      { linesAdded: 0, linesRemoved: 0, filesChanged: 0 }
    );
    assert.equal(
      completeArtifactLoc({
        linesAdded: 1,
        linesRemoved: null,
        filesChanged: 1,
      }),
      null
    );
    // Only completeness is checked, so corrupt persisted counts pass through.
    assert.deepEqual(
      completeArtifactLoc({
        linesAdded: -1,
        linesRemoved: 1.5,
        filesChanged: Number.MAX_SAFE_INTEGER,
      }),
      {
        linesAdded: -1,
        linesRemoved: 1.5,
        filesChanged: Number.MAX_SAFE_INTEGER,
      }
    );
  });

  // ISS-9456: the local store has no cloud Branch artifact, so the key stays
  // off the row. An artifact-keyed read (Related Sessions) keys on it and must
  // find it missing here, never present with a local stand-in.
  test("emits rows with no artifactId key", () => {
    const rows = projectBranchListItems(
      [link({ repoFullName: "acme/web", branchName: "feature/a" })],
      [],
      [],
      new Map() as DesktopBranchLastActiveProjection
    );

    assert.equal(rows.length, 1);
    assert.equal(Object.hasOwn(rows[0] ?? {}, "artifactId"), false);
  });

  test("marks every local Branch collaborator source unavailable", () => {
    const rows = projectBranchListItems(
      [link({ repoFullName: "acme/web", branchName: "feature/a" })],
      [],
      [],
      new Map() as DesktopBranchLastActiveProjection
    );

    assert.deepEqual(rows[0]?.collaborators, {
      availability: BranchIdentityAvailability.Unavailable,
      people: [],
      sources: {
        [DirectCollaboratorSource.Creator]:
          BranchIdentityAvailability.Unavailable,
        [DirectCollaboratorSource.Interactions]:
          BranchIdentityAvailability.Unavailable,
        [DirectCollaboratorSource.Comments]:
          BranchIdentityAvailability.Unavailable,
        [BranchCollaboratorSource.PullRequestAuthors]:
          BranchIdentityAvailability.Unavailable,
        [BranchCollaboratorSource.Pushes]:
          BranchIdentityAvailability.Unavailable,
        [BranchCollaboratorSource.PullRequestComments]:
          BranchIdentityAvailability.Unavailable,
        [BranchCollaboratorSource.BranchComments]:
          BranchIdentityAvailability.Unavailable,
        [BranchCollaboratorSource.SessionComments]:
          BranchIdentityAvailability.Unavailable,
      },
    });
  });

  test("groups sessions, fills LOC, costs, PR status, and canonical activity", () => {
    const branchA = { repoFullName: "acme/web", branchName: "feature/a" };
    const branchB = { repoFullName: "acme/web", branchName: "feature/b" };
    const branchAId = encodeBranchId(branchA);
    const branchBId = encodeBranchId(branchB);
    const rows = projectBranchListItems(
      [
        link({ ...branchA, sessionId: "session-2" }),
        link({
          ...branchA,
          sessionId: "session-1",
          linesAdded: 10,
          linesRemoved: 2,
          filesChanged: 3,
        }),
        link({ ...branchB, sessionId: "session-3" }),
      ],
      [
        pullRequest({
          ...branchA,
          prNumber: 7,
          state: "open",
          linesAdded: 99,
          linesRemoved: 99,
          filesChanged: 99,
        }),
        pullRequest({
          ...branchB,
          prNumber: 8,
          state: "merged",
          mergedAt: "2026-08-19T00:00:00.000Z",
          linesAdded: 20,
          linesRemoved: 4,
          filesChanged: 5,
        }),
      ],
      [
        tokenRow({ ...branchA, rawCostUsdEstimated: 3, costUsdEstimated: 1.5 }),
        tokenRow({ ...branchA, model: "model-b" }),
      ],
      new Map([
        [
          branchAId,
          {
            value: "2026-08-20T10:00:00.000Z",
            state: BranchMetricAvailability.Partial,
            disclosure: BranchMetricDisclosure.DefaultIncomplete,
          },
        ],
        [
          branchBId,
          {
            value: "2026-08-19T10:00:00.000Z",
            state: BranchMetricAvailability.Partial,
            disclosure: BranchMetricDisclosure.DefaultIncomplete,
          },
        ],
      ]) as DesktopBranchLastActiveProjection
    );

    assert.deepEqual(
      rows.map((row) => row.branchName),
      ["feature/a", "feature/b"]
    );
    assert.deepEqual(rows[0]?.sessionIds, ["session-1", "session-2"]);
    assert.equal(rows[0]?.status, BranchStatus.Open);
    assert.equal(rows[0]?.prNumber, 7);
    assert.equal(rows[0]?.additions, 10);
    assert.equal(rows[0]?.deletions, 2);
    assert.equal(rows[0]?.filesChanged, 3);
    assert.equal(rows[0]?.estimatedCostUsd, 3);
    assert.equal(rows[0]?.attributedCostUsd, 1.5);
    assert.equal(rows[0]?.lastActivityAt, "2026-08-20T10:00:00.000Z");
    assert.equal(rows[1]?.status, BranchStatus.Merged);
    assert.equal(rows[1]?.additions, 20);
    assert.equal(rows[1]?.deletions, 4);
    assert.equal(rows[1]?.filesChanged, 5);
    assert.equal(rows[1]?.estimatedCostUsd, null);
  });

  test("sorts branches without usable activity by normalized branch identity", () => {
    const acme = { repoFullName: "ACME/Web", branchName: "feature/b" };
    const zeta = { repoFullName: "zeta/repo", branchName: "feature/a" };
    const zetaId = encodeBranchId(zeta);
    // The malformed timestamp enters through the producer boundary that can
    // actually emit one — a persisted SQLite activity row — rather than a
    // hand-built projection value. `calculateBranchLastActiveMetric` discards
    // an unparseable instant, so a projection carrying a raw corrupt string is
    // a state production never reaches.
    const lastActiveByBranch = projectDesktopBranchLastActive(
      [encodeBranchId(acme), zetaId],
      [
        {
          ...zeta,
          sourceEventId: "activity-1",
          occurredAt: "not-a-date",
          completeness: BranchActivityEvidenceCompleteness.Complete,
        },
      ],
      [],
      []
    );
    const rows = projectBranchListItems(
      [link(zeta), link(acme)],
      [],
      [],
      lastActiveByBranch
    );

    assert.equal(
      lastActiveByBranch.get(zetaId)?.state,
      BranchMetricAvailability.Unavailable
    );
    assert.deepEqual(
      rows.map((row) => row.repoFullName),
      ["ACME/Web", "zeta/repo"]
    );
    assert.equal(rows[0]?.lastActivityAt, "");
    assert.equal(rows[1]?.lastActivityAt, "");
  });

  test("forwards corrupt persisted LOC counts to the Branch row", () => {
    // Pins current behavior, and it looks wrong: `completeArtifactLoc` is a
    // completeness gate, not a value screen. `boundedNonNegativeInt` screens
    // the persisted count at the sync and PR-ref writers, but neither
    // `mapBranchLinkRows` nor `mapBranchPrRawRows` applies it, so a negative,
    // fractional, or int4-overflowing stored count becomes user-visible LOC
    // unchanged. Flagged by whitlockk on PR #5520; ISS-7347 is coverage-only, so
    // the guard is not moved here — this assertion is the tripwire.
    const branch = { repoFullName: "acme/web", branchName: "feature/a" };
    const rows = projectBranchListItems(
      [
        link({
          ...branch,
          linesAdded: -1,
          linesRemoved: 1.5,
          filesChanged: Number.MAX_SAFE_INTEGER,
        }),
      ],
      [],
      [],
      projectDesktopBranchLastActive([encodeBranchId(branch)], [], [], [])
    );

    assert.equal(rows[0]?.additions, -1);
    assert.equal(rows[0]?.deletions, 1.5);
    assert.equal(rows[0]?.filesChanged, Number.MAX_SAFE_INTEGER);
  });

  /**
   * ISS-9585 (whitlockk, PR #7954): the identity tie-break this projection falls to
   * when no row carries a canonical Last-active instant. The ordering suite this
   * PR added drives `shared-branches-window.ts` only, so nothing reached the
   * comparator here and reverting it — or replacing it outright — stayed green.
   *
   * Each fixture's collated order is the REVERSE of its UTF-16 order, so the arm
   * reds if it is re-ranked by code unit (the `C` collation the SQL mirror names
   * for identifiers). It does not pin the ruling's locale half: `Collated` and a
   * bare `localeCompare()` agree on an `en` runner, and `Intl` resolves its
   * default locale once at startup, so no in-process stub separates them.
   */
  test("collates the repository tie-break when no row has a canonical instant", () => {
    // Normalized lowercase, so case cannot discriminate here. Collated ranks
    // "ä" at the primary weight of "a", so "acme/ärger" leads; by code unit
    // 0xe4 is last, giving beta, zeta, ärger.
    const rows = projectBranchListItems(
      [
        link({ repoFullName: "acme/zeta", branchName: "feature/a" }),
        link({ repoFullName: "acme/ärger", branchName: "feature/a" }),
        link({ repoFullName: "acme/beta", branchName: "feature/a" }),
      ],
      [],
      [],
      new Map()
    );

    assert.deepEqual(
      rows.map((item) => item.repoFullName),
      ["acme/ärger", "acme/beta", "acme/zeta"]
    );
  });

  test("collates the branch-name tie-break within one repository", () => {
    // By code unit this is Beta, Zeta, alpha: every uppercase letter precedes
    // every lowercase one.
    const rows = projectBranchListItems(
      [
        link({ branchName: "Zeta" }),
        link({ branchName: "alpha" }),
        link({ branchName: "Beta" }),
      ],
      [],
      [],
      new Map()
    );

    assert.deepEqual(
      rows.map((item) => item.branchName),
      ["alpha", "Beta", "Zeta"]
    );
  });
});

function link(overrides: Partial<BranchLinkRow> = {}): BranchLinkRow {
  return {
    repoFullName: "acme/web",
    branchName: "feature/a",
    sessionId: "session-1",
    sessionName: null,
    isPrimary: true,
    observedAt: "2026-08-20T00:00:00.000Z",
    activityAt: "2026-08-20T00:00:00.000Z",
    linesAdded: null,
    linesRemoved: null,
    filesChanged: null,
    ownerUserId: null,
    priority: null,
    ...overrides,
  };
}

function pullRequest(overrides: Partial<BranchPrRow> = {}): BranchPrRow {
  return {
    repoFullName: "acme/web",
    branchName: "feature/a",
    prNumber: 1,
    prUrl: "https://github.com/acme/web/pull/1",
    title: "PR 1",
    state: "open",
    isDraft: false,
    mergedAt: null,
    closedAt: null,
    openedAt: "2026-08-20T00:00:00.000Z",
    observedAt: "2026-08-20T00:01:00.000Z",
    linesAdded: null,
    linesRemoved: null,
    filesChanged: null,
    ...overrides,
  };
}

function tokenRow(
  overrides: Partial<BranchTokenAggregateRow> = {}
): BranchTokenAggregateRow {
  return {
    repoFullName: "acme/web",
    branchName: "feature/a",
    model: "model-a",
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    rawCostUsdEstimated: null,
    costUsdEstimated: null,
    ...overrides,
  };
}
