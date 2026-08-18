/**
 * @file session-detail-branch-route.test.ts
 * @description ISS-5567: the desktop session detail resolves the branch-detail
 * route id its Branch row links to, so the shared Properties pane
 * (`packages/app/agents/components/detail/agent-session-detail-view.tsx`, which
 * gates the link on `session.branch && session.branchArtifactId &&
 * getBranchHref`) links on desktop the way it already does on web. Desktop wired
 * `getBranchHref` but never populated `branchArtifactId`, so the same session
 * rendered a navigable link on web and inert mono text on desktop.
 *
 * The load-bearing assertion is not "a string is present" but that the string is
 * a LIVE destination: the id the detail emits is fed straight back into
 * `getSharedBranchDetail` — the real `/branches/:id` resolver — and must resolve
 * to the branch the row names. That is what makes this a link rather than a
 * promise of one, and it is why the id is built from the branch ARTIFACT's repo
 * rather than the session's `attribution.repositoryFullName` (independent
 * resolution paths that can disagree; a disagreement mints an id no branch
 * answers to).
 *
 * Lives in its own file because `apps/desktop/test/shared-agent-sessions-api.test.ts`
 * is a grandfathered over-ceiling file.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BranchCloudHydrationStatus,
  encodeBranchId,
} from "@repo/api/src/types/branch.js";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
} from "@repo/api/src/types/repository-default-identity.js";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import type {
  AgentSessionSyncSource,
  SessionBranchLinkKey,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { getSharedBranchDetail } from "../src/main/branch/shared-branches-api.js";
import type { BranchDefaultEligibilitySource } from "../src/main/branch/shared-branches-default-eligibility.js";
import { resolveSessionBranchRouteId } from "../src/main/session/session-branch-route.js";
import { getSharedAgentSessionDetail } from "../src/main/session/shared-agent-session-detail-read.js";
import { openTestDb } from "./agent-db-test-utils.js";

const SESSION_ID = "iss5567-session";
const REPO_FULL_NAME = "closedloop-ai/symphony-alpha";
const BRANCH_NAME = "fix/iss-5182-end-time-from-events";
const BRANCH_ARTIFACT_ID = "iss5567-branch-artifact";
const AT = "2026-07-10T00:00:00.000Z";

function syncedSession(
  overrides?: Partial<SyncedAgentSession>
): SyncedAgentSession {
  return {
    externalSessionId: SESSION_ID,
    name: "Branch link session",
    status: "completed",
    harness: "claude",
    cwd: "/tmp/iss5567",
    model: "gpt-test",
    startedAt: AT,
    updatedAt: AT,
    endedAt: AT,
    awaitingInputSince: null,
    metadata: null,
    attribution: null,
    agents: [],
    events: [],
    tokenUsageByModel: [],
    branch: BRANCH_NAME,
    ...overrides,
  };
}

/** The narrowest source the detail path needs, plus the ISS-5567 branch read. */
function fakeSource(
  session: SyncedAgentSession,
  loadSessionBranchLinkKeys?: (
    sessionId: string
  ) => SessionBranchLinkKey[] | Promise<SessionBranchLinkKey[]>
): AgentSessionSyncSource {
  return {
    listAllSessionCursorRows: () => [],
    listSessionCursorPage: () => ({ rows: [], total: 0 }),
    listUpdatedSessionCursorRows: () => [],
    loadSyncedSessions: () => [session],
    ...(loadSessionBranchLinkKeys ? { loadSessionBranchLinkKeys } : {}),
  } as unknown as AgentSessionSyncSource;
}

function branchKey(
  overrides?: Partial<SessionBranchLinkKey>
): SessionBranchLinkKey {
  return {
    repoFullName: REPO_FULL_NAME,
    branchName: BRANCH_NAME,
    hasLocalPublication: true,
    ...overrides,
  };
}

