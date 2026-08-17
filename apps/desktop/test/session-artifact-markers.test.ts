/**
 * @file session-artifact-markers.test.ts
 * @description FEA-2060 real-boundary coverage for deriving desktop session
 * timeline markers from canonical local artifact links.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type {
  SessionMarker,
  SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  type BackfillResult,
  backfillArtifactLinksFromTranscripts,
  touchSessionsWithArtifactMarkerLinks,
} from "../src/main/collectors/parsing/artifact-link-backfill.js";
import { runArtifactLinkBackfillRuntimeBoundary } from "../src/main/collectors/parsing/artifact-link-backfill-runtime-boundary.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

type TestDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

test("FEA-2060: created commit links produce markers and non-created commit links fail closed", async () => {
  await withTestDb(async (db) => {
    await seedSession(db, "commit-created");
    await seedSession(db, "commit-referenced");
    await seedTimelineEvents(db, "commit-created");
    await seedCommitArtifact(db, {
      id: "commit-artifact",
      sha: "abc123456789",
      title: "Implement marker helper",
      committedAt: "2026-06-22T10:04:00.000Z",
      observedAt: "2026-06-22T10:05:00.000Z",
      lastSeenAt: "2026-06-22T10:06:00.000Z",
    });
    await linkArtifact(db, {
      id: "commit-created-link",
      sessionId: "commit-created",
      artifactId: "commit-artifact",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:03:00.000Z",
    });
    await linkArtifact(db, {
      id: "commit-referenced-link",
      sessionId: "commit-referenced",
      artifactId: "commit-artifact",
      relation: "referenced",
      method: "url_match",
      observedAt: "2026-06-22T10:03:00.000Z",
    });

    const byId = await loadById(db, ["commit-created", "commit-referenced"]);
    const marker = onlyMarkerOfKind(
      byId.get("commit-created")?.markers,
      "commit"
    );
    assert.equal(marker.label, "Implement marker helper");
    // FEA-3329: the AUTHORITATIVE committed_at (10:04) wins over the shared
    // per-import ingest link observed_at (10:03). The session span is
    // 10:00 -> ended_at 10:05, so a 10:04 commit sits at x=80%.
    assert.equal(marker.t, "2026-06-22T10:04:00.000Z");
    assert.equal(marker.tl, 1);
    assert.equal(marker.x, 80);
    assert.equal(
      byId
        .get("commit-referenced")
        ?.markers?.some((item) => item.kind === "commit") ?? false,
      false
    );
  });
});

test("FEA-2060: created and workspace PR links produce markers while referenced PRs do not", async () => {
  await withTestDb(async (db) => {
    for (const sessionId of ["pr-created", "pr-workspace", "pr-referenced"]) {
      await seedSession(db, sessionId);
      await seedTimelineEvents(db, sessionId);
    }
    await seedPullRequestArtifact(db, {
      id: "pr-artifact",
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 2060,
      title: "Capture artifact timeline markers",
      observedAt: "2026-06-22T10:02:00.000Z",
      lastSeenAt: "2026-06-22T10:09:00.000Z",
    });
    await linkArtifact(db, {
      id: "pr-created-link",
      sessionId: "pr-created",
      artifactId: "pr-artifact",
      relation: "created",
      method: "pr_create_output",
      observedAt: "2026-06-22T10:04:00.000Z",
    });
    await linkArtifact(db, {
      id: "pr-workspace-link",
      sessionId: "pr-workspace",
      artifactId: "pr-artifact",
      relation: "workspace",
      method: "branch_pr_association",
      observedAt: "not-a-date",
    });
    await linkArtifact(db, {
      id: "pr-referenced-link",
      sessionId: "pr-referenced",
      artifactId: "pr-artifact",
      relation: "referenced",
      method: "normalized_pr",
      observedAt: "2026-06-22T10:04:00.000Z",
    });

    const byId = await loadById(db, [
      "pr-created",
      "pr-workspace",
      "pr-referenced",
    ]);
    assert.equal(
      onlyMarkerOfKind(byId.get("pr-created")?.markers, "pr").label,
      "PR #2060 opened: Capture artifact timeline markers"
    );
    const workspaceMarker = onlyMarkerOfKind(
      byId.get("pr-workspace")?.markers,
      "pr"
    );
    // FEA-3594: no pr_opened_at → falls back to sessionEndMs (last real
    // activity, 10:05 from seedTimelineEvents), not artifact_observed_at (10:02).
    assert.equal(workspaceMarker.t, "2026-06-22T10:05:00.000Z");
    assert.equal(workspaceMarker.tl, 2);
    assert.equal(
      byId.get("pr-referenced")?.markers?.some((item) => item.kind === "pr") ??
        false,
      false
    );
  });
});

test("FEA-2060: timestamp fallbacks and malformed rows follow the marker contract", async () => {
  await withTestDb(async (db) => {
    for (const sessionId of [
      "commit-link",
      "commit-committed",
      "commit-observed",
      "commit-last-seen",
      "pr-observed",
      "pr-last-seen",
      "malformed",
    ]) {
      await seedSession(db, sessionId);
      await seedTimelineEvents(db, sessionId);
    }
    await seedCommitArtifact(db, {
      id: "fallback-commit",
      sha: "fallback12345",
      title: null,
      committedAt: "2026-06-22T10:02:00.000Z",
      observedAt: "2026-06-22T10:04:00.000Z",
      lastSeenAt: "2026-06-22T10:06:00.000Z",
    });
    await seedCommitArtifact(db, {
      id: "malformed-commit",
      sha: "malformed123",
      title: null,
      committedAt: "bad-committed",
      observedAt: "bad-observed",
      lastSeenAt: "bad-last-seen",
    });
    await seedPullRequestArtifact(db, {
      id: "fallback-pr",
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 2061,
      title: null,
      observedAt: "2026-06-22T10:07:00.000Z",
      lastSeenAt: "2026-06-22T10:08:00.000Z",
    });
    await seedPullRequestArtifact(db, {
      id: "last-seen-pr",
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 2062,
      title: null,
      observedAt: null,
      lastSeenAt: "2026-06-22T10:09:00.000Z",
    });

    await linkArtifact(db, {
      id: "commit-link-link",
      sessionId: "commit-link",
      artifactId: "fallback-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:01:00.000Z",
    });
    await linkArtifact(db, {
      id: "commit-committed-link",
      sessionId: "commit-committed",
      artifactId: "fallback-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "bad-link",
    });
    await seedCommitArtifact(db, {
      id: "observed-only-commit",
      sha: "observed12345",
      title: null,
      committedAt: null,
      observedAt: "2026-06-22T10:04:00.000Z",
      lastSeenAt: "2026-06-22T10:06:00.000Z",
    });
    await linkArtifact(db, {
      id: "commit-observed-link",
      sessionId: "commit-observed",
      artifactId: "observed-only-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "bad-link",
    });
    await seedCommitArtifact(db, {
      id: "last-seen-commit",
      sha: "lastseen12345",
      title: null,
      committedAt: null,
      observedAt: null,
      lastSeenAt: "2026-06-22T10:06:00.000Z",
    });
    await linkArtifact(db, {
      id: "commit-last-seen-link",
      sessionId: "commit-last-seen",
      artifactId: "last-seen-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "bad-link",
    });
    await linkArtifact(db, {
      id: "pr-observed-link",
      sessionId: "pr-observed",
      artifactId: "fallback-pr",
      relation: "created",
      method: "pr_create_output",
      observedAt: "bad-link",
    });
    await linkArtifact(db, {
      id: "pr-last-seen-link",
      sessionId: "pr-last-seen",
      artifactId: "last-seen-pr",
      relation: "created",
      method: "pr_create_output",
      observedAt: "bad-link",
    });
    await linkArtifact(db, {
      id: "malformed-link",
      sessionId: "malformed",
      artifactId: "malformed-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "bad-link",
    });

    const byId = await loadById(db, [
      "commit-link",
      "commit-committed",
      "commit-observed",
      "commit-last-seen",
      "pr-observed",
      "pr-last-seen",
      "malformed",
    ]);
    // FEA-3329: committed_at (10:02) now wins over the link observed_at (10:01);
    // both `commit-link` and `commit-committed` share `fallback-commit`
    // (committed_at 10:02), so both resolve to the real commit time.
    assert.equal(
      onlyMarkerOfKind(byId.get("commit-link")?.markers, "commit").t,
      "2026-06-22T10:02:00.000Z"
    );
    assert.equal(
      onlyMarkerOfKind(byId.get("commit-committed")?.markers, "commit").t,
      "2026-06-22T10:02:00.000Z"
    );
    assert.equal(
      onlyMarkerOfKind(byId.get("commit-observed")?.markers, "commit").t,
      "2026-06-22T10:06:00.000Z"
    );
    assert.equal(
      onlyMarkerOfKind(byId.get("commit-last-seen")?.markers, "commit").t,
      "2026-06-22T10:06:00.000Z"
    );
    // FEA-3594: no pr_opened_at → falls back to sessionEndMs (last real
    // activity, 10:05 from seedTimelineEvents) for both PR cases, regardless
    // of what artifact_observed_at / artifact_last_seen_at contain.
    assert.equal(
      onlyMarkerOfKind(byId.get("pr-observed")?.markers, "pr").t,
      "2026-06-22T10:05:00.000Z"
    );
    assert.equal(
      onlyMarkerOfKind(byId.get("pr-last-seen")?.markers, "pr").t,
      "2026-06-22T10:05:00.000Z"
    );
    assert.equal(
      byId
        .get("malformed")
        ?.markers?.some((marker) => marker.kind === "commit") ?? false,
      false
    );
  });
});

test("FEA-2060: artifact marker anchoring handles ties, after-last, and missing events", async () => {
  await withTestDb(async (db) => {
    for (const sessionId of ["tie", "after-last", "no-events"]) {
      await seedSession(db, sessionId);
    }
    await seedSession(db, "metadata-shift", {
      messages: [
        {
          role: "human",
          timestamp: "2026-06-22T10:00:30.000Z",
          text: "start",
        },
      ],
    });
    await seedTimelineEvents(db, "tie");
    await seedTimelineEvents(db, "after-last");
    await seedTimelineEvents(db, "metadata-shift");
    await seedCommitArtifact(db, {
      id: "tie-commit",
      sha: "tie123456789",
      title: null,
      committedAt: null,
      observedAt: null,
      lastSeenAt: "2026-06-22T10:02:00.000Z",
    });
    await seedCommitArtifact(db, {
      id: "after-commit",
      sha: "after1234567",
      title: null,
      committedAt: null,
      observedAt: null,
      lastSeenAt: "2026-06-22T10:11:00.000Z",
    });
    await seedCommitArtifact(db, {
      id: "no-events-commit",
      sha: "noevents123",
      title: null,
      committedAt: null,
      observedAt: null,
      lastSeenAt: "2026-06-22T10:05:00.000Z",
    });
    await seedCommitArtifact(db, {
      id: "metadata-shift-commit",
      sha: "metashift123",
      title: null,
      committedAt: null,
      observedAt: null,
      lastSeenAt: "2026-06-22T10:03:00.000Z",
    });
    await linkArtifact(db, {
      id: "tie-link",
      sessionId: "tie",
      artifactId: "tie-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:02:00.000Z",
    });
    await linkArtifact(db, {
      id: "after-link",
      sessionId: "after-last",
      artifactId: "after-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:11:00.000Z",
    });
    await linkArtifact(db, {
      id: "no-events-link",
      sessionId: "no-events",
      artifactId: "no-events-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:05:00.000Z",
    });
    await linkArtifact(db, {
      id: "metadata-shift-link",
      sessionId: "metadata-shift",
      artifactId: "metadata-shift-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:03:00.000Z",
    });

    const byId = await loadById(db, [
      "tie",
      "after-last",
      "no-events",
      "metadata-shift",
    ]);
    assert.equal(onlyMarkerOfKind(byId.get("tie")?.markers, "commit").tl, 0);
    assert.equal(
      onlyMarkerOfKind(byId.get("after-last")?.markers, "commit").tl,
      2
    );
    assert.equal(
      onlyMarkerOfKind(byId.get("after-last")?.markers, "commit").x,
      100
    );
    assert.equal(
      onlyMarkerOfKind(byId.get("no-events")?.markers, "commit").tl,
      0
    );
    assert.equal(
      onlyMarkerOfKind(byId.get("no-events")?.markers, "commit").label,
      "noevent"
    );
    assert.equal(
      onlyMarkerOfKind(byId.get("metadata-shift")?.markers, "commit").tl,
      2
    );
  });
});

test("FEA-2060: trace markers are preserved and equivalent artifact markers are deduped", async () => {
  await withTestDb(async (db) => {
    await seedSession(db, "trace-only", {
      messages: [{ role: "human", timestamp: "2026-06-22T10:00:30.000Z" }],
    });
    await seedSession(db, "mixed", {
      messages: [{ role: "human", timestamp: "2026-06-22T10:00:30.000Z" }],
    });
    await seedSession(db, "dedupe");
    await seedSession(db, "mixed-order", {
      messages: [{ role: "human", timestamp: "2026-06-22T10:04:00.000Z" }],
    });
    await seedTimelineEvents(db, "mixed");
    await seedTimelineEvents(db, "mixed-order");
    await db.run(
      `INSERT INTO events (id, session_id, event_type, summary, created_at)
       VALUES ('dedupe-event','dedupe','git_commit','git commit -m Implement marker helper','2026-06-22T10:03:00.000Z')`
    );
    await seedCommitArtifact(db, {
      id: "mixed-commit",
      sha: "mixed123456",
      title: "Mixed artifact marker",
      committedAt: null,
      observedAt: null,
      lastSeenAt: "2026-06-22T10:03:00.000Z",
    });
    await seedCommitArtifact(db, {
      id: "dedupe-commit",
      sha: "dedupe12345",
      title: "Implement marker helper",
      committedAt: null,
      observedAt: null,
      lastSeenAt: "2026-06-22T10:03:00.000Z",
    });
    await seedCommitArtifact(db, {
      id: "mixed-order-commit",
      sha: "order123456",
      title: "Earlier artifact marker",
      committedAt: null,
      observedAt: null,
      lastSeenAt: "2026-06-22T10:01:00.000Z",
    });
    await linkArtifact(db, {
      id: "mixed-link",
      sessionId: "mixed",
      artifactId: "mixed-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:03:00.000Z",
    });
    await linkArtifact(db, {
      id: "dedupe-link",
      sessionId: "dedupe",
      artifactId: "dedupe-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:03:00.000Z",
    });
    await linkArtifact(db, {
      id: "mixed-order-link",
      sessionId: "mixed-order",
      artifactId: "mixed-order-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:01:00.000Z",
    });

    const byId = await loadById(db, [
      "trace-only",
      "mixed",
      "dedupe",
      "mixed-order",
    ]);
    assert.equal(
      onlyMarkerOfKind(byId.get("trace-only")?.markers, "prompt").label,
      "Prompt"
    );
    assert.ok(onlyMarkerOfKind(byId.get("mixed")?.markers, "prompt"));
    assert.ok(onlyMarkerOfKind(byId.get("mixed")?.markers, "commit"));
    assert.equal(
      byId.get("dedupe")?.markers?.filter((marker) => marker.kind === "commit")
        .length,
      1
    );
    assert.equal(
      onlyMarkerOfKind(byId.get("dedupe")?.markers, "commit").label,
      "git commit -m Implement marker helper"
    );
    assert.deepEqual(
      (byId.get("mixed-order")?.markers ?? []).map((marker) => marker.tl),
      [0, 2]
    );
  });
});

test("FEA-2060: marker-touch maintenance notices later qualifying links after a sentinel", async () => {
  await withTestDb(async (db) => {
    await seedSession(db, "later-link", undefined, "2026-06-01T10:00:00.000Z");
    await seedCommitArtifact(db, {
      id: "later-first-commit",
      sha: "laterfirst1",
      title: "First marker",
      committedAt: null,
      observedAt: null,
      lastSeenAt: "2026-06-22T10:03:00.000Z",
    });
    await linkArtifact(db, {
      id: "later-first-link",
      sessionId: "later-link",
      artifactId: "later-first-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:03:00.000Z",
    });

    assert.deepEqual(
      await touchSessionsWithArtifactMarkerLinks(
        db.prisma,
        "2026-06-22T10:20:00.000Z"
      ),
      ["later-link"]
    );
    assert.equal(
      await sessionUpdatedAt(db, "later-link"),
      "2026-06-22T10:20:00.000Z"
    );
    assert.deepEqual(
      await touchSessionsWithArtifactMarkerLinks(
        db.prisma,
        "2026-06-22T10:21:00.000Z"
      ),
      []
    );

    await seedCommitArtifact(db, {
      id: "later-second-commit",
      sha: "latersecond",
      title: "Second marker",
      committedAt: null,
      observedAt: null,
      lastSeenAt: "2026-06-22T10:05:00.000Z",
    });
    await linkArtifact(db, {
      id: "later-second-link",
      sessionId: "later-link",
      artifactId: "later-second-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:05:00.000Z",
    });

    assert.deepEqual(
      await touchSessionsWithArtifactMarkerLinks(
        db.prisma,
        "2026-06-22T10:22:00.000Z"
      ),
      ["later-link"]
    );
    assert.equal(
      await sessionUpdatedAt(db, "later-link"),
      "2026-06-22T10:22:00.000Z"
    );
  });
});

test("FEA-2060: marker-touch maintenance canonicalizes multi-link marker state", async () => {
  await withTestDb(async (db) => {
    await seedSession(
      db,
      "ordered-links",
      undefined,
      "2026-06-01T10:00:00.000Z"
    );
    await seedCommitArtifact(db, {
      id: "ordered-first-commit",
      sha: "orderedfirst",
      title: "First marker",
      committedAt: null,
      observedAt: null,
      lastSeenAt: "2026-06-22T10:03:00.000Z",
    });
    await seedCommitArtifact(db, {
      id: "ordered-second-commit",
      sha: "orderedsecond",
      title: "Second marker",
      committedAt: null,
      observedAt: null,
      lastSeenAt: "2026-06-22T10:05:00.000Z",
    });
    await linkArtifact(db, {
      id: "ordered-first-link",
      sessionId: "ordered-links",
      artifactId: "ordered-first-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:03:00.000Z",
    });
    await linkArtifact(db, {
      id: "ordered-second-link",
      sessionId: "ordered-links",
      artifactId: "ordered-second-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:05:00.000Z",
    });

    assert.deepEqual(
      await touchSessionsWithArtifactMarkerLinks(
        db.prisma,
        "2026-06-22T10:20:00.000Z"
      ),
      ["ordered-links"]
    );

    await seedSession(
      db,
      "reverse-links",
      undefined,
      "2026-06-01T10:00:00.000Z"
    );
    await linkArtifact(db, {
      id: "reverse-second-link",
      sessionId: "reverse-links",
      artifactId: "ordered-second-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:05:00.000Z",
    });
    await linkArtifact(db, {
      id: "reverse-first-link",
      sessionId: "reverse-links",
      artifactId: "ordered-first-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:03:00.000Z",
    });
    const orderedSourceKey = await markerSyncStateKey(db, "ordered-links");
    await db.run(
      `INSERT INTO sync_state
         (source_key, observed_top_updated_at, observed_ids_at_top_updated_at, data_revision, updated_at)
       VALUES ($1, $2, $3, $4, $5)`,
      orderedSourceKey.replace("ordered-links:", "reverse-links:"),
      "2026-06-22T10:20:00.000Z",
      "[]",
      1,
      "2026-06-22T10:20:00.000Z"
    );

    assert.deepEqual(
      await touchSessionsWithArtifactMarkerLinks(
        db.prisma,
        "2026-06-22T10:21:00.000Z"
      ),
      []
    );
  });
});

test("FEA-2060: marker-touch maintenance is SQL-only, durable, and idempotent", async () => {
  await withTestDb(async (db) => {
    await seedSession(db, "historical", undefined, "2026-06-01T10:00:00.000Z");
    await seedCommitArtifact(db, {
      id: "historical-commit",
      sha: "history12345",
      title: "Historical marker",
      committedAt: null,
      observedAt: "2026-06-22T10:04:00.000Z",
      lastSeenAt: "2026-06-22T10:05:00.000Z",
    });
    await linkArtifact(db, {
      id: "historical-link",
      sessionId: "historical",
      artifactId: "historical-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:03:00.000Z",
    });

    const first = await backfillArtifactLinksFromTranscripts(db.prisma, {
      listTranscriptFiles: () => [],
    });
    assert.equal(first.captured, 0);
    assert.equal(first.touchedForMarkers, 1);
    assert.deepEqual(first.touchedForMarkerSessionIds, ["historical"]);
    assert.notEqual(
      await sessionUpdatedAt(db, "historical"),
      "2026-06-01T10:00:00.000Z"
    );

    const updatedAfterFirstRun = await sessionUpdatedAt(db, "historical");
    const second = await backfillArtifactLinksFromTranscripts(db.prisma, {
      listTranscriptFiles: () => [],
    });
    assert.equal(second.touchedForMarkers, 0);
    assert.deepEqual(second.touchedForMarkerSessionIds, []);
    assert.equal(
      await sessionUpdatedAt(db, "historical"),
      updatedAfterFirstRun
    );
  });
});

test("FEA-2060: marker-touch maintenance is bounded and cancellation-safe", async () => {
  await withTestDb(async (db) => {
    await seedCommitArtifact(db, {
      id: "bounded-commit",
      sha: "bounded12345",
      title: "Bounded marker",
      committedAt: null,
      observedAt: "2026-06-22T10:04:00.000Z",
      lastSeenAt: "2026-06-22T10:05:00.000Z",
    });
    for (let index = 0; index < 501; index++) {
      const sessionId = `bounded-${String(index).padStart(3, "0")}`;
      await seedSession(db, sessionId, undefined, "2026-06-01T10:00:00.000Z");
      await linkArtifact(db, {
        id: `${sessionId}-link`,
        sessionId,
        artifactId: "bounded-commit",
        relation: "created",
        method: "commit_output",
        observedAt: "2026-06-22T10:03:00.000Z",
      });
    }

    const paused: number[] = [];
    const first = await backfillArtifactLinksFromTranscripts(db.prisma, {
      listTranscriptFiles: () => [],
      cooperativeDelay: (ms) => {
        paused.push(ms);
        return Promise.resolve();
      },
    });
    assert.equal(first.touchedForMarkers, 500);
    assert.equal(first.touchedForMarkerSessionIds.length, 500);
    assert.equal(first.touchedForMarkerSessionIds[0], "bounded-000");
    assert.equal(first.touchedForMarkerSessionIds.at(-1), "bounded-499");
    assert.equal(paused.length, 5);

    const second = await backfillArtifactLinksFromTranscripts(db.prisma, {
      listTranscriptFiles: () => [],
    });
    assert.equal(second.touchedForMarkers, 1);
    assert.deepEqual(second.touchedForMarkerSessionIds, ["bounded-500"]);

    const cancelled = await backfillArtifactLinksFromTranscripts(db.prisma, {
      listTranscriptFiles: () => [],
      shouldContinue: () => false,
    });
    assert.equal(cancelled.touchedForMarkers, 0);
    assert.deepEqual(cancelled.touchedForMarkerSessionIds, []);

    await seedSession(
      db,
      "cancel-after-commit",
      undefined,
      "2026-06-01T10:00:00.000Z"
    );
    await linkArtifact(db, {
      id: "cancel-after-commit-link",
      sessionId: "cancel-after-commit",
      artifactId: "bounded-commit",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:03:00.000Z",
    });
    let continueAfterBatch = true;
    const cancelledAfterCommit = await backfillArtifactLinksFromTranscripts(
      db.prisma,
      {
        listTranscriptFiles: () => [],
        cooperativeDelay: () => {
          continueAfterBatch = false;
          return Promise.resolve();
        },
        shouldContinue: () => continueAfterBatch,
      }
    );
    assert.equal(cancelledAfterCommit.touchedForMarkers, 1);
    assert.deepEqual(cancelledAfterCommit.touchedForMarkerSessionIds, [
      "cancel-after-commit",
    ]);
  });
});

test("FEA-2060: runtime store-op backfill summaries invalidate marker projections", async () => {
  const markerOnly = await runRuntimeBackfillBoundaryCase({
    captured: 0,
    touchedForMarkers: 1,
  });
  assert.deepEqual(markerOnly.storeOps, ["artifactLinks.backfill"]);
  assert.deepEqual(markerOnly.sentMessages, [["desktop:db:changed", {}]]);

  const capturedOnly = await runRuntimeBackfillBoundaryCase({
    captured: 1,
    touchedForMarkers: 0,
  });
  assert.deepEqual(capturedOnly.storeOps, ["artifactLinks.backfill"]);
  assert.deepEqual(capturedOnly.sentMessages, [["desktop:db:changed", {}]]);

  const unchanged = await runRuntimeBackfillBoundaryCase({
    captured: 0,
    touchedForMarkers: 0,
  });
  assert.deepEqual(unchanged.storeOps, ["artifactLinks.backfill"]);
  assert.deepEqual(unchanged.sentMessages, []);
});

// FEA-2986: marker `label` is sourced from free text (commit/PR titles, tool
// names, event summaries) with no upstream bound, but the cloud caps it at
// `sessionMarkerSchema.label.max(SESSION_TRACE_SOURCE_LIMITS.markerLabel)`. An
// over-long label fails zod (`session_invalid`) and — since the batch is parsed
// as one unit — rejects up to 200 sessions. Both the artifact-marker merge and
// the trace-marker builder must clamp before the payload leaves the desktop.
test("FEA-2986: oversized artifact- and trace-marker labels are clamped to the cloud cap", async () => {
  await withTestDb(async (db) => {
    const longTitle = `x${"y".repeat(600)}`; // 601 chars, well past the 300 cap
    const longSummary = `error: ${"z".repeat(600)}`; // trace fail-marker label

    await seedSession(db, "oversized-labels");
    // Timeline event whose summary drives a trace "fail" marker label.
    await db.run(
      `INSERT INTO events (id, session_id, event_type, summary, created_at)
       VALUES ($1, $2, 'ToolError', $3, '2026-06-22T10:02:00.000Z')`,
      "oversized-labels-fail-event",
      "oversized-labels",
      longSummary
    );
    // Commit artifact whose title drives an artifact "commit" marker label.
    await seedCommitArtifact(db, {
      id: "oversized-commit-artifact",
      sha: "abc123456789",
      title: longTitle,
      committedAt: "2026-06-22T10:04:00.000Z",
      observedAt: "2026-06-22T10:05:00.000Z",
      lastSeenAt: "2026-06-22T10:06:00.000Z",
    });
    await linkArtifact(db, {
      id: "oversized-commit-link",
      sessionId: "oversized-labels",
      artifactId: "oversized-commit-artifact",
      relation: "created",
      method: "commit_output",
      observedAt: "2026-06-22T10:03:00.000Z",
    });

    const byId = await loadById(db, ["oversized-labels"]);
    const session = byId.get("oversized-labels");
    assert.ok(session, "session hydrated");

    const markers = session?.markers ?? [];
    assert.ok(markers.length > 0, "expected at least one marker");
    for (const marker of markers) {
      assert.ok(
        marker.label.length <= 300,
        `marker label must be clamped to the cloud cap (got ${marker.label.length})`
      );
    }

    const commitMarker = onlyMarkerOfKind(markers, "commit");
    assert.equal(
      commitMarker.label.length,
      300,
      "artifact commit-marker label clamped to exactly 300"
    );
    assert.ok(
      longTitle.startsWith(commitMarker.label),
      "clamp keeps the leading 300 chars of the title"
    );

    const failMarker = onlyMarkerOfKind(markers, "fail");
    assert.equal(
      failMarker.label.length,
      300,
      "trace fail-marker label clamped to exactly 300"
    );
  });
});

// FEA-3329: the PR/commit timeline markers must land at their REAL times — the
// PR from `pull_requests.opened_at` and the commit from `artifacts.committed_at`
// — NOT the single shared per-import ingest `now` stamped on every artifact
// link's `observed_at` in one extraction pass. Before this fix every PR marker
// bunched at one synthetic timestamp and every commit at another (identical to
// the millisecond), collapsing them all to the end of the Session Timeline.
test("FEA-3329: PR/commit markers use pull_requests.opened_at + committed_at, not the shared link ingest now", async () => {
  await withTestDb(async (db) => {
    await seedSession(db, "real-times");
    await seedTimelineEvents(db, "real-times");

    // Two PRs opened at genuinely different times; the SHARED ingest `now`
    // (link observed_at) is identical for both, exactly as the extractor stamps
    // it. With the bug, both markers would collapse to 10:09:00.000Z.
    const sharedIngestNow = "2026-06-22T10:09:00.000Z";
    await seedPullRequestArtifact(db, {
      id: "pr-early-artifact",
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 3329,
      title: "Early PR",
      observedAt: sharedIngestNow,
      lastSeenAt: sharedIngestNow,
    });
    await seedPullRequestArtifact(db, {
      id: "pr-late-artifact",
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 3330,
      title: "Late PR",
      observedAt: sharedIngestNow,
      lastSeenAt: sharedIngestNow,
    });
    await seedPullRequestLifecycle(db, {
      id: "pr-early-lifecycle",
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 3329,
      openedAt: "2026-06-22T10:02:00.000Z",
    });
    await seedPullRequestLifecycle(db, {
      id: "pr-late-lifecycle",
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 3330,
      openedAt: "2026-06-22T10:07:00.000Z",
    });
    await linkArtifact(db, {
      id: "pr-early-link",
      sessionId: "real-times",
      artifactId: "pr-early-artifact",
      relation: "created",
      method: "pr_create_output",
      observedAt: sharedIngestNow,
    });
    await linkArtifact(db, {
      id: "pr-late-link",
      sessionId: "real-times",
      artifactId: "pr-late-artifact",
      relation: "created",
      method: "pr_create_output",
      observedAt: sharedIngestNow,
    });

    // A commit whose committed_at differs from the shared ingest `now`.
    await seedCommitArtifact(db, {
      id: "real-commit-artifact",
      sha: "realtime12345",
      title: "Real-time commit",
      committedAt: "2026-06-22T10:04:00.000Z",
      observedAt: sharedIngestNow,
      lastSeenAt: sharedIngestNow,
    });
    await linkArtifact(db, {
      id: "real-commit-link",
      sessionId: "real-times",
      artifactId: "real-commit-artifact",
      relation: "created",
      method: "commit_output",
      observedAt: sharedIngestNow,
    });

    const byId = await loadById(db, ["real-times"]);
    const markers = byId.get("real-times")?.markers ?? [];
    const prMarkers = markers.filter((marker) => marker.kind === "pr");
    const commitMarker = onlyMarkerOfKind(markers, "commit");

    // Both PRs resolve to their real opened_at — NOT the shared ingest now.
    const early = prMarkers.find((marker) => marker.label.includes("#3329"));
    const late = prMarkers.find((marker) => marker.label.includes("#3330"));
    assert.ok(early && late, "both PR markers present");
    assert.equal(early.t, "2026-06-22T10:02:00.000Z");
    assert.equal(late.t, "2026-06-22T10:07:00.000Z");
    // The two PR markers land at DIFFERENT positions, not bunched together.
    assert.notEqual(early.t, late.t);
    assert.notEqual(early.x, late.x);
    assert.ok(
      early.x < late.x,
      "earlier PR sits earlier on the timeline than the later PR"
    );

    // The commit resolves to its real committed_at, not the shared ingest now.
    assert.equal(commitMarker.t, "2026-06-22T10:04:00.000Z");
    for (const marker of [early, late, commitMarker]) {
      assert.notEqual(
        marker.t,
        sharedIngestNow,
        `${marker.label} must not fall back to the shared ingest now`
      );
    }
  });
});

// FEA-3329 + FEA-3594: when opened_at is genuinely absent (PR not yet
// enriched), the PR marker falls back to sessionEndMs — the corrected
// activity-end anchor — rather than the import timestamps (link_observed_at,
// artifact_observed_at) which are meaningless rebuild artifacts.
test("FEA-3329: an un-enriched PR (null opened_at) falls back to sessionEndMs", async () => {
  await withTestDb(async (db) => {
    await seedSession(db, "unenriched-pr");
    await seedTimelineEvents(db, "unenriched-pr");
    await seedPullRequestArtifact(db, {
      id: "unenriched-pr-artifact",
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 3331,
      title: "Un-enriched PR",
      observedAt: "2026-06-22T10:03:00.000Z",
      lastSeenAt: "2026-06-22T10:08:00.000Z",
    });
    // pull_requests row exists but opened_at is null (enrichment not yet run).
    await seedPullRequestLifecycle(db, {
      id: "unenriched-pr-lifecycle",
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 3331,
      openedAt: null,
    });
    await linkArtifact(db, {
      id: "unenriched-pr-link",
      sessionId: "unenriched-pr",
      artifactId: "unenriched-pr-artifact",
      relation: "created",
      method: "pr_create_output",
      observedAt: "2026-06-22T10:04:00.000Z",
    });

    const byId = await loadById(db, ["unenriched-pr"]);
    const marker = onlyMarkerOfKind(byId.get("unenriched-pr")?.markers, "pr");
    // FEA-3594: opened_at null → fall back to sessionEndMs (last real activity
    // from seedTimelineEvents = "2026-06-22T10:05:00.000Z"), NOT link_observed_at
    // ("2026-06-22T10:04:00.000Z") which is a meaningless rebuild artifact.
    assert.equal(marker.t, "2026-06-22T10:05:00.000Z");
  });
});

async function runRuntimeBackfillBoundaryCase(
  summary: Pick<BackfillResult, "captured" | "touchedForMarkers">
): Promise<{
  storeOps: string[];
  sentMessages: ["desktop:db:changed", Record<string, never>][];
}> {
  const storeOps: string[] = [];
  const sentMessages: ["desktop:db:changed", Record<string, never>][] = [];
  const backfillSummary: BackfillResult = {
    captured: summary.captured,
    deduped: 0,
    scanned: 0,
    skipped: 0,
    errors: 0,
    touchedForMarkers: summary.touchedForMarkers,
    touchedForMarkerSessionIds: [],
  };

  await runArtifactLinkBackfillRuntimeBoundary({
    invokeStoreOp: (name) => {
      storeOps.push(name);
      return Promise.resolve(backfillSummary);
    },
    shouldContinue: () => true,
    getWindow: () => ({
      webContents: {
        isDestroyed: () => false,
        send: (
          channel: "desktop:db:changed",
          payload: Record<string, never>
        ) => {
          sentMessages.push([channel, payload]);
        },
      },
    }),
  });

  return { storeOps, sentMessages };
}

async function withTestDb(run: (db: TestDb) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2060-markers-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-06-22T10:00:00.000Z",
    });
    try {
      await run(db);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function loadById(
  db: TestDb,
  sessionIds: string[]
): Promise<Map<string, SyncedAgentSession>> {
  const sessions = await db.syncSource.loadSyncedSessions(sessionIds, {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  });
  return new Map(
    sessions.map((session) => [session.externalSessionId, session])
  );
}

async function seedSession(
  db: TestDb,
  sessionId: string,
  metadata?: Record<string, unknown>,
  updatedAt = "2026-06-22T10:10:00.000Z"
): Promise<void> {
  await db.run(
    `INSERT INTO sessions
       (id, name, status, started_at, updated_at, ended_at, metadata, harness, billing_mode)
     VALUES ($1, $2, 'completed', $3, $4, $5, $6, 'claude', 'metered_api')`,
    sessionId,
    sessionId,
    "2026-06-22T10:00:00.000Z",
    updatedAt,
    /* ISS-5182: a terminal session's `ended_at` IS `max(event.created_at)`,
       frozen at the terminal transition (`session-maintenance.ts`, FEA-3580).
       `seedTimelineEvents` plants its last event at 10:05, so 10:05 is the only
       contract-valid end here. This previously read 10:10 — an `ended_at` five
       minutes past the last event, i.e. the sweeper-wall-clock-stamp scenario
       FEA-3594 was written to defend against. That defect no longer exists, so
       the fixture must not simulate it; `updated_at` stays at 10:10 to keep
       proving the re-sync bump is ignored. */
    "2026-06-22T10:05:00.000Z",
    metadata ? JSON.stringify(metadata) : null
  );
}

