/**
 * @file rehearsal-build-store.ts
 * @description ISS-5104 (PRD-611 gap 4) — Phase A of the DATA_REVISION rebuild
 * rehearsal: build a desktop store from the golden corpus using THIS checkout's
 * importer, plus a manifest of per-session pre-state. The rehearsal workflow
 * runs this inside the PR's MERGE-BASE worktree, so the store is "written by
 * previous code"; `rehearsal-verify.ts` then runs the CURRENT code's boot path
 * (migrations → runDataRevisionRebuild → backfills) over it.
 *
 * ISS-5466 additionally synthesizes ONE missing-source fixture session into the
 * store (`injectMissingSourceFixture`) — the shape the frozen corpus cannot
 * supply — and runs the boot backfills over the corpus's Codex dossiers as well
 * as its Claude ones.
 *
 * ISS-9284 snapshots the manifest PER CONSUMING VIEW (see
 * {@link REHEARSAL_PROJECTION_TARGET}) instead of one flat per-session pair, and
 * claims an owner identity over the store (`claimRehearsalOwnerIdentity`) — the
 * second shape the rehearsal structurally cannot produce, since nothing here
 * signs in.
 *
 * COPY-IN COMPATIBILITY (do not break): when a merge-base predates this script,
 * the workflow copies the PR's copy of THIS ONE FILE into the merge-base
 * worktree and runs it there. It must therefore stay self-contained (no imports
 * from sibling rehearsal modules) and import only long-stable desktop modules:
 * `openSqliteAgentDatabase`, `CollectorManager`, the golden-mode staging helpers
 * (FEA-2648), and the two post-import backfills. ISS-5466 widened that surface
 * by four: `sessionIdFromRolloutPath` (collectors/codex/codex-home),
 * `parseRolloutFile` (collectors/codex/codex-parser), `Harness`
 * (@repo/lib/harness/types) and `DESKTOP_AGENT_STATUS`
 * (database/db-constants). PR #6728 review (whitlockk) widened it by two more from
 * that SAME already-imported module — `BRANCH_WRITE_METHOD_VALUES` and
 * `sqlStringList` (FEA-2531, landed 2026-07-07, so older than any merge-base
 * this workflow runs against) — because the Branches count must be qualified by
 * the method list the Branches read applies, and inlining those strings here
 * would be exactly the SSOT drift the shared constant exists to prevent.
 * Renaming or relocating any of them makes Phase A
 * die with a module-resolution error inside the merge-base worktree rather than
 * producing a rehearsal result — keep them, or update this file in the same
 * change. The fixture is written with raw SQL against `sessions`/`events`/
 * `agents` for the same reason — among the oldest tables in the schema, where
 * any importer helper is not. `rehearsal-verify.ts` imports the shared helpers
 * exported here; the guarded `main()` below keeps that import side-effect-free.
 *
 * Usage: pnpm exec tsx scripts/rehearsal-build-store.ts --out <dir>
 * Output: <dir>/agent-dashboard.sqlite (cleanly closed) + <dir>/manifest.json
 */
import { mkdtempSync, readdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Harness, type NormalizedSession } from "@repo/lib/harness/types";
import { sessionIdFromRolloutPath } from "../src/main/collectors/codex/codex-home.js";
import { parseRolloutFile } from "../src/main/collectors/codex/codex-parser.js";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import {
  classifyRawFiles,
  listDossierDirs,
} from "../src/main/collectors/golden/corpus-layout.js";
import {
  createGoldenCollectors,
  stageGoldenCorpus,
} from "../src/main/collectors/golden/golden-collectors.js";
import { backfillActivitySegmentsFromTranscripts } from "../src/main/collectors/parsing/activity-segment-backfill.js";
import { backfillArtifactLinksFromTranscripts } from "../src/main/collectors/parsing/artifact-link-backfill.js";
import {
  BRANCH_WRITE_METHOD_VALUES,
  DESKTOP_AGENT_STATUS,
  sqlStringList,
} from "../src/main/database/db-constants.js";
// TYPE-ONLY, deliberately — see `RehearsalProjectionCounts` below. Erased
// before module resolution, so the copy-in contract in the header is unbroken.
import type { ProjectionTarget as CanonicalProjectionTarget } from "../src/main/database/derived-projection-revision.js";
// TYPE-ONLY for the same reason — the owner identity PAIR the manifest carries
// is the canonical `SessionIdentity` shape, not a second declaration of it.
import type { SessionIdentity } from "../src/main/database/session-owner-identity.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

/**
 * Fixed clock for both rehearsal phases: later than every timestamp in the
 * frozen corpus, so every imported session classifies as terminal (the rebuild
 * skips active sessions) and reruns are deterministic (no wall-clock reliance).
 */
export const REHEARSAL_NOW_ISO = "2027-01-01T00:00:00.000Z";

/** The store file name under the rehearsal output dir (dataDir = this file). */
export const REHEARSAL_STORE_FILE = "agent-dashboard.sqlite";

/** The manifest file name under the rehearsal output dir. */
export const REHEARSAL_MANIFEST_FILE = "manifest.json";