function eligibilitySource(
  defaultBranch: string
): BranchDefaultEligibilitySource {
  return {
    resolveRepositoryDefaultEligibilityInputs: async () => ({
      status: BranchCloudHydrationStatus.Fresh,
      rowHydrationResult: { status: BranchCloudHydrationStatus.Fresh },
      authorities: [
        {
          repository: {
            provider: VcsProviderKind.GitHub,
            providerRepositoryId: "repo-iss5567",
            fullName: REPO_FULL_NAME,
          },
          evidence: {
            availability: RepositoryDefaultAvailability.Available,
            completeness: RepositoryDefaultCompleteness.Complete,
            defaultBranch,
          },
        },
      ],
    }),
  };
}

test("ISS-5567: the session detail emits the branch route id, and it resolves to that branch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5567-branch-route-"));
  const db = await openTestDb(dir, { now: () => AT });
  try {
    await db.run(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
       VALUES ($1, $2, 'branch', $3, $4, $5, $5)`,
      BRANCH_ARTIFACT_ID,
      "iss5567-branch",
      REPO_FULL_NAME,
      BRANCH_NAME,
      AT
    );
    await db.run(
      "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, 'completed', $2, $2)",
      SESSION_ID,
      AT
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, is_primary, extractor_version, observed_at, created_at)
       VALUES ($1, $2, $3, 'created', 'git_push', 'e', 1, 1, $4, $4)`,
      "iss5567-link",
      SESSION_ID,
      BRANCH_ARTIFACT_ID,
      AT
    );

    // The production detail read, against the real store's branch link.
    const detail = await getSharedAgentSessionDetail(
      { ...db.syncSource, loadSyncedSessions: () => [syncedSession()] },
      SESSION_ID
    );

    assert.equal(
      detail?.branchArtifactId,
      encodeBranchId({ repoFullName: REPO_FULL_NAME, branchName: BRANCH_NAME }),
      "the detail addresses the branch with the id the Branches list mints"
    );

    // The link is only real if the route it names answers. Feed the emitted id
    // to the SAME resolver `/branches/:id` uses.
    const resolved = await getSharedBranchDetail(
      {
        prisma: db.prisma,
        readBranchCanonicalActivityRows: db.readBranchCanonicalActivityRows,
        readBranchMetricEventEvidence: db.readBranchMetricEventEvidence,
        syncSource: db.syncSource,
      },
      detail?.branchArtifactId
    );
    assert.equal(
      resolved?.branchName,
      BRANCH_NAME,
      "the emitted id resolves to the branch the row names, not a 404"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5567: a source that cannot resolve a branch link leaves the row plain text", async () => {
  // Version skew: an older/fake source predating `loadSessionBranchLinkKeys`. The
  // key must be genuinely ABSENT (the shared pane reads presence), not null.
  const detail = await getSharedAgentSessionDetail(
    fakeSource(syncedSession()),
    SESSION_ID
  );
  assert.equal(detail?.branch, BRANCH_NAME, "the branch itself still renders");
  assert.equal(
    Object.hasOwn(detail ?? {}, "branchArtifactId"),
    false,
    "no link is asserted when the route id cannot be resolved"
  );
});

test("ISS-5567: the detail projection calls the source's branch read for the opened session", async () => {
  const seen: string[] = [];
  const detail = await getSharedAgentSessionDetail(
    fakeSource(syncedSession(), (sessionId) => {
      seen.push(sessionId);
      return [branchKey()];
    }),
    SESSION_ID
  );
  assert.deepEqual(
    seen,
    [SESSION_ID],
    "read once, scoped to the opened session"
  );
  assert.equal(
    detail?.branchArtifactId,
    encodeBranchId({ repoFullName: REPO_FULL_NAME, branchName: BRANCH_NAME })
  );
});

test("ISS-5567: a read-only session with no branch takes no branch read at all", async () => {
  let calls = 0;
  const detail = await getSharedAgentSessionDetail(
    fakeSource(syncedSession({ branch: null }), () => {
      calls += 1;
      return [branchKey()];
    }),
    SESSION_ID
  );
  assert.equal(calls, 0, "no branch on display, so nothing to address");
  assert.equal(detail?.branchArtifactId, undefined);
});

