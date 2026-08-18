/**
 * @file write-core-pull-requests.ts
 * @description Pull-request persistence for the historical importer, extracted
 * from `write-core.ts` (which named it as one of its responsibilities). Dual-
 * writes each normalized PR into `pull_requests` (the lifecycle store the
 * FEA-1869 status observer reads) and into the canonical `kind='pull_request'`
 * artifact + its conservative `referenced` session link.
 *
 * A LEAF sibling: it imports only from the shared helper/enrichment modules and
 * the generated Prisma client, never from `write-core.ts`, so there is no cycle.
 */

import { artifactLinkId } from "../collectors/parsing/artifact-ref-extractor.js";
import type { ArtifactRefRecord } from "../collectors/parsing/artifact-ref-record.js";
import type { Harness, NormalizedSession } from "../collectors/types.js";
import {
  artifactIdFromIdentityKey,
  computeIdentityKey,
} from "../enrichment/identity-key.js";
import {
  type PullRequestPreservedFields,
  upsertPullRequest,
} from "../pull-requests/pr-store.js";
import {
  maxIso,
  normalizeRepoFullName,
  numberFromUnknown,
  parseGitHubPrUrl,
  toCanonicalIso,
  validIso,
} from "./db-helpers.js";
import type { Prisma } from "./generated/client.js";

