import assert from "node:assert/strict";
import { test } from "vitest";
import { getSharedBranches } from "../src/main/branch/shared-branches-api.js";
import {
  denominatorEligibleBranchKeys,
  eligibleBranchKeys,
  filterEligibleBranchRows,
  resolveBranchProductEligibilitySnapshot,
} from "../src/main/branch/shared-branches-default-eligibility.js";
import {
  readBranchSessionTokenRowsForBranch,
  readBranchTokenAggregateRows,
  readLocalBranchLinkRows,
} from "../src/main/database/branch-reads.js";
import { AC_T1, seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";

const repoFullName = "acme/web";

test("denominator keys share the Product publication gate (ISS-8148)", () => {
  const published = candidate("feature/published", true);
  const commitOnly = candidate("feature/commit-only", false);
  const defaultBranch = candidate("main", true);
  const rows = [published, commitOnly, defaultBranch];
  const snapshot = resolveBranchProductEligibilitySnapshot(rows);

  // Desktop holds no repository-default authority, so a published `main` is
  // not excluded here; the cloud owns that verdict.
  assert.deepEqual(eligibleBranchKeys(rows, snapshot), [
    published,
    defaultBranch,
  ]);
  // ISS-8148 (PRD-683 Ruling 2 + D7): the divisor population shares the
  // Product publication gate — a decisively-unpublished commit-only branch no
  // longer holds a divisor key, matching the cloud's
  // `cloudBranchMetricDenominatorEligibilitySql`. The key set stays a
  // separate field so the two can diverge deliberately, never by drift.
  const denominatorKeys = [
    { repoFullName, branchName: published.branchName },
    { repoFullName, branchName: defaultBranch.branchName },
  ];
  assert.deepEqual(denominatorEligibleBranchKeys(snapshot), denominatorKeys);
  assert.deepEqual(
    filterEligibleBranchRows(rows, snapshot).map((row) => row.branchName),
    ["feature/published", "main"]
  );
  assert.equal(snapshot.coverageComplete, false);
});

test("a commit-only Branch leaves both the list and the publication-gated divisor", () =>
  withAcDb(async (db) => {
    const seed = seeder(db);
    const sessionId = "shared-session";
    const published = candidate("feature/published", true);
    await seed.session(sessionId);
    await seed.tokens(sessionId, 100);
    await db.run(
      "UPDATE token_usage SET cost_usd_estimated = 2 WHERE session_id = $1",
      sessionId
    );

    const publishedArtifact = await seed.branch({
      branch: published.branchName,
      repo: repoFullName,
    });
    const commitOnlyArtifact = await seed.branch({
      branch: "feature/commit-only",
      repo: repoFullName,
    });
    await seed.link({
      session: sessionId,
      artifactId: publishedArtifact,
      method: "git_push",
    });
    await seed.link({
      session: sessionId,
      artifactId: commitOnlyArtifact,
      method: "git_commit",
    });

    const source = {
      prisma: db.prisma,
      readBranchCanonicalActivityRows: db.readBranchCanonicalActivityRows,
      readBranchMetricEventEvidence: db.readBranchMetricEventEvidence,
      syncSource: db.syncSource,
    };
    const list = await getSharedBranches(source, {});

    assert.deepEqual(
      list.items.map((item) => item.branchName),
      ["feature/published"]
    );
    // ISS-8148 (PRD-683 D7): the commit-only branch is decisively unpublished
    // so it leaves the divisor and the session splits over ONE
    // publication-gated branch.
    assert.deepEqual(list.sessionBranchCount, { [sessionId]: 1 });

    const rawRows = await readLocalBranchLinkRows(db.prisma);
    assert.deepEqual(
      rawRows.map((row) => [row.branchName, row.hasLocalPublication]).sort(),
      [
        ["feature/commit-only", false],
        ["feature/published", true],
      ]
    );
    const snapshot = resolveBranchProductEligibilitySnapshot(rawRows);
    const visibleKeys = eligibleBranchKeys(rawRows, snapshot);
    const denominatorKeys = denominatorEligibleBranchKeys(snapshot);
    const aggregate = await readBranchTokenAggregateRows(
      db.prisma,
      visibleKeys,
      denominatorKeys
    );
    const sessionRows = await readBranchSessionTokenRowsForBranch(
      db.prisma,
      visibleKeys[0]!,
      denominatorKeys
    );

    assert.equal(aggregate.length, 1);
    assert.equal(aggregate[0]?.branchName, "feature/published");
    assert.equal(aggregate[0]?.inputTokens, 100);
    assert.equal(sessionRows[0]?.branchCount, 1);
    assert.equal(sessionRows[0]?.evenSplitCostUsd, 2);
    assert.equal(
      rawRows.find((row) => row.branchName === "feature/commit-only")
        ?.hasLocalPublication,
      false
    );

    await seed.markPushed(commitOnlyArtifact, AC_T1);
    const afterPublicationRows = await readLocalBranchLinkRows(db.prisma);
    assert.equal(
      afterPublicationRows.find(
        (row) => row.branchName === "feature/commit-only"
      )?.hasLocalPublication,
      true
    );
  }));

test("publication order is irrelevant and never substitutes for active Wrote", () =>
  withAcDb(async (db) => {
    const seed = seeder(db);
    const sessionId = "evidence-order-session";
    await seed.session(sessionId);
    const source = {
      prisma: db.prisma,
      readBranchCanonicalActivityRows: db.readBranchCanonicalActivityRows,
      readBranchMetricEventEvidence: db.readBranchMetricEventEvidence,
      syncSource: db.syncSource,
    };

    const pushFirst = candidate("feature/push-first", true);
    const pushFirstArtifact = await seed.branch({
      branch: pushFirst.branchName,
      repo: repoFullName,
      firstPushedAt: AC_T1,
    });
    assert.deepEqual(
      (await getSharedBranches(source, {})).items,
      [],
      "publication without Wrote remains outside the Product candidate corpus"
    );
    await seed.link({
      session: sessionId,
      artifactId: pushFirstArtifact,
      method: "git_commit",
    });
    assert.deepEqual(
      (await getSharedBranches(source, {})).items.map(
        (item) => item.branchName
      ),
      [pushFirst.branchName]
    );

    const wroteFirst = candidate("feature/wrote-first", false);
    const wroteFirstArtifact = await seed.branch({
      branch: wroteFirst.branchName,
      repo: repoFullName,
    });
    await seed.link({
      session: sessionId,
      artifactId: wroteFirstArtifact,
      method: "git_commit",
    });
    assert.deepEqual(
      (await getSharedBranches(source, {})).items.map(
        (item) => item.branchName
      ),
      [pushFirst.branchName],
      "Wrote without publication remains Product-ineligible"
    );
  }));

test("Branch rows, head SHAs, and non-Wrote links cannot enter Product membership", () =>
  withAcDb(async (db) => {
    const seed = seeder(db);
    const sessionId = "non-wrote-session";
    await seed.session(sessionId);
    const branchArtifact = await seed.branch({
      branch: "feature/head-only",
      repo: repoFullName,
    });
    await seed.link({
      session: sessionId,
      artifactId: branchArtifact,
      method: "git_checkout",
    });
    const source = {
      prisma: db.prisma,
      readBranchCanonicalActivityRows: db.readBranchCanonicalActivityRows,
      readBranchMetricEventEvidence: db.readBranchMetricEventEvidence,
      syncSource: db.syncSource,
    };

    assert.deepEqual(await readLocalBranchLinkRows(db.prisma), []);
    assert.deepEqual((await getSharedBranches(source, {})).items, []);
  }));

function candidate(branchName: string, hasLocalPublication: boolean) {
  return { repoFullName, branchName, hasLocalPublication };
}
