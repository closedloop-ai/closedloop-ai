/**
 * @file artifact-link-persistence.ts
 * @description The artifact-link persistence subsystem, extracted verbatim from
 * write-core.ts (ISS-4628, deferred from ISS-4572/#4075 to keep that correctness
 * PR focused). FEA-1899: upsert the canonical artifact (by identity_key) then
 * insert the pure-join session↔artifact link. Owns the batched fast path plus the
 * per-ref fallback (FEA-2545), the per-ref set-once side effects (FEA-2531 PR head
 * branch, branch push state), and the repos-registry resolver (FEA-2777) that maps
 * bare repo names to canonical owner/repo + git_dir. Depends only on leaf modules
 * (identity-key, artifact-ref-extractor, sql-values-tuples, db-helpers,
 * db-constants, branch-pr-attribution) and the generated
 * Prisma client — never on write-core.ts or sqlite.ts, so there is no import cycle.
 */
import { artifactLinkId } from "../collectors/parsing/artifact-ref-extractor.js";
import {
  type ArtifactRefRecord,
  canonicalKeyForRef,
} from "../collectors/parsing/artifact-ref-record.js";
import {
  type ArtifactKind,
  artifactIdFromIdentityKey,
  computeIdentityKey,
} from "../enrichment/identity-key.js";
import { propagateBranchPrLinks } from "./branch-pr-attribution.js";
import { BRANCH_PUSH_METHOD_VALUES } from "./db-constants.js";
import { normalizeRepoFullName } from "./db-helpers.js";
import type { Prisma } from "./generated/client.js";
import {
  buildValuesTuples,
  chunkRowsByParamCap,
  sqlValuesTuple,
} from "./sql-values-tuples.js";

// Push-evidence methods — stamps first_pushed_at on the canonical artifact.
const BRANCH_PUSH_METHODS: ReadonlySet<string> = new Set(
  BRANCH_PUSH_METHOD_VALUES
);

// Strips the trailing "/.git" (with optional trailing slash) from a git_dir so
// buildRepoResolver can index a repo by its bare trailing directory component.
const GIT_DIR_SUFFIX_RE = /\/\.git\/?$/;
// Worktree suffix heuristic: strip -<type>-<identifier> patterns (e.g.
// "symphony-alpha-fea-1234") back to the base repo dir name in buildRepoResolver.
const WORKTREE_SUFFIX_RE =
  /^(.+)[-_](?:fea|feat|fix|pr|pln|prd|wg-review|AI)[-_].+$/i;

/**
 * FEA-1899: upsert the canonical artifact (by identity_key) then insert the
 * pure-join session↔artifact link. The artifact upsert NEVER touches the LOC
 * columns (lines_added, lines_removed, files_changed) so re-imports don't wipe
 * the cloud-projected sizing; it only COALESCE-fills identity fields and bumps
 * last_seen_at. The link is rebuilt on
 * every reparse (delete-then-reinsert upstream) and re-points to the surviving
 * artifact row.
 */