test("ISS-5567: the route id is withheld unless the link names the branch on display", async () => {
  const source = { loadSessionBranchLinkKeys: () => [branchKey()] };

  assert.equal(
    await resolveSessionBranchRouteId({
      source,
      sessionId: SESSION_ID,
      branch: BRANCH_NAME,
      displayedRepositoryFullName: REPO_FULL_NAME,
    }),
    encodeBranchId({ repoFullName: REPO_FULL_NAME, branchName: BRANCH_NAME })
  );

  // No branch artifact carries the displayed name (a mid-read write, an
  // attribution that outran the artifact): pointing the user at a branch the row
  // does not name is worse than not linking.
  assert.equal(
    await resolveSessionBranchRouteId({
      source,
      sessionId: SESSION_ID,
      branch: "some/other-branch",
      displayedRepositoryFullName: REPO_FULL_NAME,
    }),
    undefined
  );

  // No link row at all.
  assert.equal(
    await resolveSessionBranchRouteId({
      source: { loadSessionBranchLinkKeys: () => [] },
      sessionId: SESSION_ID,
      branch: BRANCH_NAME,
      displayedRepositoryFullName: REPO_FULL_NAME,
    }),
    undefined
  );
});

test("ISS-5828: session branch routing uses the exact authoritative default", async () => {
  assert.equal(
    await resolveSessionBranchRouteId({
      source: {
        loadSessionBranchLinkKeys: () => [branchKey({ branchName: "main" })],
      },
      sessionId: SESSION_ID,
      branch: "main",
      displayedRepositoryFullName: REPO_FULL_NAME,
      eligibilitySource: eligibilitySource("main"),
    }),
    undefined,
    "the authoritative default remains plain text"
  );
  assert.equal(
    await resolveSessionBranchRouteId({
      source: {
        loadSessionBranchLinkKeys: () => [branchKey({ branchName: "main" })],
      },
      sessionId: SESSION_ID,
      branch: "main",
      displayedRepositoryFullName: REPO_FULL_NAME,
      eligibilitySource: eligibilitySource("trunk"),
    }),
    encodeBranchId({ repoFullName: REPO_FULL_NAME, branchName: "main" }),
    "a conventional name remains eligible when the repository default is trunk"
  );
});

test("ISS-6542: session branch routing withholds a Wrote-only destination", async () => {
  assert.equal(
    await resolveSessionBranchRouteId({
      source: {
        loadSessionBranchLinkKeys: () => [
          branchKey({ hasLocalPublication: false }),
        ],
      },
      sessionId: SESSION_ID,
      branch: BRANCH_NAME,
      displayedRepositoryFullName: REPO_FULL_NAME,
      eligibilitySource: eligibilitySource("main"),
    }),
    undefined
  );
});

test("ISS-5828: session branch routing warms authority without blocking detail", async () => {
  const scopes: string[] = [];
  const source: BranchDefaultEligibilitySource = {
    resolveRepositoryDefaultEligibilityInputs: (request) => {
      scopes.push(request.scope);
      return eligibilitySource("trunk")
        .resolveRepositoryDefaultEligibilityInputs!(request);
    },
  };

  assert.equal(
    await resolveSessionBranchRouteId({
      source: {
        loadSessionBranchLinkKeys: () => [branchKey({ branchName: "main" })],
      },
      sessionId: SESSION_ID,
      branch: "main",
      displayedRepositoryFullName: REPO_FULL_NAME,
      eligibilitySource: source,
    }),
    encodeBranchId({ repoFullName: REPO_FULL_NAME, branchName: "main" })
  );
  assert.deepEqual(scopes, ["list"]);
});

