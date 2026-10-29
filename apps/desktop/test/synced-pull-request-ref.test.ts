import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type {
  SqliteArtifactLinkRow,
  SqlitePullRequestLifecycleRow,
} from "../src/main/database/db-row-types.js";
import {
  boundedWireString,
  buildPullRequestArtifactRefFacts,
} from "../src/main/database/synced-pull-request-ref.js";

describe("synced pull-request reference facts", () => {
  test("bounds optional wire strings without trimming their stored value", () => {
    assert.equal(boundedWireString(null, 3), undefined);
    assert.equal(boundedWireString("", 3), undefined);
    assert.equal(boundedWireString("abc", 3), "abc");
    assert.equal(boundedWireString("abcd", 3), undefined);
    // Pins current behavior; whitespace is non-empty storage data, not normalized here.
    assert.equal(boundedWireString(" ", 3), " ");
  });

  test("projects title, closedAt and nothing derived from removed columns", () => {
    assert.deepEqual(
      buildPullRequestArtifactRefFacts(
        link({ title: "PR title" }),
        lifecycle({ closed_at: "2026-08-20T11:00:00.000Z" })
      ),
      { title: "PR title", closedAt: "2026-08-20T11:00:00.000Z" }
    );
  });

  // ISS-8175 AC-3. The base is optional in BOTH directions: a PR the desktop
  // opened carries it, and a row without one emits an object with NO `baseRef`
  // key at all — not `null`, which the cloud's omission-preserving ingest would
  // read as a real value. Asserted with deepEqual over the WHOLE fact object,
  // because a key-by-key check passes on a `baseRef: null` slip.
  test("carries a stored base ref and omits the key entirely without one", () => {
    const fullFacts = { title: "PR title" };
    const populated = link({ title: "PR title" });
    assert.deepEqual(
      buildPullRequestArtifactRefFacts(
        { ...populated, base_ref: "release/2026-08" },
        lifecycle()
      ),
      { ...fullFacts, baseRef: "release/2026-08" }
    );
    assert.deepEqual(
      buildPullRequestArtifactRefFacts(populated, lifecycle()),
      fullFacts
    );
    // Past the wire's own `.max(300)`: omitted here rather than sent to fail the
    // batch parse for every session in the tick.
    assert.deepEqual(
      buildPullRequestArtifactRefFacts(
        { ...populated, base_ref: "b".repeat(301) },
        lifecycle()
      ),
      fullFacts
    );
  });

  test("omits malformed and absent facts", () => {
    assert.deepEqual(
      buildPullRequestArtifactRefFacts(
        link({ title: "x".repeat(1025) }),
        lifecycle({ closed_at: "not-a-date" })
      ),
      {}
    );
    assert.deepEqual(buildPullRequestArtifactRefFacts(link(), undefined), {});
  });
});

function link(
  overrides: Partial<SqliteArtifactLinkRow> = {}
): SqliteArtifactLinkRow {
  return {
    session_id: "session-1",
    target_kind: "pull_request",
    slug: null,
    is_primary: false,
    method: "gh_pr_view",
    repo_full_name: "acme/web",
    pr_number: 1,
    url: null,
    relation: null,
    sha: null,
    title: null,
    branch_name: "feature/a",
    priority: null,
    link_observed_at: null,
    artifact_committed_at: null,
    artifact_observed_at: null,
    artifact_last_seen_at: null,
    base_ref: null,
    pr_opened_at: null,
    ...overrides,
  };
}

function lifecycle(
  overrides: Partial<SqlitePullRequestLifecycleRow> = {}
): SqlitePullRequestLifecycleRow {
  return {
    session_id: "session-1",
    pr_number: 1,
    repo_full_name: "acme/web",
    closed_at: null,
    ...overrides,
  };
}