export async function persistArtifactLinks(
  tx: Prisma.TransactionClient,
  sessionId: string,
  refs: ArtifactRefRecord[],
  now: string,
  // Row-level upsert failures (schema drift, constraint violations, a bad ref)
  // are swallowed so the remaining refs still persist — but silently dropping a
  // link leaves the Branches surface with a missing link and zero telemetry.
  // Callers thread their ingest logger through so each swallowed ref emits a
  // warning, matching the file's other best-effort catch sites. Required (not
  // defaulted) so a future caller can't reintroduce the silent-drop by omitting
  // it; callers with no real logger pass an explicit no-op.
  log: (message: string) => void,
  // FEA-2777: callers that persist links for many sessions in one sweep (the
  // boot-time artifact-link backfill) can build the resolver ONCE and pass it
  // in, avoiding a full `SELECT … FROM repos` per session. Omitted on the live
  // import path, which builds it per-session from `tx` below.
  repoResolver?: RepoResolver
): Promise<{ captured: number; droppedUnresolvedBareRepo: boolean }> {
  // Resolve bare repo names (directory basenames like "symphony-alpha") to
  // canonical owner/repo ("closedloop-ai/symphony-alpha") via the repos
  // registry. Without this, identity keys split by naming convention and
  // git_dir stays NULL (blocking all git/gh enrichment).
  const resolver = repoResolver ?? (await buildRepoResolver(tx));

  // FEA-2545: the per-ref writes below used to be a sequential N+1 — two serial
  // awaits per ref (an `artifacts` upsert then a `session_artifact_links`
  // upsert), so a session referencing R artifacts cost ~2R serial DB
  // round-trips on the main ingest path. Every derived value (identity keys,
  // ids, link ids) is a pure function of the ref, so we precompute them in
  // memory and collapse the writes into two multi-row
  // `INSERT … ON CONFLICT DO UPDATE` statements. Both run on this single
  // transaction client, so parallelizing with Promise.all would give no
  // benefit — batching does. On any batch failure we fall back to the original
  // per-ref path, which warn-and-continues on row-level errors, so the ingest
  // stays best-effort.
  const prepared = refs.map((ref) =>
    prepareArtifactRefRow(ref, resolver, sessionId, now)
  );

  // FEA-2875: surface whether any ref's non-null bare repo name was just
  // null-dropped by the (exact) resolver used for this write. The artifact still
  // persists with a NULL repo_full_name, so the backfill's
  // `captured === refs.length` invariant can't detect the drop — it reads this
  // flag to leave the session unseen and retry on a later sweep once the repo
  // lands in `repos`. Computed here (not re-derived by the caller) so the drop
  // decision always matches the resolver that actually persisted the row.
  const droppedUnresolvedBareRepo = prepared.some((p) => p.droppedBareRepo);

  let captured: number;
  try {
    captured = await persistArtifactRefsBatched(tx, prepared, sessionId);
  } catch (error) {
    // The fast path is normally silent-on-failure because the per-ref fallback
    // re-attempts every ref and warns on each true row-level drop. But a
    // systematic cause (schema drift, a malformed statement) surfaces FIRST as
    // this batch throw, so record it too — otherwise a batch-only failure the
    // fallback then recovers from leaves no signal that the fast path broke.
    log(
      `sqlite persistArtifactLinks: batched upsert failed for session ${sessionId}, falling back to per-ref: ${error instanceof Error ? error.message : String(error)}`
    );
    captured = await persistArtifactRefsRowByRow(tx, prepared, sessionId, log);
  }

  // Link propagation: if this session is linked to a branch that has a known
  // PR artifact, auto-link the session to the PR. Pure DB lookup — no gh calls.
  await propagateBranchPrLinks(tx, sessionId, now);

  return { captured, droppedUnresolvedBareRepo };
}

// FEA-2545: shared column lists and ON CONFLICT clauses so the batched fast
// path and the per-ref fallback issue byte-identical upserts (only the VALUES
// tuple count differs).
const ARTIFACT_UPSERT_COLUMNS =
  "(id, identity_key, kind, repo_full_name, git_dir, sha, branch_name, pr_number, slug, url, title, committed_at, created_at, last_seen_at)";
const ARTIFACT_UPSERT_CONFLICT = `ON CONFLICT(id) DO UPDATE SET
     last_seen_at = EXCLUDED.last_seen_at,
     repo_full_name = COALESCE(artifacts.repo_full_name, EXCLUDED.repo_full_name),
     git_dir = COALESCE(artifacts.git_dir, EXCLUDED.git_dir),
     url = COALESCE(artifacts.url, EXCLUDED.url),
     branch_name = COALESCE(artifacts.branch_name, EXCLUDED.branch_name),
     sha = COALESCE(artifacts.sha, EXCLUDED.sha),
     -- PRD-486: first non-null wins; the per-commit LOC enrichment may later
     -- overwrite committed_at with the exact git committer date directly.
     title = COALESCE(artifacts.title, EXCLUDED.title),
     committed_at = COALESCE(artifacts.committed_at, EXCLUDED.committed_at)
   WHERE artifacts.identity_key = EXCLUDED.identity_key`;
const LINK_UPSERT_COLUMNS =
  "(id, session_id, artifact_id, relation, method, evidence, is_primary, status, extractor_version, observed_at, created_at)";