export async function persistNormalizedPullRequests(
  tx: Prisma.TransactionClient,
  session: NormalizedSession,
  harness: Harness,
  now: string,
  // `repo#number` → head branch, for PRs this session CREATED (per the artifact-
  // ref extractor, which records the branch active at `gh pr create` time). A PR
  // absent from this map was merely referenced and carries no head ref.
  createdPrHeadBranches: ReadonlyMap<string, string | null>,
  pullRequestPreserved: ReadonlyMap<string, PullRequestPreservedFields>
): Promise<number> {
  const artifacts = session.artifacts;
  const prs = Array.isArray(artifacts?.prs) ? artifacts.prs : [];
  if (prs.length === 0) {
    return 0;
  }

  let captured = 0;
  const defaultRepo = normalizeRepoFullName(artifacts?.repo);
  // ISS-5427: this is the SECOND writer of `session_artifact_links.observed_at`
  // (and it also seeds `artifacts.observed_at` and `pull_requests.observed_at`).
  // All three are TEXT columns their readers compare LEXICALLY — `ORDER BY
  // sal.observed_at` in branch-reads/component-invocations, `ORDER BY
  // pr.observed_at DESC` for the newest-PR-per-branch pick, and the
  // `COALESCE(observed_at, created_at) BETWEEN` range scans in local-insights.
  // `maxIso` compares by INSTANT so it picks the right operand, but `validIso`
  // returns that operand VERBATIM, and Claude's `isoTs` passes a transcript
  // string through unparsed — so an offset-form `startedAt`/`endedAt` would land
  // in the same columns `artifact-ref-observed-at.ts` now canonicalizes, and the
  // boot heal would repair them only until the next import wrote them back.
  // `now` (the import clock) is canonical by construction.
  //
  // Canonicalizing HERE while `sessions.started_at` keeps its verbatim harness
  // spelling (write-core.ts) means the two columns can legitimately disagree in
  // format on a live store — and local-insights' delivery-latency gate compared
  // exactly those two against each other. That predicate is now instant-based
  // (`unixepoch`), not byte-wise; see the ISS-5427 note on it. Any NEW reader
  // that relates one of these columns to a `sessions` timestamp owes the same
  // treatment: `sessions.started_at`/`ended_at` carry no canonical-form
  // guarantee, so compare instants, do not compare bytes.
  const rawExternalObservedAt = maxIso(
    validIso(session.startedAt),
    validIso(session.endedAt)
  );
  const externalObservedAt =
    rawExternalObservedAt === null
      ? null
      : toCanonicalIso(rawExternalObservedAt);
  const observedAt = externalObservedAt ?? now;
  for (const pr of prs) {
    const fromUrl =
      typeof pr.url === "string" ? parseGitHubPrUrl(pr.url) : null;
    const prNumber = fromUrl?.number ?? numberFromUnknown(pr.number);
    const repoFullName =
      fromUrl?.repoFullName ?? normalizeRepoFullName(pr.repo) ?? defaultRepo;
    if (!(prNumber && repoFullName)) {
      continue;
    }
    const prUrl =
      pr.url ?? `https://github.com/${repoFullName}/pull/${prNumber}`;
    // Only a PR this session CREATED has a head branch we can trust — the branch
    // the user was on at `gh pr create` time, captured by the extractor. A merely-
    // referenced PR (someone else's, or one inspected via `gh pr view`) is absent
    // from the map and must NOT inherit this session's branch, or it is mis-filed
    // onto this branch in the Branches view and the branch↔PR link propagation
    // (both match on `pull_requests.branch_name`).
    const headBranch =
      createdPrHeadBranches.get(`${repoFullName}#${prNumber}`) ?? null;
    // Dual-write: PR detail goes into pull_requests (lifecycle store, feeds
    // FEA-1869 status observer); attribution goes into artifacts below.
    await upsertPullRequest(
      tx,
      {
        externalSessionId: session.sessionId,
        harness,
        prUrl,
        prNumber,
        repoFullName,
        branchName: headBranch,
        headSha: null,
        title: null,
        observedAt: externalObservedAt,
      },
      now,
      pullRequestPreserved
    );

    // FEA-1899: PRs are canonical kind='pull_request' artifacts keyed by
    // identity_key. COALESCE-fill the descriptive fields and bump last_seen_at;
    // never touch enrichment columns. SQLite has no `xmax`, so distinguish a
    // fresh insert (counts as captured) from an ON CONFLICT update by probing
    // for the row first: absence ⇒ this upsert will insert ⇒ captured.
    const identityKey = computeIdentityKey({
      kind: "pull_request",
      repoFullName,
      prNumber,
    });
    const artifactId = artifactIdFromIdentityKey(identityKey);
    const existingArtifact = await tx.artifact.findUnique({
      where: { identityKey },
      select: { id: true },
    });
    const wasInserted = existingArtifact === null;
    const artifactRows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number, branch_name,
          title, harness, url, observed_at, created_at, last_seen_at)
       VALUES ($1,$2,'pull_request',$3,$4,$5,$6,$7,$8,$9,$9,$9)
       ON CONFLICT(identity_key) DO UPDATE SET
         last_seen_at = EXCLUDED.last_seen_at,
         -- An incoming created-PR head is exact command/output evidence, so it
         -- supersedes a stored value that may predate the CWD-fallback removal.
         -- Referenced PRs still pass NULL and preserve the stored observation.
         branch_name = COALESCE(EXCLUDED.branch_name, artifacts.branch_name),
         title = COALESCE(artifacts.title, EXCLUDED.title),
         harness = COALESCE(artifacts.harness, EXCLUDED.harness),
         url = COALESCE(artifacts.url, EXCLUDED.url),
         observed_at = COALESCE(artifacts.observed_at, EXCLUDED.observed_at)
       RETURNING id`,
      artifactId,
      identityKey,
      repoFullName,
      prNumber,
      headBranch,
      null,
      harness,
      prUrl,
      observedAt
    );
    const resolvedArtifactId = artifactRows[0]?.id ?? artifactId;
    // session.artifacts.prs is populated by collectArtifacts for ANY PR URL the
    // session touched (created OR merely referenced), so we cannot assert
    // 'created' here without corrupting attribution. The artifact-ref extractor
    // owns the created-vs-referenced distinction via tool-call evidence and runs
    // first (persistArtifactLinks above). Only add a conservative 'referenced'
    // link when the extractor did not already link this PR to the session.
    const linkId = artifactLinkId(
      session.sessionId,
      "pull_request",
      `${repoFullName}#${prNumber}`,
      "referenced"
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, is_primary,
          status, extractor_version, observed_at, created_at)
       SELECT $1,$2,$3,'referenced','normalized_pr','{}',0,'candidate',1,$4,$4
       WHERE NOT EXISTS (
         SELECT 1 FROM session_artifact_links
         WHERE session_id = $2 AND artifact_id = $3
       )
       ON CONFLICT(session_id, artifact_id, relation) DO NOTHING`,
      linkId,
      session.sessionId,
      resolvedArtifactId,
      observedAt
    );
    if (wasInserted) {
      captured++;
    }
  }
  return captured;
}

/** Collect exact created-PR heads without admitting transport-only evidence. */
export function collectCreatedPullRequestHeadBranches(
  refs: readonly ArtifactRefRecord[]
): Map<string, string | null> {
  const heads = new Map<string, string | null>();
  for (const ref of refs) {
    if (
      ref.monitoredActivityOnly ||
      ref.targetKind !== "pull_request" ||
      ref.relation !== "created" ||
      !ref.repoFullName ||
      ref.prNumber == null
    ) {
      continue;
    }
    const key = `${ref.repoFullName}#${ref.prNumber}`;
    const branch = ref.branchName ?? null;
    if (!heads.has(key) || (branch && !heads.get(key))) {
      heads.set(key, branch);
    }
  }
  return heads;
}
