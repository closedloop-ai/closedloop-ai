/**
 * @file sync-source-ref-caps.test.ts
 * @description The desktop sync source bounds a session's `artifactRefs` at the
 * desktop PRODUCER cap `MAX_SYNCED_ARTIFACT_REFS_PRODUCER` (100) before emitting
 * (FEA-2711, ISS-4448+4449). `prRefs`, and the legacy `prs` field derived from
 * the same PR rows, are emitted IN FULL: ISS-9859 removed their 100-ref producer
 * cap (approved 2026-09-10), and the chunker paginates `prRefs` when one payload
 * cannot carry them. This test drives the real SQLite → `loadSyncedSessions`
 * boundary.
 *
 * T-10.9 / ISS-6884 — `components[]` is the one array here that is NOT sliced.
 * Its MAX_SESSION_COMPONENT_USAGE bound is the cloud's PER-PAYLOAD wire cap, and
 * applying it as a population cap permanently stranded every row past it (the
 * read is deterministic and the local usage table has no sync cursor). The reader
 * now emits the whole set and `chunkOversizedSession` paginates it across sync
 * parts; only a single (kind,key) group whose own branch rows exceed one payload
 * is still dropped, because a partially-sent group would make the cloud prune
 * delete the branches it omits.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_SYNCED_COMPONENT_USAGE } from "@repo/api/src/types/agent-session";
import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
} from "@repo/api/src/types/session-artifact-link";
import { test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

// A session cwd of NULL short-circuits attribution resolution, so empty maps
// suffice — these assertions are about ref-array bounds, not attribution.
function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

// Artifact links overshoot their producer cap. PR links overshoot the retired
// 100-ref cap, so a reinstated slice fails the full-emission assertions.
const OVERSIZED_ARTIFACTS = MAX_SYNCED_ARTIFACT_REFS_PRODUCER + 50;
const OVERSIZED_PRS = 150;

/**
 * Seed one session with more links than either cap allows:
 *   - OVERSIZED_ARTIFACTS `closedloop_artifact` links (each → one `artifactRefs`)
 *   - OVERSIZED_PRS `pull_request` links (each → one `prRefs` entry)
 */