/**
 * ISS-9284: the consuming views a rebuild can destroy, snapshotted one at a
 * time so Phase B can classify a record INDEPENDENTLY per view. Values are the
 * `ProjectionTarget` values in `src/main/database/derived-projection-revision.ts`.
 *
 * DUPLICATED HERE, NOT IMPORTED AS A VALUE, for the header's copy-in reason:
 * this file is run inside the PR's MERGE-BASE worktree, and
 * `derived-projection-revision.ts` is an ISS-8741 module a merge-base predating
 * it does not have — a value import would make Phase A die with a
 * module-resolution error instead of producing a rehearsal result.
 *
 * The copy is held to the original at COMPILE TIME in both directions, so
 * neither list can move without the other: `RehearsalProjectionCounts` below is
 * keyed by the CANONICAL `ProjectionTarget` while `collectSessionStates` builds
 * its literal out of THIS list, and `rehearsal-verify-checks.ts` builds its
 * manifest schema from the canonical set under a keys-covered `Record`. Both are
 * reached by `tsconfig.tests.json` (these scripts are typechecked as
 * dependencies of their own tests), verified by mutating each list in turn.
 */
export const REHEARSAL_PROJECTION_TARGET = {
  Sessions: "sessions",
  Branches: "branches",
  Owner: "owner",
  Aggregate: "aggregate",
} as const;

export type RehearsalProjectionTarget =
  (typeof REHEARSAL_PROJECTION_TARGET)[keyof typeof REHEARSAL_PROJECTION_TARGET];

/**
 * Per-view row counts for one session — the unit ISS-9284 replaced the flat
 * per-session pair with. A single count per session made a record VALID for
 * Sessions and BROKEN for Branches indistinguishable from a wholly valid one:
 * one view fabricating validity for another.
 *
 * KEYED BY THE CANONICAL `ProjectionTarget`, NOT by the local copy above — that
 * is what ties the two together at compile time, in the direction the read side
 * cannot cover. `rehearsal-verify-checks.ts`'s keys-covered `Record` fails `tsc`
 * when the canonical set grows, but nothing there notices if THIS list is the
 * one left behind: the manifest would simply stop carrying a view, which is the
 * exact failure ISS-9284 exists to end. Because `collectSessionStates` builds
 * its literal out of `REHEARSAL_PROJECTION_TARGET` and must satisfy this type, a
 * canonical view the local list lacks is a MISSING key and a local value the
 * canonical set lacks is an UNKNOWN one. Either way, `tsc` — verified by
 * mutating each list in turn.
 *
 * The import it rests on is TYPE-ONLY, which is why this does not break the
 * header's copy-in contract: `import type` is erased syntactically before any
 * module resolution happens, so a merge-base worktree predating
 * `derived-projection-revision.ts` runs this file with no reference to it at
 * all. Do NOT convert it to a value import — that is precisely the
 * module-resolution death the header warns about.
 */
export type RehearsalProjectionCounts = Record<
  CanonicalProjectionTarget,
  number
>;

export type RehearsalSessionState = {
  id: string;
  dataRevision: number;
  projections: RehearsalProjectionCounts;
  /**
   * The Owner projection's actual VALUES, not just how many of them are
   * non-null.
   *
   * PR #6728 review (whitlockk): `projections.owner` counts non-null identity
   * columns, and a COUNT cannot see a SUBSTITUTION — an importer regression that
   * replaced both ids with a different non-null pair still reads as 2, so the
   * rehearsal stayed green while every owner facet pointed at someone else.
   * Blanking is the count's job; REATTRIBUTION is this pair's, adjudicated by
   * `ownerReattributionViolations` in `rehearsal-verify-checks.ts` against the
   * pair Phase A recorded.
   */
  ownerIdentity: SessionIdentity;
};

/**
 * ISS-5466: the id of the dedicated missing-source fixture session Phase A
 * synthesizes (see `injectMissingSourceFixture`). Deliberately NOT a UUID, so it
 * can never collide with a corpus dossier id and no collector's
 * `sessionIdForSource` can ever map a staged file onto it.
 */
const MISSING_SOURCE_FIXTURE_SESSION_ID = "iss5466-missing-source-fixture";

/**
 * ISS-5466: the `events.agent_id` the fixture strands. `events.agent_id` carries
 * an index but deliberately NO foreign key, so this row is legal in the store —
 * the FK only bites downstream, when the stored-row bridge copies the id into
 * `agent_component_invocations.agent_id`, which DOES have one. The
 * `-sub-toolu_…` spelling is the ISS-4592 twin-retirement shape ISS-5098's own
 * producer-discriminating query names.
 */
const MISSING_SOURCE_FIXTURE_ORPHAN_AGENT_ID = `${MISSING_SOURCE_FIXTURE_SESSION_ID}-sub-toolu_iss5466_retired_twin`;

/**
 * ISS-5466: the fixture's SECOND agent reference, this one backed by a real
 * `agents` row. It is the control for the control.
 *
 * The orphan above proves the ISS-5098 guard fired only if the builder still
 * copies `events.agent_id` into the candidate at all. A future change that
 * stopped copying it would remove the FK hazard, leave the fixture's invocation
 * rows landing happily with a null `agent_id`, and quietly turn the whole
 * positive control into a tautology. This resolvable reference cannot survive
 * that change: it must come out NON-null, so Phase B can tell "the guard
 * dropped an unresolvable id" apart from "nothing copies ids any more".
 */
const MISSING_SOURCE_FIXTURE_RESOLVED_AGENT_ID = `${MISSING_SOURCE_FIXTURE_SESSION_ID}-agent-resolvable`;

/** Timestamp for every fixture row; inside the frozen corpus's own span. */
const MISSING_SOURCE_FIXTURE_AT = "2026-07-05T15:00:00.000Z";

/** A stale `data_revision`: any value but the current one is re-derived. */
const MISSING_SOURCE_FIXTURE_STALE_REVISION = 1;