test("ISS-5567: an ambiguous branch identity resolves by the pane's own repository, or not at all", async () => {
  // `computeIdentityKey` scopes a branch artifact on `repoFullName ?? gitDir`, so
  // ONE branch name legitimately holds two artifact rows — one under `owner/repo`,
  // one under a gitDir with a NULL `repo_full_name` (the artifact-ref resolver's
  // cold-registry case). The Branches list groups on `(repoFullName, branchName)`,
  // so those are two DIFFERENT rows and `encodeBranchId` mints two different ids.
  // A recency pick would address whichever was observed last, and on an
  // `observed_at` tie whichever the engine returned — so the same session's row
  // could address two different branch records on two loads.
  const ambiguous = {
    loadSessionBranchLinkKeys: () => [
      branchKey({ repoFullName: null }),
      branchKey(),
    ],
  };

  // The pane's Repository row singles one out: link agrees with the row above it.
  assert.equal(
    await resolveSessionBranchRouteId({
      source: ambiguous,
      sessionId: SESSION_ID,
      branch: BRANCH_NAME,
      displayedRepositoryFullName: REPO_FULL_NAME,
    }),
    encodeBranchId({ repoFullName: REPO_FULL_NAME, branchName: BRANCH_NAME }),
    "the repo-scoped artifact wins over the repo-less one when the pane names it"
  );

  // Reversing the array must not reverse the answer — that is the whole point.
  assert.equal(
    await resolveSessionBranchRouteId({
      source: {
        loadSessionBranchLinkKeys: () => [
          branchKey(),
          branchKey({ repoFullName: null }),
        ],
      },
      sessionId: SESSION_ID,
      branch: BRANCH_NAME,
      displayedRepositoryFullName: REPO_FULL_NAME,
    }),
    encodeBranchId({ repoFullName: REPO_FULL_NAME, branchName: BRANCH_NAME }),
    "the pick is deterministic in the candidates' order, not a recency coin flip"
  );

  // Nothing to disambiguate with: two real destinations, so say nothing.
  assert.equal(
    await resolveSessionBranchRouteId({
      source: ambiguous,
      sessionId: SESSION_ID,
      branch: BRANCH_NAME,
      displayedRepositoryFullName: null,
    }),
    undefined,
    "an undecidable pick withholds rather than guessing a destination"
  );

  // The pane names a repository neither candidate carries.
  assert.equal(
    await resolveSessionBranchRouteId({
      source: {
        loadSessionBranchLinkKeys: () => [
          branchKey({ repoFullName: "acme/one" }),
          branchKey({ repoFullName: "acme/two" }),
        ],
      },
      sessionId: SESSION_ID,
      branch: BRANCH_NAME,
      displayedRepositoryFullName: REPO_FULL_NAME,
    }),
    undefined
  );
});

test("ISS-5567: a repo-less branch artifact encodes through the local sentinel", async () => {
  assert.equal(
    await resolveSessionBranchRouteId({
      source: {
        loadSessionBranchLinkKeys: () => [branchKey({ repoFullName: null })],
      },
      sessionId: SESSION_ID,
      branch: BRANCH_NAME,
      displayedRepositoryFullName: REPO_FULL_NAME,
    }),
    encodeBranchId({ repoFullName: null, branchName: BRANCH_NAME }),
    "matches how the Branches list collapses a repo-less branch key"
  );
  // A LONE repo-less artifact is not a contradiction with a named Repository row:
  // it is the only row the Branches list shows for that branch, so
  // `local::<branch>` addresses it exactly. Ambiguity is what withholds, and
  // there is none here.
});