const LINK_UPSERT_CONFLICT = `ON CONFLICT(session_id, artifact_id, relation) DO UPDATE SET
     method = EXCLUDED.method,
     evidence = EXCLUDED.evidence,
     status = EXCLUDED.status,
     observed_at = EXCLUDED.observed_at,
     extractor_version = EXCLUDED.extractor_version`;

// A ref reduced to its two upsert rows. Identity keys, ids and link ids are
// pure functions of the ref, so preparing them up front lets the batched path
// build both multi-row statements without any interleaved awaits.
type PreparedArtifactRef = {
  identityKey: string;
  artifactId: string;
  linkId: string;
  artifactValues: unknown[];
  linkValues: unknown[];
  // Retained so the batched fast path and the row-by-row fallback can apply the
  // per-ref set-once side effects (branch push state, FEA-2531 PR head branch)
  // that the sequential loop used to run inline after each successful upsert.
  ref: ArtifactRefRecord;
  // FEA-2875: this ref carried a non-null BARE repo name that the write path
  // null-dropped (below). The artifact still persists (with a NULL
  // repo_full_name), so the backfill's `captured === refs.length` check stays
  // satisfied — the boot backfill reads this to avoid stamping the session seen
  // while its repo is unresolved. See `persistArtifactLinks`' return value.
  droppedBareRepo: boolean;
};

// FEA-2866: the parser derives session.artifacts.repo from the cwd's last path
// component (extractRepoFromCwd), so worktree dirs (`agent-<hash>`), temp dirs
// (`nrev-*`), and plain repo folders all arrive here as BARE names with no
// owner. Persisting those made them surface as bogus "repositories" in the repo
// breakdowns. Prefer the git-validated repos-table resolution; otherwise keep
// the value ONLY when it is already a valid `owner/repo` slug (e.g. parsed from
// a PR/issue URL) and drop any unvalidated bare basename to null, so it groups
// under "Unknown" instead of a fake repository. Reuse the file's own
// `normalizeRepoFullName` validator (returns null on anything but a valid
// owner/repo) rather than a loose `includes("/")` check. gitDir already follows
// the resolver, so it stays null for dropped values.
function resolveRefRepo(
  ref: Pick<ArtifactRefRecord, "repoFullName">,
  repoResolver: RepoResolver
): { repoFullName: string | null; gitDir: string | null } {
  const resolved = repoResolver(ref.repoFullName ?? null);
  return {
    repoFullName:
      resolved?.repoFullName ?? normalizeRepoFullName(ref.repoFullName),
    gitDir: resolved?.gitDir ?? null,
  };
}

function prepareArtifactRefRow(
  ref: ArtifactRefRecord,
  repoResolver: RepoResolver,
  sessionId: string,
  now: string
): PreparedArtifactRef {
  const { repoFullName: resolvedRepoFullName, gitDir: resolvedGitDir } =
    resolveRefRepo(ref, repoResolver);
  // FEA-2875: a non-null bare name that neither the repos-table resolver nor the
  // `owner/repo` validator recovered was just dropped to null. A ref that never
  // carried a repo (null repoFullName) is NOT a drop — only a real bare name
  // that failed to resolve is.
  const droppedBareRepo =
    ref.repoFullName != null && resolvedRepoFullName === null;

  const identityKey = computeIdentityKey({
    kind: ref.targetKind as ArtifactKind,
    repoFullName: resolvedRepoFullName,
    gitDir: resolvedGitDir,
    sha: ref.sha ?? null,
    branchName: ref.branchName ?? null,
    prNumber: ref.prNumber ?? null,
    slug: ref.slug ?? null,
  });
  // The upsert's ON CONFLICT target is `id`, so the RETURNING id is always this
  // candidate id — we can use it directly as the link's artifact_id.
  const artifactId = artifactIdFromIdentityKey(identityKey);
  const linkId = artifactLinkId(
    sessionId,
    ref.targetKind,
    canonicalKeyForRef(ref),
    ref.relation
  );

  return {
    identityKey,
    artifactId,
    linkId,
    artifactValues: [
      artifactId,
      identityKey,
      ref.targetKind,
      resolvedRepoFullName,
      resolvedGitDir,
      ref.sha ?? null,
      ref.branchName ?? null,
      ref.prNumber ?? null,
      ref.slug ?? null,
      ref.prUrl ?? null,
      ref.message ?? null,
      ref.committedAt ?? null,
      now, // created_at
      now, // last_seen_at
    ],
    linkValues: [
      linkId,
      sessionId,
      artifactId,
      ref.relation,
      ref.method,
      ref.evidence,
      ref.isPrimary,
      "candidate",
      ref.extractorVersion,
      ref.observedAt,
      now,
    ],
    ref,
    droppedBareRepo,
  };
}