/** The invocation projection's table — the Sessions view's per-session rows. */
const INVOCATION_TABLE = "agent_component_invocations";

/** The two tables the Branches view's per-session attribution is a join over. */
const BRANCH_LINK_TABLE = "session_artifact_links";
const ARTIFACT_TABLE = "artifacts";

/**
 * The Wrote-method gate, as the SQL fragment `branch-reads.ts` builds from the
 * same tuple. PR #6728 review (whitlockk): without it the snapshot counted EVERY
 * link to a branch artifact, a strictly WIDER population than the Branches view
 * reads — so a rebuild that swapped a `git_commit` link for a `git_checkout`
 * one (a workspace touch, not write evidence) left the count flat while the
 * Branches surface silently dropped the session. A loss detector that stays
 * green through the loss is the defect this ticket exists to end, so the count
 * is method-qualified with the exact list the read applies.
 */
const BRANCH_WRITE_METHOD_SQL = sqlStringList(BRANCH_WRITE_METHOD_VALUES);

/**
 * Probe for the projection tables a store built by an old merge-base may
 * predate. Shared by the manifest snapshot and the fixture's derived-state
 * reset: both must tolerate a table's absence rather than abort Phase A with a
 * SQL error, and one spelling of the probe keeps them from drifting apart.
 *
 * ONE query over all three, not one per table, so the probe stays a single
 * round trip no matter how many views the snapshot grows.
 */
const PROJECTION_TABLE_PROBE_SQL = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('${INVOCATION_TABLE}', '${BRANCH_LINK_TABLE}', '${ARTIFACT_TABLE}')`;

/** Open the rehearsal store with the fixed rehearsal defaults. */
export function openRehearsalDb(outDir: string): Promise<SqliteAgentDatabase> {
  return openSqliteAgentDatabase({
    dataDir: path.join(outDir, REHEARSAL_STORE_FILE),
    detectBillingMode: () => "metered_api",
    now: () => REHEARSAL_NOW_ISO,
    // The frozen corpus spans more than the 90-day default data-governance
    // window, and the fixed clock sits after every corpus timestamp — without
    // this, Phase B's boot-time retention sweep would purge the whole store
    // before the rebuild runs. 100 years keeps every dossier retained.
    retentionDays: 36_500,
  });
}

/**
 * The staged corpus's Claude main transcripts, for injecting into the two
 * transcript backfills (their default enumeration walks the operator's REAL
 * `~/.claude` tree — never acceptable in a rehearsal). Mirrors the
 * classification walk in `createGoldenCollectors`, which does not export its
 * per-harness source lists.
 */
export function listStagedClaudeMains(stagingDir: string): string[] {
  const mains: string[] = [];
  for (const { sessionId, dir } of listDossierDirs(stagingDir)) {
    const classification = classifyRawFiles(readdirSync(dir), sessionId);
    if (classification.kind === "claude") {
      mains.push(path.join(dir, classification.main));
    } else if (
      classification.kind === "opencode" ||
      classification.kind === "codex"
    ) {
      // Not this function's concern — skip known non-Claude kinds.
    } else {
      // ISS-7504: inline guard — not imported from corpus-layout because the
      // rehearsal workflow's copy-in contract copies THIS file into a merge-base
      // worktree where that export may not exist yet.
      const _exhaustive: never = classification;
      throw new Error(
        `unrecognised raw-file classification kind: ${(_exhaustive as { kind: string }).kind}`
      );
    }
  }
  return mains;
}

/**
 * ISS-5466: the staged corpus's Codex rollout transcripts. The Claude sibling
 * above used to be the whole list, so the corpus's Codex dossiers were scanned
 * by the collectors but never by the two boot backfills — production runs both
 * harnesses through `BUILTIN_TRANSCRIPT_SOURCES`, so the rehearsal was less than
 * the boot path it claims to mirror.
 */
export function listStagedCodexRollouts(stagingDir: string): string[] {
  const rollouts: string[] = [];
  for (const { sessionId, dir } of listDossierDirs(stagingDir)) {
    const classification = classifyRawFiles(readdirSync(dir), sessionId);
    if (classification.kind === "codex") {
      for (const rollout of classification.rollouts) {
        rollouts.push(path.join(dir, rollout));
      }
    } else if (
      classification.kind === "opencode" ||
      classification.kind === "claude"
    ) {
      // Not this function's concern — skip known non-Codex kinds.
    } else {
      // ISS-7504: inline guard — same copy-in reason as listStagedClaudeMains.
      const _exhaustive: never = classification;
      throw new Error(
        `unrecognised raw-file classification kind: ${(_exhaustive as { kind: string }).kind}`
      );
    }
  }
  return rollouts;
}

/**
 * Which post-import backfill a vacuity guard is speaking about. Both are
 * guarded, so the message has to name one.
 */
export const REHEARSAL_BACKFILL = {
  ArtifactLinks: "artifact-link",
  ActivitySegments: "activity-segment",
} as const;

export type RehearsalBackfill =
  (typeof REHEARSAL_BACKFILL)[keyof typeof REHEARSAL_BACKFILL];

/**
 * Run the two post-import boot backfills over the staged transcripts of ONE
 * harness and report its counters.
 *
 * The injection hooks are single-harness by design — one `listTranscriptFiles`,
 * one `sessionIdFromPath`, one `parseSessionFile` — so each harness needs its
 * own pass with its own adapters. Appending Codex rollouts to the Claude list
 * instead is the trap ISS-5466 names: the Claude id extractor reads a rollout's
 * whole basename (`rollout-<date>-<uuid>`), which matches no `sessions.id`, so
 * no rollout is ever captured and the harness is covered in name only.
 * `assertHarnessCaptured` is what makes that outcome fail rather than pass.
 *
 * `harness` reaches only the activity-segment backfill: it is that backfill's
 * FEA-2269 evidence-adapter selector, and `backfillArtifactLinksFromTranscripts`
 * declares no such option. Passing it to both in one shared object compiled
 * (excess-property checking does not apply to a variable) and was silently
 * dropped, which reads as if the artifact-link pass were harness-aware.
 */
async function runHarnessBackfills(
  db: SqliteAgentDatabase,
  log: (message: string) => void,
  harness: Harness,
  files: string[],
  injection: {
    sessionIdFromPath: (filePath: string) => string;
    parseSessionFile?: (filePath: string) => Promise<NormalizedSession | null>;
  }
): Promise<{ errors: number; scanned: number }> {
  if (files.length === 0) {
    throw new Error(
      `no staged ${harness} transcripts — both backfills would run over an empty file list and pass vacuously. The frozen corpus is expected to carry at least one ${harness} dossier; if it deliberately no longer does, drop this harness's pass rather than letting it run empty.`
    );
  }
  const listTranscriptFiles = () => files;
  const artifactLinks = await backfillArtifactLinksFromTranscripts(db.prisma, {
    log,
    listTranscriptFiles,
    ...injection,
  });
  const activitySegments = await backfillActivitySegmentsFromTranscripts(
    db.prisma,
    { log, harness, listTranscriptFiles, ...injection }
  );
  // BOTH counters, per harness. A single transcript legitimately carrying no
  // ClosedLoop/PR/branch reference captures no links — but the frozen corpus is
  // not a single transcript, and over the whole of it each wired harness
  // captures links in bulk (measured: claude 186 links / 16 segments, codex 28
  // links / 11 segments). Guarding segments alone left the artifact-ref
  // extraction unmeasured: it could regress to `captured === 0` with no errors
  // while segments still tiled, and the lane stayed green.
  assertHarnessCaptured(
    REHEARSAL_BACKFILL.ArtifactLinks,
    harness,
    files.length,
    artifactLinks
  );
  assertHarnessCaptured(
    REHEARSAL_BACKFILL.ActivitySegments,
    harness,
    files.length,
    activitySegments
  );
  return {
    errors: artifactLinks.errors + activitySegments.errors,
    scanned: artifactLinks.scanned + activitySegments.scanned,
  };
}