async function seedTimelineEvents(
  db: TestDb,
  sessionId: string
): Promise<void> {
  await db.run(
    `INSERT INTO events (id, session_id, event_type, summary, created_at)
     VALUES
       ($1, $2, 'AssistantMessage', 'one', '2026-06-22T10:01:00.000Z'),
       ($3, $2, 'AssistantMessage', 'two', '2026-06-22T10:03:00.000Z'),
       ($4, $2, 'AssistantMessage', 'three', '2026-06-22T10:05:00.000Z')`,
    `${sessionId}-event-1`,
    sessionId,
    `${sessionId}-event-2`,
    `${sessionId}-event-3`
  );
}

async function seedCommitArtifact(
  db: TestDb,
  input: {
    id: string;
    sha: string;
    title: string | null;
    committedAt: string | null;
    observedAt: string | null;
    lastSeenAt: string;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, sha, title, committed_at, observed_at, created_at, last_seen_at)
     VALUES ($1, $2, 'commit', 'closedloop-ai/symphony-alpha', $3, $4, $5, $6, $7, $8)`,
    input.id,
    `commit:closedloop-ai/symphony-alpha:${input.sha}`,
    input.sha,
    input.title,
    input.committedAt,
    input.observedAt,
    "2026-06-22T10:00:00.000Z",
    input.lastSeenAt
  );
}

async function seedPullRequestArtifact(
  db: TestDb,
  input: {
    id: string;
    repoFullName: string;
    prNumber: number;
    title: string | null;
    observedAt: string | null;
    lastSeenAt: string;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, pr_number, url, title, observed_at, created_at, last_seen_at)
     VALUES ($1, $2, 'pull_request', $3, $4, $5, $6, $7, $8, $9)`,
    input.id,
    `pr:${input.repoFullName}#${input.prNumber}`,
    input.repoFullName,
    input.prNumber,
    `https://github.com/${input.repoFullName}/pull/${input.prNumber}`,
    input.title,
    input.observedAt,
    "2026-06-22T10:00:00.000Z",
    input.lastSeenAt
  );
}