// Per-ref set-once side effects that the sequential loop ran inline after each
// successful artifact+link upsert. Preserved here so the batched fast path and
// the row-by-row fallback both apply them for every ref whose artifact
// persisted. Only branch-push refs and created-PR refs issue a write; all
// others short-circuit, so this adds no round-trips for the common case.
async function applyPersistedRefSideEffects(
  tx: Prisma.TransactionClient,
  ref: ArtifactRefRecord,
  artifactId: string,
  sessionId: string
): Promise<void> {
  // Set-once, earliest-wins push state on artifacts (not the link row, which is
  // wiped per reparse) so it survives the reparse cycle. MIN() keeps the
  // earliest push; COALESCE on push_source is set-once.
  if (
    ref.targetKind === "branch" &&
    BRANCH_PUSH_METHODS.has(ref.method) &&
    ref.observedAt
  ) {
    await tx.$executeRawUnsafe(
      `UPDATE artifacts
         SET first_pushed_at = MIN(COALESCE(first_pushed_at, $2), $2),
             push_source = COALESCE(push_source, 'session')
       WHERE id = $1`,
      artifactId,
      ref.observedAt
    );
  }
  // FEA-2531: a created-PR ref's re-derived head branch must reach the
  // pull_requests lifecycle row too. The IMPORT path writes it via
  // persistNormalizedPullRequests, but historical re-derivation flows only
  // through here, and the Branches page joins branch↔PR on
  // pull_requests.branch_name — without this, a worktree PR's head ref is
  // resolved by the extractor and then dropped for every already-imported
  // session. FILL-ONLY: an existing value may be import-authoritative or
  // GitHub-enriched (headRefName) and must not be clobbered or cleared.
  if (
    ref.targetKind === "pull_request" &&
    ref.relation === "created" &&
    ref.prUrl &&
    ref.branchName
  ) {
    await tx.$executeRawUnsafe(
      `UPDATE pull_requests
          SET branch_name = $3
        WHERE session_id = $1 AND pr_url = $2 AND branch_name IS NULL`,
      sessionId,
      ref.prUrl,
      ref.branchName
    );
  }
}

// Column counts for the two upserts, mirroring ARTIFACT_UPSERT_COLUMNS (14) and
// LINK_UPSERT_COLUMNS (11). Used to cap rows per multi-row statement so the
// bound-parameter count stays under the SQLite/libSQL variable limit — same
// discipline as the chunked event inserts (EVENT_INSERT_PARAM_CAP). The
// param-tuple/chunk primitives live in ./sql-values-tuples.js (ISS-4572 extract).
const ARTIFACT_UPSERT_COLUMN_COUNT = 14;
const LINK_UPSERT_COLUMN_COUNT = 11;
// Indices into `artifactValues` of every column ARTIFACT_UPSERT_CONFLICT
// COALESCE-fills: repo_full_name(3), git_dir(4), sha(5), branch_name(6), url(9),
// title(10), committed_at(11). Two refs sharing an identity key can carry a
// non-null value for one of these (e.g. a PR ref supplies branch_name that a
// transcript ref left null), so the batched dedup must merge all of them to
// match the sequential per-ref COALESCE — merging identity-equal columns is a
// harmless no-op. (id/identity_key/kind/pr_number/slug are not COALESCE targets.)
const ARTIFACT_COALESCE_VALUE_INDICES = [3, 4, 5, 6, 9, 10, 11];