async function seedOversizedSession(db: {
  run(sql: string, ...params: unknown[]): Promise<void>;
}): Promise<void> {
  await db.run("INSERT INTO sessions (id, status) VALUES ('busy','completed')");

  for (let i = 0; i < OVERSIZED_ARTIFACTS; i++) {
    // A closedloop artifact ref: kind + slug drive the `artifactRefs` branch.
    await db.run(
      `INSERT INTO artifacts (id, identity_key, kind, slug, created_at, last_seen_at)
       VALUES (?, ?, 'closedloop_artifact', ?, 't1', 't1')`,
      `art-cl-${i}`,
      `closedloop_artifact:${i}`,
      `PRD-${i}`
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
       VALUES (?, 'busy', ?, 'created', 'url_match', '{}', 1, 't1', ?)`,
      `l-cl-${i}`,
      `art-cl-${i}`,
      // created_at drives the ORDER BY the slice keeps; zero-pad for stable order.
      `t-cl-${String(i).padStart(4, "0")}`
    );
  }

  for (let i = 0; i < OVERSIZED_PRS; i++) {
    // A pull_request ref: repo_full_name + pr_number + url drive `prRefs`.
    await db.run(
      `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, pr_number, url, created_at, last_seen_at)
       VALUES (?, ?, 'pull_request', 'acme/repo', ?, ?, 't1', 't1')`,
      `art-pr-${i}`,
      `pull_request:${i}`,
      i + 1,
      `https://github.com/acme/repo/pull/${i + 1}`
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
       VALUES (?, 'busy', ?, 'created', 'url_match', '{}', 1, 't1', ?)`,
      `l-pr-${i}`,
      `art-pr-${i}`,
      `t-pr-${String(i).padStart(4, "0")}`
    );
  }
}

// ---------------------------------------------------------------------------
// T-10.9 — components[] cap (MAX_SESSION_COMPONENT_USAGE = 500)
// ---------------------------------------------------------------------------

// ISS-6884: the shared constant, not a hand-copied 500 — the reader now treats
// it as a PER-PAYLOAD bound the chunker honors, so the two must not drift.
const MAX_SESSION_COMPONENT_USAGE = MAX_SYNCED_COMPONENT_USAGE;
const OVERSIZED_COMPONENTS = MAX_SESSION_COMPONENT_USAGE + 100;

test("ISS-6884: a components[] set past the per-payload cap is emitted in full", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6884-comp-full-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      // Seed a single session and flood it with usage rows beyond the cap.
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('comp-sess','completed')"
      );
      for (let i = 0; i < OVERSIZED_COMPONENTS; i++) {
        // component_key is unique per row (PK is session_id + kind + key).
        await db.run(
          `INSERT INTO agent_component_session_usage
             (session_id, component_kind, component_key, invocations, error_count)
           VALUES ('comp-sess', 'tool', ?, 1, 0)`,
          `tool-${String(i).padStart(4, "0")}`
        );
      }

      const [session] = await db.syncSource.loadSyncedSessions(
        ["comp-sess"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      assert.ok(
        Array.isArray(session.components),
        "components[] must be present for an oversized session"
      );
      // ISS-6884 — DELIBERATE BEHAVIOR CHANGE. This test previously asserted the
      // set was sliced to the first MAX_SESSION_COMPONENT_USAGE rows. That
      // expectation encoded the defect: the read is deterministic and the local
      // usage table carries no sync cursor, so the same subset was re-sent on
      // every resend and the rows beyond it never reached the cloud at ALL. The
      // 500 bound is the cloud's PER-PAYLOAD wire cap, and it is now honored by
      // `chunkOversizedSession` paginating the set across sync parts (see
      // agent-session-sync-component-usage-chunking.test.ts). The reader emits
      // the whole population.
      assert.equal(
        session.components?.length,
        OVERSIZED_COMPONENTS,
        "every local usage row is emitted — the payload cap is not a population cap"
      );
      const emittedKeys = new Set(
        session.components?.map((usage) => usage.componentKey)
      );
      assert.equal(
        emittedKeys.size,
        OVERSIZED_COMPONENTS,
        "each component_key is emitted exactly once"
      );
      assert.ok(
        emittedKeys.has(
          `tool-${String(OVERSIZED_COMPONENTS - 1).padStart(4, "0")}`
        ),
        "including the last key, which the old prefix slice stranded permanently"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3029: the reader never emits a partial (kind,key) branch group", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3029-comp-groups-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('comp-sess','completed')"
      );
      // A leading multi-branch group that fits under the cap: its 3 branch rows
      // must survive whole.
      const FITTING_GROUP_KEY = "tool-0000";
      const FITTING_GROUP_BRANCHES = 3;
      for (let b = 0; b < FITTING_GROUP_BRANCHES; b++) {
        await db.run(
          `INSERT INTO agent_component_session_usage
             (session_id, component_kind, component_key, git_branch, invocations, error_count)
           VALUES ('comp-sess', 'tool', ?, ?, 1, 0)`,
          FITTING_GROUP_KEY,
          `feat/branch-${b}`
        );
      }
      // Fill exactly up to the cap with single-branch groups, so the next group
      // straddles the MAX_SESSION_COMPONENT_USAGE boundary.
      const SINGLE_GROUPS =
        MAX_SESSION_COMPONENT_USAGE - FITTING_GROUP_BRANCHES;
      for (let i = 1; i <= SINGLE_GROUPS; i++) {
        await db.run(
          `INSERT INTO agent_component_session_usage
             (session_id, component_kind, component_key, invocations, error_count)
           VALUES ('comp-sess', 'tool', ?, 1, 0)`,
          `tool-${String(i).padStart(4, "0")}`
        );
      }
      // A group whose rows straddle the per-payload cap boundary. It must be
      // emitted WHOLE (ISS-6884 — the chunker, not the reader, decides which
      // sync part carries it), never split into a partial branch set.
      const STRADDLE_GROUP_KEY = `tool-${String(SINGLE_GROUPS + 1).padStart(4, "0")}`;
      const STRADDLE_GROUP_BRANCHES = 4;
      for (let b = 0; b < STRADDLE_GROUP_BRANCHES; b++) {
        await db.run(
          `INSERT INTO agent_component_session_usage
             (session_id, component_kind, component_key, git_branch, invocations, error_count)
           VALUES ('comp-sess', 'tool', ?, ?, 1, 0)`,
          STRADDLE_GROUP_KEY,
          `feat/straddle-${b}`
        );
      }

      const [session] = await db.syncSource.loadSyncedSessions(
        ["comp-sess"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      const components = session.components ?? [];

      // Tally emitted branch rows per (kind,key) group.
      const emittedByKey = new Map<string, number>();
      for (const usage of components) {
        emittedByKey.set(
          usage.componentKey,
          (emittedByKey.get(usage.componentKey) ?? 0) + 1
        );
      }

      // The fitting leading group survives with all of its branches.
      assert.equal(
        emittedByKey.get(FITTING_GROUP_KEY),
        FITTING_GROUP_BRANCHES,
        "a multi-branch group under the cap is kept whole"
      );
      // ISS-6884 — DELIBERATE BEHAVIOR CHANGE. This previously asserted the
      // straddling group was DROPPED, because the reader applied the per-payload
      // cap as a population cap and a straddling group could not be sent whole
      // within it. It is now emitted whole and the chunker places it in a part of
      // its own; what stays fixed — and is what FEA-3029 actually protects — is
      // that a group is never emitted PARTIALLY, because the cloud prune treats a
      // present group's branch set as authoritative and deletes the rest.
      assert.equal(
        emittedByKey.get(STRADDLE_GROUP_KEY),
        STRADDLE_GROUP_BRANCHES,
        "the boundary-straddling group is emitted whole, not split and not dropped"
      );
      // No group is emitted with fewer branches than the DB holds for it: every
      // group is all-or-nothing. Here every emitted group has exactly its full
      // branch count.
      for (const [key, count] of emittedByKey) {
        let expected = 1;
        if (key === FITTING_GROUP_KEY) {
          expected = FITTING_GROUP_BRANCHES;
        } else if (key === STRADDLE_GROUP_KEY) {
          expected = STRADDLE_GROUP_BRANCHES;
        }
        assert.equal(
          count,
          expected,
          `group ${key} is emitted with its full branch set (no partial group)`
        );
      }
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3029: a single group larger than the cap is dropped whole, never emitted oversized", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3029-comp-oversize-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  // ISS-6884: this drop is now the ONLY component-usage loss left in the reader,
  // and it is permanent — the read is deterministic and the table has no cursor.
  // It must therefore be reported, not silent, like the activity-tiling overflow
  // beside it.
  const logged: string[] = [];
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      log: (message: string) => logged.push(message),
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('comp-sess','completed')"
      );
      // One (kind,key) group whose branch rows alone exceed the cap. It cannot
      // be sent whole without overflowing the cloud's max-500 array validation
      // (which rejects the entire batch), so it must be dropped entirely — the
      // `components` key is omitted rather than sliced into a partial group.
      const OVERSIZED_GROUP_BRANCHES = MAX_SESSION_COMPONENT_USAGE + 10;
      for (let b = 0; b < OVERSIZED_GROUP_BRANCHES; b++) {
        await db.run(
          `INSERT INTO agent_component_session_usage
             (session_id, component_kind, component_key, git_branch, invocations, error_count)
           VALUES ('comp-sess', 'tool', 'tool-solo', ?, 1, 0)`,
          `feat/branch-${String(b).padStart(4, "0")}`
        );
      }

      const [session] = await db.syncSource.loadSyncedSessions(
        ["comp-sess"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      // Omitted entirely (undefined), never an oversized or partial array.
      assert.equal(
        session.components,
        undefined,
        "an over-cap single group omits components rather than emitting a partial/oversized array"
      );
      assert.ok(
        logged.some(
          (message) =>
            message.includes("tool-solo") && message.includes("DROPPING")
        ),
        "the permanent drop is reported, never a silent cloud undercount"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3029: an over-cap group does not starve later groups that still fit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3029-comp-skip-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('comp-sess','completed')"
      );
      // A leading group whose branch rows alone exceed the cap. It sorts first
      // (component_key ASC), so a `break` on the first over-budget group would
      // drop the whole payload and permanently starve the small group after it.
      const OVER_CAP_KEY = "tool-aaa";
      const OVER_CAP_BRANCHES = MAX_SESSION_COMPONENT_USAGE + 10;
      for (let b = 0; b < OVER_CAP_BRANCHES; b++) {
        await db.run(
          `INSERT INTO agent_component_session_usage
             (session_id, component_kind, component_key, git_branch, invocations, error_count)
           VALUES ('comp-sess', 'tool', ?, ?, 1, 0)`,
          OVER_CAP_KEY,
          `feat/branch-${String(b).padStart(4, "0")}`
        );
      }
      // A tiny group ordered after the over-cap one. It comfortably fits within
      // the (still-empty) budget and must be synced, not starved.
      const FITTING_KEY = "tool-bbb";
      await db.run(
        `INSERT INTO agent_component_session_usage
           (session_id, component_kind, component_key, invocations, error_count)
         VALUES ('comp-sess', 'tool', ?, 1, 0)`,
        FITTING_KEY
      );

      const [session] = await db.syncSource.loadSyncedSessions(
        ["comp-sess"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      const components = session.components ?? [];
      const emittedKeys = new Set(
        components.map((usage) => usage.componentKey)
      );
      // The over-cap group is dropped whole, never emitted oversized/partial.
      assert.ok(
        !emittedKeys.has(OVER_CAP_KEY),
        "the over-cap group is dropped whole"
      );
      // The small later group survives — it is not starved by the earlier drop.
      assert.ok(
        emittedKeys.has(FITTING_KEY),
        "a later group that fits is synced even after an earlier over-cap group"
      );
      assert.ok(
        components.length <= MAX_SESSION_COMPONENT_USAGE,
        "components[] stays within the shared cap"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-9859: prRefs and prs are emitted in full; artifactRefs keep the producer cap", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2711-ref-caps-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await seedOversizedSession(db);

      const [session] = await db.syncSource.loadSyncedSessions(
        ["busy"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");

      assert.equal(
        session.artifactRefs?.length,
        MAX_SYNCED_ARTIFACT_REFS_PRODUCER,
        "artifactRefs sliced to the desktop producer cap"
      );
      // `prRefs` is an OPTIONAL wire field (an older peer may omit it), so
      // prove this producer actually populated it before measuring the cap.
      const { prRefs } = session;
      if (!prRefs) {
        throw new Error("expected the hydrated session to carry prRefs");
      }
      // ISS-9859 — DELIBERATE BEHAVIOR CHANGE. This asserted both PR arrays
      // were sliced to the 100-ref producer cap (ISS-4445), so a session's
      // 101st PR never reached the cloud. Tamsin approved removing that shim
      // on 2026-09-10: no deployed cloud since 2026-08-27 caps the count, and
      // the chunker paginates prRefs when a split cannot carry them whole.
      assert.equal(prRefs.length, OVERSIZED_PRS, "every PR ref is emitted");
      assert.equal(
        session.prs?.length,
        OVERSIZED_PRS,
        "every legacy prs entry is emitted"
      );

      // Links are ordered oldest-first, so the slice keeps the earliest N.
      const first = session.artifactRefs?.[0];
      assert.ok(first, "artifactRefs is non-empty");
      if (first.kind === "closedloop_artifact") {
        assert.equal(
          first.slug,
          "PRD-0",
          "artifactRefs keeps the earliest links"
        );
      } else {
        assert.fail(`unexpected first ref kind: ${first.kind}`);
      }

      // The old cap kept the earliest 100 by pr_number, so the newest PRs were
      // the ones lost. Both ends must now arrive, on both arrays.
      const prNums = new Set(session.prs?.map((pr) => pr.num));
      assert.ok(prNums.has(1), "prs keeps the earliest PR (#1)");
      assert.ok(prNums.has(OVERSIZED_PRS), "prs keeps the newest PR");
      assert.ok(
        prRefs.some((ref) => ref.prNumber === OVERSIZED_PRS),
        "prRefs keeps the newest PR"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3585: a `reviewed` PR link syncs as relationType REVIEWED (URL and bare number)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3585-reviewed-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('rev','completed')"
      );
      // Reviewed PR named by URL — carries a url.
      await db.run(
        `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, pr_number, url, created_at, last_seen_at)
         VALUES ('a-rev-url', 'pull_request:2990', 'pull_request', 'acme/repo', 2990, 'https://github.com/acme/repo/pull/2990', 't1', 't1')`
      );
      await db.run(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
         VALUES ('l-rev-url', 'rev', 'a-rev-url', 'reviewed', 'pr_review_command', '{}', 16, 't1', 't-1')`
      );
      await db.run(
        `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, pr_number, url, created_at, last_seen_at)
         VALUES ('a-feedback', 'pull_request:2992', 'pull_request', 'acme/repo', 2992, 'https://github.com/acme/repo/pull/2992', 't1', 't1')`
      );
      await db.run(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
         VALUES ('l-feedback', 'rev', 'a-feedback', 'reviewed', ?, '{}', 20, '2026-07-10T12:00:00.000Z', 't-1b')`,
        ArtifactRefMethod.PrReviewFeedbackCommand
      );
      // Reviewed PR named by bare number — NO url (the #2990-not-linked shape).
      await db.run(
        `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, pr_number, created_at, last_seen_at)
         VALUES ('a-rev-num', 'pull_request:2991', 'pull_request', 'acme/repo', 2991, 't1', 't1')`
      );
      await db.run(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
         VALUES ('l-rev-num', 'rev', 'a-rev-num', 'reviewed', 'pr_review_command', '{}', 16, 't1', 't-2')`
      );

      const [session] = await db.syncSource.loadSyncedSessions(
        ["rev"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");

      // `prRefs` is an OPTIONAL wire field; prove the producer emitted it
      // rather than indexing into a possibly-absent array.
      const { prRefs } = session;
      if (!prRefs) {
        throw new Error("expected the hydrated session to carry prRefs");
      }
      const byNumber = new Map(prRefs.map((r) => [r.prNumber, r]));
      assert.equal(
        byNumber.get(2990)?.relationType,
        "REVIEWED",
        "URL-named reviewed PR maps to REVIEWED"
      );
      // A bare-number review has no local url but must still sync (the cloud
      // derives the canonical prUrl); its relationType is REVIEWED.
      const bareNum = byNumber.get(2991);
      assert.ok(
        bareNum,
        "bare-number reviewed PR is synced even without a url"
      );
      assert.equal(bareNum?.relationType, "REVIEWED");
      assert.equal(
        byNumber.get(2990)?.branchLifecycleEvents?.[0]?.kind,
        BranchLifecycleBoundaryKind.ReadOnlyReference,
        "read-only PR review refs are not feedback evidence"
      );
      assert.equal(
        byNumber.get(2992)?.branchLifecycleEvents?.[0]?.kind,
        BranchLifecycleBoundaryKind.ReviewFeedback,
        "feedback write PR refs carry review-feedback evidence"
      );
      assert.equal(
        byNumber.get(2992)?.branchLifecycleEvents?.[0]?.observedAt,
        "2026-07-10T12:00:00.000Z",
        "feedback write lifecycle events keep the artifact-link event time"
      );

      // The reviewed PRs also ride the fact-carrying artifactRef with the same
      // relation so the cloud can surface a review state.
      const reviewedArtifactRef = session.artifactRefs?.find(
        (r) => r.kind === "pull_request" && r.prNumber === 2990
      );
      assert.equal(
        reviewedArtifactRef?.kind === "pull_request"
          ? reviewedArtifactRef.relation
          : undefined,
        "reviewed"
      );
      const feedbackArtifactRef = session.artifactRefs?.find(
        (r) => r.kind === "pull_request" && r.prNumber === 2992
      );
      assert.equal(
        feedbackArtifactRef?.kind === "pull_request"
          ? feedbackArtifactRef.branchLifecycleEvents?.[0]?.kind
          : undefined,
        BranchLifecycleBoundaryKind.ReviewFeedback
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