// FEA-3329: seed the `pull_requests` lifecycle row the enrichment runner writes,
// carrying the AUTHORITATIVE `opened_at` the PR marker prefers. Distinct from the
// artifact row (kind='pull_request') seeded by seedPullRequestArtifact.
async function seedPullRequestLifecycle(
  db: TestDb,
  input: {
    id: string;
    repoFullName: string;
    prNumber: number;
    openedAt: string | null;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO pull_requests
       (id, pr_url, pr_number, repo_full_name, state, opened_at, observed_at, created_at)
     VALUES ($1, $2, $3, $4, 'OPEN', $5, $6, $6)`,
    input.id,
    `https://github.com/${input.repoFullName}/pull/${input.prNumber}`,
    input.prNumber,
    input.repoFullName,
    input.openedAt,
    "2026-06-22T10:00:00.000Z"
  );
}

async function linkArtifact(
  db: TestDb,
  input: {
    id: string;
    sessionId: string;
    artifactId: string;
    relation: string;
    method: string;
    observedAt: string;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, '{}', 1, $6, $6)`,
    input.id,
    input.sessionId,
    input.artifactId,
    input.relation,
    input.method,
    input.observedAt
  );
}

function onlyMarkerOfKind(
  markers: readonly SessionMarker[] | null | undefined,
  kind: SessionMarker["kind"]
): SessionMarker {
  const matches = (markers ?? []).filter((marker) => marker.kind === kind);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${kind} marker, got ${matches.length}`
    );
  }
  return matches[0];
}