/**
 * Throw when one backfill captured nothing from a harness's staged transcripts.
 *
 * Gated on `captured === 0` against the FILE COUNT, deliberately, not against
 * `scanned`. Both backfills do `skipped++; continue;` for a transcript whose
 * extracted session id is not in `existingSessionIds` — BEFORE `scanned++` — so
 * the total id-resolution drift this guard exists to catch produces
 * `scanned: 0`, and a `scanned > 0` precondition would make the guard inert
 * against its own subject. (It was written that way first; the review caught it.)
 *
 * The message therefore does NOT assert a cause. Unresolvable ids are the
 * expected one, but an extractor regression, a whole-harness parse failure and
 * a cancelled sweep land here too, and a guard that names the wrong culprit
 * costs the next reader more than it saves.
 */
export function assertHarnessCaptured(
  backfill: RehearsalBackfill,
  harness: Harness,
  fileCount: number,
  result: { scanned: number; captured: number }
): void {
  if (result.captured === 0) {
    throw new Error(
      `${harness} ${backfill} backfill captured nothing from ${fileCount} staged transcript(s) (scanned=${result.scanned}) — this harness is covered in name only. Most likely its session-id extractor no longer resolves the staged corpus's paths; an extraction regression or a whole-harness parse failure would also land here.`
    );
  }
}

/**
 * Run the two post-import boot backfills over every staged harness and report
 * the aggregate error counters. Both backfills swallow per-file failures into
 * `errors` rather than throwing, so a caller that discards the results lets a
 * wholly broken backfill leave the rehearsal green — callers MUST fail on a
 * non-zero total.
 */
export async function runRehearsalBackfills(
  db: SqliteAgentDatabase,
  stagingDir: string,
  log: (message: string) => void
): Promise<{ errors: number; scanned: number }> {
  const claude = await runHarnessBackfills(
    db,
    log,
    Harness.Claude,
    listStagedClaudeMains(stagingDir),
    // Staging flattens each Claude dossier to `<sessionId>/<sessionId>.jsonl`.
    { sessionIdFromPath: (filePath) => path.basename(filePath, ".jsonl") }
  );
  const codex = await runHarnessBackfills(
    db,
    log,
    Harness.Codex,
    listStagedCodexRollouts(stagingDir),
    {
      sessionIdFromPath: sessionIdFromRolloutPath,
      parseSessionFile: parseRolloutFile,
    }
  );
  return {
    errors: claude.errors + codex.errors,
    scanned: claude.scanned + codex.scanned,
  };
}

/** Throw when either post-import backfill reported a per-file failure. */
export function assertBackfillsClean(result: {
  errors: number;
  scanned: number;
}): void {
  if (result.errors > 0) {
    throw new Error(
      `post-import backfills reported ${result.errors} per-file error(s) across ${result.scanned} scanned transcript(s)`
    );
  }
}