// FEA-2545 fast path: collapse all refs into two multi-row upserts, chunked to
// respect the variable cap. Returns the number of refs whose artifact persisted
// (matching the per-ref path's `captured`, which the backfill relies on via
// `captured === refs.length`).
async function persistArtifactRefsBatched(
  tx: Prisma.TransactionClient,
  prepared: PreparedArtifactRef[],
  sessionId: string
): Promise<number> {
  if (prepared.length === 0) {
    return 0;
  }

  // Dedupe artifacts by id so no multi-row VALUES lists the same ON CONFLICT
  // target twice (which the engine rejects). Refs sharing an identity key have
  // identical identity-derived columns; the remaining COALESCE-filled columns
  // are merged first-non-null-wins, matching the sequential per-ref COALESCE
  // the original loop performed.
  const artifactRowsById = new Map<string, unknown[]>();
  for (const row of prepared) {
    const existing = artifactRowsById.get(row.artifactId);
    if (existing) {
      for (const i of ARTIFACT_COALESCE_VALUE_INDICES) {
        if (existing[i] === null && row.artifactValues[i] !== null) {
          existing[i] = row.artifactValues[i];
        }
      }
    } else {
      artifactRowsById.set(row.artifactId, [...row.artifactValues]);
    }
  }

  const persistedArtifactIds = new Set<string>();
  for (const chunk of chunkRowsByParamCap(
    [...artifactRowsById.values()],
    ARTIFACT_UPSERT_COLUMN_COUNT
  )) {
    const { tuples, params } = buildValuesTuples(chunk);
    const artifactRows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO artifacts
         ${ARTIFACT_UPSERT_COLUMNS}
       VALUES ${tuples.join(", ")}
       ${ARTIFACT_UPSERT_CONFLICT}
       RETURNING id`,
      ...params
    );
    for (const artifact of artifactRows) {
      persistedArtifactIds.add(artifact.id);
    }
  }

  // Only refs whose artifact actually persisted get a link. A missing id means
  // the candidate id collided with a row under a different identity key (the
  // WHERE guard rejected the update) — the per-ref path surfaced this via
  // requireArtifactUpsertId and skipped the ref; we skip it here the same way.
  const linkable = prepared.filter((row) =>
    persistedArtifactIds.has(row.artifactId)
  );
  if (linkable.length === 0) {
    return 0;
  }

  // Dedupe the link batch by link id so no multi-row VALUES repeats an ON
  // CONFLICT target. `captured` still counts every persisted ref, so duplicate
  // refs collapse in the write but not in the returned count. Keep the LAST ref
  // per link id (unconditional set): LINK_UPSERT_CONFLICT overwrites unconditionally
  // (method/evidence/status/... = EXCLUDED.*), so the sequential per-ref path let
  // the last ref win — e.g. an appended launch_metadata ref must supersede an
  // earlier slug_in_message ref for the same session/artifact/relation.
  const linkRowsById = new Map<string, unknown[]>();
  for (const row of linkable) {
    linkRowsById.set(row.linkId, row.linkValues);
  }
  for (const chunk of chunkRowsByParamCap(
    [...linkRowsById.values()],
    LINK_UPSERT_COLUMN_COUNT
  )) {
    const { tuples, params } = buildValuesTuples(chunk);
    await tx.$executeRawUnsafe(
      `INSERT INTO session_artifact_links
         ${LINK_UPSERT_COLUMNS}
       VALUES ${tuples.join(", ")}
       ${LINK_UPSERT_CONFLICT}`,
      ...params
    );
  }

  // Per-ref set-once side effects, applied for every ref whose artifact
  // persisted — matching the sequential loop, which ran them inline after each
  // successful upsert.
  for (const row of linkable) {
    await applyPersistedRefSideEffects(tx, row.ref, row.artifactId, sessionId);
  }

  return linkable.length;
}

// FEA-2545 fallback: the original one-upsert-pair-per-ref path, used only when
// the batch statement fails. Preserves warn-and-continue: a row-level failure
// is swallowed and the remaining refs still persist.
async function persistArtifactRefsRowByRow(
  tx: Prisma.TransactionClient,
  prepared: PreparedArtifactRef[],
  sessionId: string,
  log: (message: string) => void
): Promise<number> {
  let captured = 0;
  for (const row of prepared) {
    try {
      const artifactRows = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO artifacts
           ${ARTIFACT_UPSERT_COLUMNS}
         VALUES ${sqlValuesTuple(0, row.artifactValues.length)}
         ${ARTIFACT_UPSERT_CONFLICT}
         RETURNING id`,
        ...row.artifactValues
      );
      // Throws (caught below) on an identity-key collision, matching the
      // original guard; the returned id equals row.artifactId used in the link.
      requireArtifactUpsertId(
        artifactRows[0]?.id,
        row.artifactId,
        row.identityKey
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO session_artifact_links
           ${LINK_UPSERT_COLUMNS}
         VALUES ${sqlValuesTuple(0, row.linkValues.length)}
         ${LINK_UPSERT_CONFLICT}`,
        ...row.linkValues
      );
      await applyPersistedRefSideEffects(
        tx,
        row.ref,
        row.artifactId,
        sessionId
      );
      captured++;
    } catch (error) {
      // Row-level failure: log warning, continue processing other refs. A
      // systematic cause (schema drift, constraint violation, bad ref) would
      // otherwise drop artifact links silently, leaving the Branches surface
      // with missing links and no telemetry to trace them back.
      log(
        `sqlite persistArtifactLinks: dropped artifact ref for session ${sessionId} (artifact ${row.artifactId}, kind ${row.ref.targetKind}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return captured;
}

// PRD-486: an artifact upsert must return the row id; a missing id means the
// ON CONFLICT path raced or the identity key collided, which we surface rather
// than silently linking to a candidate id that was never persisted.
function requireArtifactUpsertId(
  returnedId: string | undefined,
  candidateId: string,
  identityKey: string
): string {
  if (returnedId) {
    return returnedId;
  }
  throw new Error(`artifact id collision for ${candidateId} (${identityKey})`);
}

type ResolvedRepo = { repoFullName: string; gitDir: string };

/** Resolves a bare or full repo name to its canonical owner/repo + git_dir. */
export type RepoResolver = (bareOrFull: string | null) => ResolvedRepo | null;

// The only DB capability buildRepoResolver needs. Kept structural (rather than a
// full `Prisma.TransactionClient`) so it can also be built from the read-only
// desktop client — letting a caller build the resolver ONCE outside the write
// transaction and reuse it (FEA-2777).
type RepoResolverSource = Pick<Prisma.TransactionClient, "$queryRawUnsafe">;

export async function buildRepoResolver(
  source: RepoResolverSource
): Promise<RepoResolver> {
  const rows = await source.$queryRawUnsafe<
    {
      repo_full_name: string;
      git_dir: string;
    }[]
  >(
    "SELECT repo_full_name, git_dir FROM repos WHERE repo_full_name IS NOT NULL AND git_dir != ''"
  );

  // Index by exact full name and by bare trailing component (the repo dir name).
  // Bare-name collisions are theoretically possible (two orgs, same repo name);
  // the first match wins — good enough for desktop-local resolution.
  const byFull = new Map<string, ResolvedRepo>();
  const byBare = new Map<string, ResolvedRepo>();
  for (const row of rows) {
    const entry: ResolvedRepo = {
      repoFullName: row.repo_full_name,
      gitDir: row.git_dir,
    };
    byFull.set(row.repo_full_name, entry);
    // git_dir is like "/home/user/Workspace/symphony-alpha/.git"
    const dirName = row.git_dir
      .replace(GIT_DIR_SUFFIX_RE, "")
      .split("/")
      .at(-1);
    if (dirName) {
      byBare.set(dirName, entry);
    }
  }

  return (bareOrFull: string | null): ResolvedRepo | null => {
    if (!bareOrFull) {
      return null;
    }
    if (bareOrFull.includes("/")) {
      return byFull.get(bareOrFull) ?? null;
    }
    if (byBare.has(bareOrFull)) {
      return byBare.get(bareOrFull)!;
    }
    // Worktree suffix heuristic: strip -<type>-<identifier> patterns
    const suffixMatch = bareOrFull.match(WORKTREE_SUFFIX_RE);
    if (suffixMatch?.[1] && byBare.has(suffixMatch[1])) {
      return byBare.get(suffixMatch[1])!;
    }
    return null;
  };
}