async function sessionUpdatedAt(
  db: TestDb,
  sessionId: string
): Promise<string> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ updated_at: string }[]>(
    "SELECT updated_at FROM sessions WHERE id = $1",
    sessionId
  );
  return rows[0].updated_at;
}

async function markerSyncStateKey(
  db: TestDb,
  sessionId: string
): Promise<string> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ source_key: string }[]>(
    "SELECT source_key FROM sync_state WHERE source_key LIKE $1",
    `%${sessionId}:%`
  );
  if (rows.length !== 1) {
    throw new Error(`Expected one marker sync_state row for ${sessionId}`);
  }
  return rows[0].source_key;
}

/* FEA-3594: when pr_opened_at is null (PR not yet enriched or no lifecycle row
   at all), the PR marker falls back to sessionEndMs — the session's own end
   anchor from resolveTraceEndMs — rather than import timestamps such as
   link_observed_at, which are meaningless rebuild artifacts that happened to be
   stamped at ingest time. That fallback is the contract under test here;
   ISS-5182 only changed which timestamp the anchor resolves to. */
test("FEA-3594: un-enriched PR (null pr_opened_at) uses sessionEndMs, not link_observed_at", async () => {
  await withTestDb(async (db) => {
    // Session with real timeline activity: seedTimelineEvents plants 3
    // AssistantMessage events at 10:01, 10:03, 10:05, and the fixture's
    // ended_at is that same 10:05. resolveTraceEndMs returns the last real
    // activity timestamp: "2026-06-22T10:05:00.000Z" (sessionEndMs).
    await seedSession(db, "fea3594-unenriched-pr");
    await seedTimelineEvents(db, "fea3594-unenriched-pr");
    await seedPullRequestArtifact(db, {
      id: "fea3594-pr-artifact",
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 3594,
      title: "Un-enriched PR",
      observedAt: "2026-06-22T10:03:00.000Z",
      lastSeenAt: "2026-06-22T10:08:00.000Z",
    });
    // No pull_requests lifecycle row at all: pr_opened_at is null in the
    // correlated subquery (SELECT MIN(opened_at) ... returns null when no row
    // matches). The link_observed_at is deliberately stamped at a distinct time
    // to prove it is NOT used as the fallback.
    await linkArtifact(db, {
      id: "fea3594-pr-link",
      sessionId: "fea3594-unenriched-pr",
      artifactId: "fea3594-pr-artifact",
      relation: "created",
      method: "pr_create_output",
      observedAt: "2026-06-22T10:04:00.000Z",
    });

    const byId = await loadById(db, ["fea3594-unenriched-pr"]);
    const marker = onlyMarkerOfKind(
      byId.get("fea3594-unenriched-pr")?.markers,
      "pr"
    );
    // sessionEndMs = last real activity = "2026-06-22T10:05:00.000Z"
    assert.equal(
      marker.t,
      "2026-06-22T10:05:00.000Z",
      "PR marker must anchor to sessionEndMs when pr_opened_at is absent"
    );
    assert.notEqual(
      marker.t,
      "2026-06-22T10:04:00.000Z",
      "link_observed_at must not be used as a fallback for PR markers"
    );
  });
});