/**
 * Per-session store state: data_revision plus a ROW COUNT PER CONSUMING VIEW.
 *
 * Counts, not booleans — an `EXISTS` probe only catches total loss, so a rebuild
 * that dropped 51 of a session's 52 invocation rows would still look preserved.
 *
 * ISS-9284: per view, not one flat pair. What each count is, and why it is the
 * thing that view actually loses:
 *
 *  - `sessions` — `agent_component_invocations` rows, the per-session derived
 *    detail the Sessions view renders.
 *  - `branches` — `session_artifact_links` rows WHOSE METHOD IS WRITE EVIDENCE
 *    (`BRANCH_WRITE_METHOD_VALUES`), joined to a `kind='branch'` artifact. Since
 *    FEA-1899 that join IS the Branches view's attribution (`branch-reads.ts`),
 *    and the re-import deletes and re-derives those links
 *    (`write-core-import-phases-links.ts`), so a rebuild can genuinely drop one.
 *    The method gate is what makes the count the SURFACE's population rather
 *    than a wider one — see `BRANCH_WRITE_METHOD_SQL`.
 *  - `owner` — how many of the two `session-owner-identity.ts` identity columns
 *    survive. Not a child-row count because the owner projection is not made of
 *    child rows; a session blanked back to unowned falls out of every owner
 *    facet exactly as a session that lost its branch link falls out of Branches.
 *    The count answers BLANKING only, so the pair's actual VALUES are
 *    snapshotted alongside it (`ownerIdentity`) — see that field for why a count
 *    cannot see a reattribution.
 *  - `aggregate` — `session_analytics` rows, the rollup projection.
 *
 * Tolerates a store predating any of those tables (an old merge-base) by
 * reporting 0 for the affected view rather than aborting Phase A with a SQL
 * error. The identity columns are not probed: they predate this lane's own
 * migrations, so a store this script can open always has them.
 */
export async function collectSessionStates(
  db: SqliteAgentDatabase
): Promise<RehearsalSessionState[]> {
  const tables = new Set(
    (
      await db.prisma.client.$queryRawUnsafe<{ name: string }[]>(
        PROJECTION_TABLE_PROBE_SQL
      )
    ).map((row) => row.name)
  );
  const invocationsExpr = tables.has(INVOCATION_TABLE)
    ? `(SELECT COUNT(*) FROM ${INVOCATION_TABLE} i WHERE i.session_id = s.id)`
    : "0";
  const branchesExpr =
    tables.has(BRANCH_LINK_TABLE) && tables.has(ARTIFACT_TABLE)
      ? `(SELECT COUNT(*) FROM ${BRANCH_LINK_TABLE} sal
            JOIN ${ARTIFACT_TABLE} art ON art.id = sal.artifact_id AND art.kind = 'branch'
           WHERE sal.session_id = s.id
             AND sal.method IN (${BRANCH_WRITE_METHOD_SQL}))`
      : "0";
  // Every column is aliased camelCase in the SQL rather than destructured from
  // the raw snake_case names: these are aliases this query chooses, not a
  // third-party wire format, so the repo's camelCase-identifier rule applies.
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{
      id: string;
      dataRevision: number;
      invocationCount: number;
      branchCount: number;
      ownerCount: number;
      ownerUserId: string | null;
      ownerOrganizationId: string | null;
      analyticsCount: number;
    }>
  >(
    `SELECT s.id, s.data_revision AS dataRevision,
       ${invocationsExpr} AS invocationCount,
       ${branchesExpr} AS branchCount,
       ((s.user_id IS NOT NULL) + (s.organization_id IS NOT NULL)) AS ownerCount,
       s.user_id AS ownerUserId,
       s.organization_id AS ownerOrganizationId,
       (SELECT COUNT(*) FROM session_analytics a WHERE a.session_id = s.id) AS analyticsCount
     FROM sessions s ORDER BY s.id`
  );
  return rows.map((row) => ({
    id: row.id,
    dataRevision: Number(row.dataRevision),
    projections: {
      [REHEARSAL_PROJECTION_TARGET.Sessions]: Number(row.invocationCount),
      [REHEARSAL_PROJECTION_TARGET.Branches]: Number(row.branchCount),
      [REHEARSAL_PROJECTION_TARGET.Owner]: Number(row.ownerCount),
      [REHEARSAL_PROJECTION_TARGET.Aggregate]: Number(row.analyticsCount),
    },
    ownerIdentity: {
      userId: row.ownerUserId ?? null,
      organizationId: row.ownerOrganizationId ?? null,
    },
  }));
}

/** Stage the frozen corpus into a fresh temp dir and return the staging path. */
export function stageCorpusIntoTemp(): string {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".."
  );
  const corpusDir = path.join(repoRoot, "packages", "golden-sessions");
  const stagingDir = mkdtempSync(
    path.join(os.tmpdir(), "iss5104-golden-staging-")
  );
  stageGoldenCorpus(corpusDir, stagingDir);
  return stagingDir;
}

async function runBootImport(
  db: SqliteAgentDatabase,
  stagingDir: string,
  log: (message: string) => void
): Promise<void> {
  const collectors = createGoldenCollectors(stagingDir);
  if (collectors.length === 0) {
    throw new Error("golden corpus produced no collectors — empty staging dir");
  }
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "iss5104-state-"));
  let resolveBootComplete!: () => void;
  const bootComplete = new Promise<void>((resolve) => {
    resolveBootComplete = resolve;
  });
  const manager = new CollectorManager({
    importer: db.importer,
    stateDir,
    emit: () => {},
    getCollectionMode: () => "disabled",
    onBootImportComplete: () => {
      resolveBootComplete();
    },
    collectors,
    catchupPollMs: null,
  });
  manager.start();
  await bootComplete;
  await manager.stop();
  await rm(stateDir, { recursive: true, force: true });
  log("boot import complete");
}

