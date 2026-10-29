import { createHash } from "node:crypto";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  BRANCH_PUSH_METHODS,
  PROSE_MENTION_REF_METHODS,
} from "@repo/api/src/types/session-artifact-link";
import {
  VIBE_SEED_REPOSITORIES,
  vibeCorpusRepositoryForCwd,
} from "@repo/api/src/vibe-seed-corpus";
import { EXTRACTOR_VERSION } from "../../src/main/collectors/parsing/artifact-ref-extractor-version.js";
import type { SqliteAgentDatabase } from "../../src/main/database/sqlite.js";
import {
  artifactIdFromIdentityKey,
  computeIdentityKey,
} from "../../src/main/enrichment/identity-key.js";

/**
 * ISS-12135: a corpus branch its sessions pushed but never opened a pull
 * request for stays Open forever, so the Branches "Active branches" card
 * (every branch not merged or closed, whatever the window) counted
 * weeks-old branches the date-windowed list leaves out. The vibe store gives
 * each such branch the pull request its pushing session opened a few minutes
 * after its last push, recorded as the session's own `pr_create_output`
 * link, so the web seed's replay settles it like every corpus pull request
 * (merged or closed after review) and the vibe Desktop, which syncs this
 * store, reports the same link instead of dropping it. A branch pushed within
 * the last week keeps no pull request and stays Open, inside every window.
 * Only branches in the vibe org's own repositories are settled; work in any
 * other repository is never replayed as a branch.
 */

/** How long a pushed branch with no pull request stays open: a week, the Branches list's shortest window. */
export const STALE_BRANCH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const OPENED_AFTER_PUSH_MS = 5 * 60 * 1000;

type LinkRow = {
  sessionId: string;
  cwd: string | null;
  relation: string;
  method: string;
  observedAt: string;
  kind: string;
  repoFullName: string | null;
  branchName: string | null;
  prNumber: number | null;
};

type LastPush = {
  readonly sessionId: string;
  readonly repository: string;
  readonly branchName: string;
  readonly pushedMs: number;
};

export async function settleStaleBranches(
  db: SqliteAgentDatabase,
  nowIso: string
): Promise<number> {
  const nowMs = Date.parse(nowIso);
  const links = await db.prisma.client.$queryRawUnsafe<LinkRow[]>(
    `SELECT l.session_id AS sessionId, s.cwd AS cwd, l.relation, l.method,
            l.observed_at AS observedAt, a.kind,
            a.repo_full_name AS repoFullName, a.branch_name AS branchName,
            a.pr_number AS prNumber
       FROM session_artifact_links l
       JOIN artifacts a ON a.id = l.artifact_id
       JOIN sessions s ON s.id = l.session_id
      WHERE a.kind IN ('branch', 'pull_request')`
  );
  const opened = new Set(
    links
      .filter(
        (link) =>
          link.kind === ArtifactRefTargetKind.PullRequest &&
          link.relation === ArtifactRefRelation.Created &&
          link.branchName !== null
      )
      .map((link) => branchKey(link.repoFullName, link.branchName))
  );
  const stale = [
    ...lastPushes(links, pullRequestRepositoryByBranch(links)).values(),
  ]
    .filter(
      (push) =>
        VIBE_SEED_REPOSITORIES.has(push.repository) &&
        !opened.has(branchKey(push.repository, push.branchName)) &&
        nowMs - (push.pushedMs + OPENED_AFTER_PUSH_MS) > STALE_BRANCH_AFTER_MS
    )
    .sort(
      (a, b) =>
        a.pushedMs - b.pushedMs || a.branchName.localeCompare(b.branchName)
    );
  const nextNumber = highestPullRequestNumbers(links);
  await db.prisma.write(async (client) => {
    for (const push of stale) {
      const prNumber = (nextNumber.get(push.repository) ?? 0) + 1;
      nextNumber.set(push.repository, prNumber);
      const openedAt = new Date(push.pushedMs + OPENED_AFTER_PUSH_MS);
      const identityKey = computeIdentityKey({
        kind: ArtifactRefTargetKind.PullRequest,
        repoFullName: push.repository,
        prNumber,
      });
      const artifactId = artifactIdFromIdentityKey(identityKey);
      await client.$executeRawUnsafe(
        `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, branch_name, pr_number, url, observed_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        artifactId,
        identityKey,
        ArtifactRefTargetKind.PullRequest,
        push.repository,
        push.branchName,
        prNumber,
        `https://github.com/${push.repository}/pull/${prNumber}`,
        openedAt.toISOString(),
        nowIso,
        nowIso
      );
      await client.$executeRawUnsafe(
        `INSERT INTO session_artifact_links (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        derivedId(`link:${push.sessionId}:${artifactId}`),
        push.sessionId,
        artifactId,
        ArtifactRefRelation.Created,
        ArtifactRefMethod.PrCreateOutput,
        "{}",
        EXTRACTOR_VERSION,
        openedAt.toISOString(),
        nowIso
      );
    }
  });
  return stale.length;
}

function lastPushes(
  links: readonly LinkRow[],
  repositoryByBranch: ReadonlyMap<string, string>
): Map<string, LastPush> {
  const latest = new Map<string, LastPush>();
  for (const link of links) {
    if (
      link.kind !== ArtifactRefTargetKind.Branch ||
      link.relation !== ArtifactRefRelation.Created ||
      !BRANCH_PUSH_METHODS.has(link.method) ||
      link.branchName === null
    ) {
      continue;
    }
    // Most corpus branch artifacts carry no remote; a pull request naming the
    // branch, else the session's checkout, names the repository, in the order
    // the web seed's link reader (`store-links.ts`) resolves it.
    const repository =
      link.repoFullName ??
      repositoryByBranch.get(link.branchName) ??
      vibeCorpusRepositoryForCwd(link.cwd);
    if (repository === null) {
      continue;
    }
    const pushedMs = Date.parse(link.observedAt);
    const key = branchKey(repository, link.branchName);
    const current = latest.get(key);
    if (current === undefined || pushedMs >= current.pushedMs) {
      latest.set(key, {
        sessionId: link.sessionId,
        repository,
        branchName: link.branchName,
        pushedMs,
      });
    }
  }
  return latest;
}

/** A number a prose mention names never becomes a pull request row; every other ref's does. */
function highestPullRequestNumbers(
  links: readonly LinkRow[]
): Map<string, number> {
  const highest = new Map<string, number>();
  for (const link of links) {
    if (
      link.prNumber === null ||
      link.repoFullName === null ||
      PROSE_MENTION_REF_METHODS.has(link.method)
    ) {
      continue;
    }
    highest.set(
      link.repoFullName,
      Math.max(highest.get(link.repoFullName) ?? 0, link.prNumber)
    );
  }
  return highest;
}

function branchKey(repository: string | null, branchName: string | null) {
  return `${(repository ?? "").toLowerCase()}#${branchName ?? ""}`;
}

function derivedId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function pullRequestRepositoryByBranch(
  links: readonly LinkRow[]
): ReadonlyMap<string, string> {
  const byBranch = new Map<string, string>();
  for (const link of links) {
    if (
      link.kind === ArtifactRefTargetKind.PullRequest &&
      link.branchName !== null &&
      link.repoFullName !== null &&
      !byBranch.has(link.branchName)
    ) {
      byBranch.set(link.branchName, link.repoFullName);
    }
  }
  return byBranch;
}