test("ISS-5567: the store read returns every distinct branch identity, de-duplicated", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5567-branch-keys-"));
  const db = await openTestDb(dir, { now: () => AT });
  try {
    await db.run(
      "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, 'completed', $2, $2)",
      SESSION_ID,
      AT
    );
    // Two artifact rows for ONE branch name: repo-scoped and gitDir-scoped. Their
    // `identity_key`s differ, so the store legitimately holds both.
    const rows = [
      { id: BRANCH_ARTIFACT_ID, key: "iss5567-branch", repo: REPO_FULL_NAME },
      {
        id: `${BRANCH_ARTIFACT_ID}-local`,
        key: "iss5567-branch-local",
        repo: null,
      },
    ];
    for (const row of rows) {
      await db.run(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
         VALUES ($1, $2, 'branch', $3, $4, $5, $5)`,
        row.id,
        row.key,
        row.repo,
        BRANCH_NAME,
        AT
      );
      // TWO write links per artifact, at the SAME `observed_at` — a commit and a
      // push routinely name one artifact, and a duplicate identity would read as
      // an ambiguity that does not exist. Distinct `relation`s because
      // `(session_id, artifact_id, relation)` is unique.
      for (const link of [
        { method: "git_commit", relation: "created" },
        { method: "git_push", relation: "authored" },
      ]) {
        await db.run(
          `INSERT INTO session_artifact_links
             (id, session_id, artifact_id, relation, method, evidence, is_primary, extractor_version, observed_at, created_at)
           VALUES ($1, $2, $3, $4, $5, 'e', 0, 1, $6, $6)`,
          `link-${row.id}-${link.method}`,
          SESSION_ID,
          row.id,
          link.relation,
          link.method,
          AT
        );
      }
    }
    await db.run(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
       VALUES ($1, $2, 'branch', $3, $4, $5, $5)`,
      `${BRANCH_ARTIFACT_ID}-duplicate`,
      "iss5567-branch-duplicate",
      REPO_FULL_NAME,
      BRANCH_NAME,
      AT
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, is_primary, extractor_version, observed_at, created_at)
       VALUES ($1, $2, $3, 'workspace', 'git_commit', 'e', 0, 1, $4, $4)`,
      "link-duplicate-commit-only",
      SESSION_ID,
      `${BRANCH_ARTIFACT_ID}-duplicate`,
      "2026-07-10T01:00:00.000Z"
    );

    const keys = await db.syncSource.loadSessionBranchLinkKeys?.(SESSION_ID);
    assert.equal(
      keys?.length,
      2,
      "both scopes surface; neither link duplicates"
    );
    assert.deepEqual(
      [...(keys ?? [])]
        .map((key) => key.repoFullName)
        .sort((left, right) => String(left).localeCompare(String(right))),
      [REPO_FULL_NAME, null].sort((left, right) =>
        String(left).localeCompare(String(right))
      )
    );
    assert.equal(
      keys?.find((key) => key.repoFullName === REPO_FULL_NAME)
        ?.hasLocalPublication,
      true,
      "a newer duplicate commit-only artifact cannot hide sibling publication"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5567: a failing branch read degrades to plain text, never a broken detail", async () => {
  assert.equal(
    await resolveSessionBranchRouteId({
      source: {
        loadSessionBranchLinkKeys: () => {
          throw new Error("db unavailable");
        },
      },
      sessionId: SESSION_ID,
      branch: BRANCH_NAME,
      displayedRepositoryFullName: REPO_FULL_NAME,
    }),
    undefined
  );
});

test("ISS-5567: the link is withheld when the branch's repo contradicts the pane's Repository row", async () => {
  const source = { loadSessionBranchLinkKeys: () => [branchKey()] };

  // The pane would name one repository in text and open a branch under another.
  assert.equal(
    await resolveSessionBranchRouteId({
      source,
      sessionId: SESSION_ID,
      branch: BRANCH_NAME,
      displayedRepositoryFullName: "someone-else/other-repo",
    }),
    undefined
  );

  // A `.git` suffix is the same repository, not a contradiction — both sides run
  // through `normalizeRepoFullName`.
  assert.equal(
    await resolveSessionBranchRouteId({
      source,
      sessionId: SESSION_ID,
      branch: BRANCH_NAME,
      displayedRepositoryFullName: `${REPO_FULL_NAME}.git`,
    }),
    encodeBranchId({ repoFullName: REPO_FULL_NAME, branchName: BRANCH_NAME })
  );

  // One side unknown is not a disagreement: a session with no resolved
  // attribution still links to the branch it wrote.
  assert.equal(
    await resolveSessionBranchRouteId({
      source,
      sessionId: SESSION_ID,
      branch: BRANCH_NAME,
      displayedRepositoryFullName: null,
    }),
    encodeBranchId({ repoFullName: REPO_FULL_NAME, branchName: BRANCH_NAME })
  );
});