/**
 * ISS-5466: synthesize the ONE session shape the golden corpus structurally
 * cannot supply — a terminal, stale session with NO surviving source transcript,
 * carrying the ISS-5098 orphan (`events.agent_id` with no `agents` row).
 *
 * Why a synthesized fixture and not a dossier: every golden-corpus session has
 * its source present by construction (staging copies each dossier's `raw/`
 * before the collectors are pointed at it), so `missingSource` is 0 in every
 * run and the repair tail's stored-row bridge — `rebuildComponentInvocations-
 * FromStoredRows` → `storedEventCandidates` → `ensureStored…`/`insertInvocation-
 * Rows` — never engages. Deleting a dossier's transcript to manufacture the
 * shape would mutate the frozen oracle, which `packages/golden-sessions/
 * AGENTS.md` forbids. The fixture is written straight into the store instead, so
 * the corpus is untouched.
 *
 * Raw SQL on purpose: this file is copied into the PR's MERGE-BASE worktree and
 * run there (see the header's copy-in contract), so it must depend only on
 * surfaces old code also has. `sessions`, `events` and `agents` are among the
 * oldest tables in the schema; any importer/collector helper is not.
 *
 * TWO tool events, both required (see `MISSING_SOURCE_FIXTURE_RESOLVED_AGENT_ID`):
 * one naming the orphan, one naming a real `agents` row. Phase B asserts the
 * first comes out nulled and the second does not.
 *
 * Deliberately leaves `agent_component_invocations` EMPTY for this session: the
 * bridge materializing rows from the stored events is what Phase B measures, and
 * a pre-seeded row would make that gain unobservable.
 *
 * Idempotent by ON CONFLICT, including the stale `data_revision` reset: the
 * documented usage is `--out <dir>`, and a second run against an existing dir
 * would otherwise do the whole boot import and both backfill passes and then die
 * on `UNIQUE constraint failed: sessions.id`. Re-stamping the stale revision is
 * part of that — a fixture left at the revision the previous run sealed is no
 * longer selected as stale, and the rehearsal would report a missing-source
 * population that does not match what Phase A staged.
 *
 * Idempotent over the fixture's DERIVED rows too, which the upserts alone do not
 * reach. Re-opening an existing `--out` store runs boot maintenance over the
 * events the previous run left behind, and it materializes
 * `agent_component_invocations` and `session_analytics` for the fixture BEFORE
 * this transaction runs (measured on a second `--out` run: 3 invocation rows and
 * 1 analytics row). Those rows would be snapshotted as the fixture's pre-state,
 * and Phase B would then correctly reject its own positive control as vacuous —
 * `storedRowBridgeViolations` requires a zero pre-state, since a fixture that
 * arrived already carrying rows proves nothing about the bridge. Deleting them
 * inside the same transaction is what makes the retry produce the same store the
 * first run did.
 */
export async function injectMissingSourceFixture(
  db: SqliteAgentDatabase
): Promise<string> {
  const sessionId = MISSING_SOURCE_FIXTURE_SESSION_ID;
  // One transaction: a `sessions` row committed without its `events` rows would
  // make Phase B report "gained no component-invocation rows — the ISS-5098
  // shape" for a fixture that was never fully written, blaming the production
  // guard for a Phase A failure. `prisma.write` serializes on the write queue
  // but is not itself atomic.
  await db.prisma.write((client) =>
    client.$transaction(async (tx) => {
      const presentTables = await tx.$queryRawUnsafe<{ name: string }[]>(
        PROJECTION_TABLE_PROBE_SQL
      );
      if (presentTables.some((row) => row.name === INVOCATION_TABLE)) {
        await tx.$executeRawUnsafe(
          `DELETE FROM ${INVOCATION_TABLE} WHERE session_id = $1`,
          sessionId
        );
      }
      await tx.$executeRawUnsafe(
        "DELETE FROM session_analytics WHERE session_id = $1",
        sessionId
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO sessions
           (id, name, status, cwd, started_at, updated_at, ended_at, harness,
            billing_mode, data_revision, last_activity_at)
         VALUES ($1, $2, 'inactive', $3, $4, $4, $4, $5, 'metered_api', $6, $4)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           harness = excluded.harness,
           data_revision = excluded.data_revision`,
        sessionId,
        "ISS-5466 missing-source rehearsal fixture",
        "/tmp/iss5466-rehearsal-fixture",
        MISSING_SOURCE_FIXTURE_AT,
        Harness.Claude,
        MISSING_SOURCE_FIXTURE_STALE_REVISION
      );
      // `completed`, not the session lifecycle's `inactive`: `agents.status` is
      // its OWN axis (DESKTOP_AGENT_STATUS), and the importer stamps a terminal
      // subagent row `completed`. A lifecycle value here would give the
      // production-shape fixture an agent state no importer can produce, so
      // repair or rollup logic keyed on agent terminality would behave
      // differently on it than on imported data. Re-stamped on conflict for the
      // same reason the session row is: a reused `--out` store must come out
      // holding what this run intends, not what an older run wrote.
      await tx.$executeRawUnsafe(
        `INSERT INTO agents (id, session_id, name, type, status, started_at, ended_at)
         VALUES ($1, $2, 'iss5466 resolvable agent', 'subagent', $3, $4, $4)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
        MISSING_SOURCE_FIXTURE_RESOLVED_AGENT_ID,
        sessionId,
        DESKTOP_AGENT_STATUS.COMPLETED,
        MISSING_SOURCE_FIXTURE_AT
      );
      for (const [suffix, agentId, toolUseId] of [
        [
          "orphan",
          MISSING_SOURCE_FIXTURE_ORPHAN_AGENT_ID,
          "toolu_iss5466_orphan",
        ],
        [
          "resolvable",
          MISSING_SOURCE_FIXTURE_RESOLVED_AGENT_ID,
          "toolu_iss5466_resolvable",
        ],
      ]) {
        await tx.$executeRawUnsafe(
          `INSERT INTO events
             (id, session_id, agent_id, event_type, tool_name, data, created_at)
           VALUES ($1, $2, $3, 'PostToolUse', 'Read', $4, $5)
           ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id`,
          `${sessionId}-event-${suffix}`,
          sessionId,
          agentId,
          JSON.stringify({ toolUseId }),
          MISSING_SOURCE_FIXTURE_AT
        );
      }
    })
  );
  return sessionId;
}

/**
 * ISS-9284: the identity a rehearsal store's sessions are claimed for. Fixed
 * strings, not a real account: nothing here signs in, and the values only have
 * to be stable and non-null.
 */
const REHEARSAL_OWNER_USER_ID = "iss9284-rehearsal-owner-user";
const REHEARSAL_OWNER_ORGANIZATION_ID = "iss9284-rehearsal-owner-org";

/**
 * ISS-9284: which sessions the rehearsal's owner claim may touch — a COPY of
 * `UNOWNED_SESSION_PREDICATE` in `src/main/database/session-owner-identity.ts`,
 * duplicated for the header's copy-in reason (this file runs inside a merge-base
 * worktree that may predate any module it would import).
 *
 * One named constant rather than the string inline, so the UPDATE and the
 * failure message cannot drift from each other, and so the copy has a single
 * symbol a test can hold to the canonical one —
 * `test/rehearsal-build-store.test.ts` asserts the two are equal, which is the
 * compensating guard the import cannot be.
 */
export const REHEARSAL_UNOWNED_SESSION_PREDICATE =
  "user_id IS NULL AND organization_id IS NULL";

/**
 * ISS-9284: give the store an OWNER population, so the Owner view's
 * projection-loss check has something to lose.
 *
 * Measured on the frozen corpus before this existed: 0 of 35 sessions carried
 * either identity column. The reason is structural, not a corpus gap — the
 * three writers that create a `sessions` row bind the identity columns from the
 * SIGNED-IN identity (`session-owner-identity.ts`), and the boot-time
 * `claimUnownedSessionIdentity` repair likewise "never invents an identity for a
 * machine that has never signed in". A rehearsal signs in to nothing, so the
 * whole Owner projection was empty and any check over it would have passed
 * vacuously forever.
 *
 * This is the same move `injectMissingSourceFixture` makes for the missing-source
 * population: synthesize into the STORE (never the frozen corpus) the one shape
 * the rehearsal structurally cannot produce. It is deliberately applied to the
 * REAL corpus sessions rather than only to the fixture, because the fixture has
 * no transcript and takes the stored-row path — the owner contract that can
 * actually break is `importPhaseSessionAndMainAgent`'s UPDATE arm leaving the
 * identity columns alone across a full teardown-and-reimport, which only a
 * corpus session exercises.
 *
 * Predicate copied from `UNOWNED_SESSION_PREDICATE` rather than imported, for
 * the header's copy-in reason. Idempotent: a session this run already claimed no
 * longer matches, so a reused `--out` store converges on the same state.
 *
 * NARROWER THAN THE PRODUCTION CLAIM, AND NOT A MIRROR OF IT. Only the predicate
 * is shared. `claimUnownedSessionIdentity` treats the identity UPDATE and
 * `refreshClaimedActivityMetricsCohort`'s re-stamp of
 * `session_activity_metrics.closedloop_user` as ONE repair — skipping the
 * re-stamp is what leaves a claimed session classified `external` forever. This
 * writes the identity columns only, because the Owner projection is what it
 * exists to populate and the cohort column is a different derivation.
 *
 * So state the gap rather than imply parity: `refreshClaimedActivityMetricsCohort`
 * has NO coverage in this lane and cannot acquire any here. The production claim
 * is structurally unreachable in a rehearsal — it never invents an identity for a
 * machine that has never signed in, so it takes its no-identity skip branch in
 * both phases' boot chains. A regression in that re-stamp needs its own test;
 * this lane will not catch one.
 */
export async function claimRehearsalOwnerIdentity(
  db: SqliteAgentDatabase
): Promise<number> {
  return await db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `UPDATE sessions SET user_id = $1, organization_id = $2
        WHERE ${REHEARSAL_UNOWNED_SESSION_PREDICATE}`,
      REHEARSAL_OWNER_USER_ID,
      REHEARSAL_OWNER_ORGANIZATION_ID
    )
  );
}

/**
 * Throw when the store the manifest is about to snapshot has NO owned session.
 *
 * Without it a claim that silently stopped matching — a renamed column, a
 * predicate that no longer selects — would leave the Owner view's population at
 * zero and hand Phase B a manifest whose owner check cannot fail. Phase B's own
 * manifest-sanity arm would then reject the run, but it would blame the manifest
 * rather than the step that produced it, so the failure is raised here where the
 * cause is.
 *
 * Gated on the RESULTING POPULATION, not on the row count the claim's UPDATE
 * touched. The two differ on exactly the case this file works hardest to
 * support: re-running against an existing `--out` dir, where every session was
 * already claimed by the previous run, so the UPDATE legitimately matches zero
 * rows while the store is fully owned. Gating on the update count would abort
 * that retry — and the population is the invariant Phase B actually depends on
 * anyway.
 */
export function assertOwnerIdentityClaimed(
  sessions: readonly RehearsalSessionState[]
): void {
  const owned = sessions.filter(
    (s) => s.projections[REHEARSAL_PROJECTION_TARGET.Owner] > 0
  ).length;
  if (owned === 0) {
    throw new Error(
      `none of ${sessions.length} session(s) carries an owner identity — the Owner projection would be empty and its loss check vacuous. Most likely the unowned predicate (${REHEARSAL_UNOWNED_SESSION_PREDICATE}) no longer selects this store's rows, or the identity columns were renamed.`
    );
  }
}

/**
 * ISS-5466: the per-fixture agent-reference outcome Phase B adjudicates.
 * Separate from `collectSessionStates` because it is a targeted probe of a
 * couple of rows, not a whole-store snapshot, and only Phase B reads it.
 */
export type MissingSourceFixtureAgentRefs = {
  id: string;
  invocationsWithNullAgent: number;
  invocationsWithAgent: number;
};

/** Count each fixture's invocation rows by whether an agent reference survived. */
export async function collectFixtureAgentReferences(
  db: SqliteAgentDatabase,
  fixtureIds: readonly string[]
): Promise<MissingSourceFixtureAgentRefs[]> {
  const refs: MissingSourceFixtureAgentRefs[] = [];
  for (const id of fixtureIds) {
    const rows = await db.prisma.client.$queryRawUnsafe<
      Array<{ null_agent: number; with_agent: number }>
    >(
      `SELECT SUM(agent_id IS NULL) AS null_agent,
              SUM(agent_id IS NOT NULL) AS with_agent
         FROM agent_component_invocations WHERE session_id = $1`,
      id
    );
    refs.push({
      id,
      invocationsWithNullAgent: Number(rows[0]?.null_agent ?? 0),
      invocationsWithAgent: Number(rows[0]?.with_agent ?? 0),
    });
  }
  return refs;
}

async function main(): Promise<void> {
  const outFlagIndex = process.argv.indexOf("--out");
  const outDir = outFlagIndex >= 0 ? process.argv[outFlagIndex + 1] : undefined;
  if (!outDir) {
    throw new Error("usage: tsx scripts/rehearsal-build-store.ts --out <dir>");
  }
  const log = (message: string) =>
    console.log(`[rehearsal-build-store] ${message}`);
  const startedAt = Date.now();
  await mkdir(outDir, { recursive: true });
  const stagingDir = stageCorpusIntoTemp();
  const db = await openRehearsalDb(outDir);
  try {
    await runBootImport(db, stagingDir, log);
    assertBackfillsClean(await runRehearsalBackfills(db, stagingDir, log));
    // `openSqliteAgentDatabase` kicks off its boot-maintenance chain in the
    // background; without this the manifest could snapshot a store that chain
    // is still mutating, making Phase B's before/after comparison meaningless.
    await db.whenBootMaintenanceSettled();
    // ISS-5466: injected AFTER the boot chain settles so nothing heals or stamps
    // the fixture before the manifest snapshots it, and BEFORE the snapshot so
    // its zero-invocation pre-state is on record for Phase B's gain check.
    const missingSourceFixtureIds = [await injectMissingSourceFixture(db)];
    // ISS-9284: claimed AFTER the fixture is injected, so the fixture is owned
    // too, and BEFORE the snapshot, so the owner pre-state is on record. The
    // matched-row count is deliberately discarded — a reused `--out` store is
    // already fully owned and legitimately matches zero rows, so the population
    // the snapshot actually saw is the only honest gate (see
    // `assertOwnerIdentityClaimed`).
    await claimRehearsalOwnerIdentity(db);
    const sessions = await collectSessionStates(db);
    if (sessions.length === 0) {
      throw new Error(
        "store built from the golden corpus contains zero sessions — the rehearsal would be vacuous"
      );
    }
    assertOwnerIdentityClaimed(sessions);
    await writeFile(
      path.join(outDir, REHEARSAL_MANIFEST_FILE),
      `${JSON.stringify(
        { rehearsalManifestVersion: 4, sessions, missingSourceFixtureIds },
        null,
        2
      )}\n`
    );
    const totalFor = (target: RehearsalProjectionTarget) =>
      sessions.reduce((n, s) => n + s.projections[target], 0);
    log(
      `store built: ${sessions.length} sessions, ` +
        `${totalFor(REHEARSAL_PROJECTION_TARGET.Sessions)} invocation rows, ` +
        `${totalFor(REHEARSAL_PROJECTION_TARGET.Branches)} branch-attribution link(s), ` +
        `${totalFor(REHEARSAL_PROJECTION_TARGET.Owner)} owner identity column(s), ` +
        `${totalFor(REHEARSAL_PROJECTION_TARGET.Aggregate)} analytics rows, ` +
        `${missingSourceFixtureIds.length} missing-source fixture(s) ` +
        `(${Math.round((Date.now() - startedAt) / 1000)}s)`
    );
  } finally {
    await db.close();
    await rm(stagingDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[rehearsal-build-store] FAILED: ${error}`);
    process.exitCode = 1;
  });
}
