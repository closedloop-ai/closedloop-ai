/**
 * FEA-3290 (F1, Slice 5) — CONSERVATIVE definition-version backfill (AC-8, AC-020).
 *
 * One-shot, idempotent, org-scoped data backfill that populates the F1 registry
 * (`definition_versions` + `source_occurrences`) and the two nullable link
 * columns (`agent_component_versions.definition_version_id`,
 * `agent_component_session_usage.definition_version_id`) from **exact stored
 * evidence only**.
 *
 * CONSERVATIVE by contract (AC-8): a version is minted ONLY from bytes we
 * actually have on disk — the `content` column of a coarse
 * `agent_component_versions` revision. We NEVER guess a hash from a component
 * name, NEVER reconstruct content from a current file, and NEVER fabricate a
 * link. Legacy name-only rows (rows with no stored `content`, or usage whose
 * `component_version_hash` has no matching stored revision) stay `unresolved`
 * (link left NULL) rather than being mislinked to an invented version.
 *
 * The fingerprint is produced ONLY by `computeDefinitionHash` from
 * `@repo/api/src/definition-fingerprint` (Slice-1). There is deliberately no
 * local hashing here — SQL cannot recompute the TS fingerprint, which is exactly
 * why this backfill is a TS script rather than pure migration SQL (see the Slice
 * plan §3.2 two-phase note).
 *
 * IDEMPOTENT (re-runnable, zero-change on re-run):
 *   - `definition_versions` is upserted on `(organizationId, definitionHash)`.
 *   - `source_occurrences` is upserted on its natural key.
 *   - both link columns are stamped with `UPDATE … WHERE definition_version_id
 *     IS NULL`, so a second run touches zero rows.
 *
 * ORG-SCOPED: `organizationId` participates in every version/occurrence key and
 * every coarse-row filter, so two orgs with byte-identical content get two
 * distinct versions and neither can read the other's.
 *
 * RUN ONCE POST-DEPLOY (human-invoked; see the PR body):
 *   pnpm --filter @repo/database backfill:definition-versions
 * Do not run it during ordinary migration; it is decoupled from `migrate deploy`
 * and safe to re-run at any time.
 */

import "server-only";

import {
  computeDefinitionHash,
  NORMALIZER_CONTRACT_VERSION,
} from "@repo/api/src/definition-fingerprint";
import type { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { SourceAccessState, SourceOccurrenceType } from "../generated/client";
import type { TransactionClient } from "../index";

/** Default page size for the bounded scan of coarse revisions. */
const DEFAULT_PAGE_SIZE = 500;

/**
 * The minimal Prisma-shaped client the backfill needs. Declared structurally (a
 * subset of `TransactionClient`) so the unit test can inject a faithful
 * in-memory fake and prove the semantics with **no database** — the same
 * DB-free testing posture as the Slice-3 writer.
 */
/**
 * A Prisma-shaped `select` clause: each field is `true` (scalar) or a nested
 * `{ select: … }` (relation). Loose on purpose so the in-memory fake can accept
 * the same nested selects the real client does (e.g. the usage row's
 * `session -> artifact -> organizationId` join) without pulling in Prisma generics.
 */
type SelectArg = Record<string, boolean | { select: Record<string, unknown> }>;

export type BackfillClient = {
  agentComponentVersion: {
    findMany(args: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, unknown> | Record<string, unknown>[];
      take?: number;
      cursor?: { id: string };
      skip?: number;
      select?: SelectArg;
    }): Promise<CoarseVersionRow[]>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  definitionVersion: {
    upsert(args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<{ id: string }>;
  };
  sourceOccurrence: {
    findFirst(args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<{ id: string } | null>;
    create(args: {
      data: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<{ id: string }>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<{ id: string }>;
  };
  agentComponentSessionUsage: {
    findMany(args: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, unknown> | Record<string, unknown>[];
      take?: number;
      cursor?: { id: string };
      skip?: number;
      select?: SelectArg;
    }): Promise<UsageRow[]>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
};

/** The columns of a coarse revision the backfill reads. */
export type CoarseVersionRow = {
  id: string;
  organizationId: string;
  componentKind: string;
  componentKey: string;
  source: string;
  contentHash: string;
  content: string;
  format: string | null;
  definitionVersionId: string | null;
};

/** The columns of a usage bucket the backfill reads. */
export type UsageRow = {
  id: string;
  componentKind: string;
  componentKey: string;
  componentVersionHash: string | null;
  definitionVersionId: string | null;
  // SECURITY (org-scoping): a usage row's owning org, joined
  // `AgentComponentSessionUsage -> SessionDetail (session) -> Artifact.organizationId`.
  // Phase-2 resolution MUST match only a DefinitionVersion in this same org, so a
  // usage row can never link across orgs on a shared `(kind, key, contentHash)`.
  session: { artifact: { organizationId: string } };
};

/** Counts logged at the end of a run (also returned for the tests to assert). */
export type BackfillCounts = {
  /** Distinct coarse content groups scanned. */
  contentGroupsScanned: number;
  /** DefinitionVersion rows the run upserted (create-or-touch). */
  versionsUpserted: number;
  /** SourceOccurrence rows created this run (idempotent: 0 on a clean re-run). */
  occurrencesCreated: number;
  /** Coarse `agent_component_versions` rows stamped with a link this run. */
  coarseRowsLinked: number;
  /** Usage rows stamped with a link this run (resolvable evidence). */
  usageRowsLinked: number;
  /** Usage rows deliberately left NULL — no stored revision matched (AC-8). */
  usageRowsUnresolved: number;
};

export type BackfillOptions = {
  /** Bounded page size for the coarse-revision + usage scans. */
  pageSize?: number;
  /** Sink for progress logs; defaults to `console.info`. */
  log?: (message: string) => void;
};

/** Group key for a distinct exact definition within an org. */
function contentGroupKey(row: CoarseVersionRow): string {
  // organizationId + kind + exact content — the identity a DefinitionVersion is
  // minted for. Length-prefix the org+kind so no content byte can shift the
  // boundary (content is appended last, unframed, but is the final field).
  return `${row.organizationId.length}:${row.organizationId}|${row.componentKind.length}:${row.componentKind}|${row.content}`;
}

/**
 * Compute the F1 fingerprint for a coarse revision's exact stored bytes, using
 * the SSOT frontmatter/body split (whole file as `body`, `frontmatter: ""`) —
 * identical to the Slice-3 writer, so a backfilled version and a live-written
 * version share the same `definitionHash`.
 */
function fingerprintOf(row: CoarseVersionRow) {
  return computeDefinitionHash({
    frontmatter: "",
    body: row.content,
    kind: row.componentKind as AgentComponentKind,
  });
}

/**
 * Idempotently create the backfill `SourceOccurrence` for a coarse revision.
 *
 * Legacy coarse rows carry a `source` string but NO device provenance (the
 * coarse table stores no `computeTargetId`/`installPath`), so the backfill
 * writes a `local` occurrence with `computeTargetId = NULL` and every evidence
 * key participant coalesced to `""` (repo columns, localPath, packId). The live writer
 * (Slice 3) supplies real device provenance for new syncs.
 *
 * The natural key has a NULL `computeTargetId`; Postgres treats NULL as distinct
 * in a unique index, so we dedupe through the application (find-then-create),
 * exactly like the writer's null-target path — a re-run creates zero rows.
 */
async function upsertBackfillOccurrence(
  client: BackfillClient,
  args: { organizationId: string; definitionVersionId: string; now: Date }
): Promise<boolean> {
  const naturalKey = {
    organizationId: args.organizationId,
    definitionVersionId: args.definitionVersionId,
    occurrenceType: SourceOccurrenceType.local,
    repoFullName: "",
    repoPath: "",
    repoCommit: "",
    computeTargetId: null,
    localPath: "",
    packId: "",
  };
  const existing = await client.sourceOccurrence.findFirst({
    where: naturalKey,
    select: { id: true },
  });
  if (existing) {
    await client.sourceOccurrence.update({
      where: { id: existing.id },
      data: { lastSeenAt: args.now },
      select: { id: true },
    });
    return false;
  }
  await client.sourceOccurrence.create({
    data: {
      ...naturalKey,
      accessState: SourceAccessState.accessible,
      firstSeenAt: args.now,
      lastSeenAt: args.now,
    },
    select: { id: true },
  });
  return true;
}

/**
 * Phase 1 — mint versions + occurrences from exact stored coarse content, then
 * stamp `agent_component_versions.definition_version_id`.
 *
 * Streams coarse revisions in bounded, id-ordered pages (stable cursor) so the
 * memory footprint is O(pageSize), not O(table). Rows with empty `content` are
 * skipped (name-only legacy rows have no exact evidence → stay unresolved).
 *
 * Returns a map of `contentGroupKey → definitionVersionId` so Phase 2 can link
 * usage without re-hashing.
 */
async function backfillVersionsAndCoarse(
  client: BackfillClient,
  counts: BackfillCounts,
  pageSize: number,
  now: Date
): Promise<Map<string, string>> {
  const groupToVersionId = new Map<string, string>();
  let cursor: string | undefined;

  for (;;) {
    const page: CoarseVersionRow[] =
      await client.agentComponentVersion.findMany({
        orderBy: { id: "asc" },
        take: pageSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          organizationId: true,
          componentKind: true,
          componentKey: true,
          source: true,
          contentHash: true,
          content: true,
          format: true,
          definitionVersionId: true,
        },
      });
    if (page.length === 0) {
      break;
    }

    for (const row of page) {
      // CONSERVATIVE (AC-8): no stored bytes ⇒ no exact evidence ⇒ never mint.
      if (row.content.length === 0) {
        continue;
      }
      const key = contentGroupKey(row);
      let versionId = groupToVersionId.get(key);
      if (versionId === undefined) {
        counts.contentGroupsScanned += 1;
        const { definitionHash } = fingerprintOf(row);
        const version = await client.definitionVersion.upsert({
          where: {
            organizationId_definitionHash: {
              organizationId: row.organizationId,
              definitionHash,
            },
          },
          create: {
            organizationId: row.organizationId,
            componentKind: row.componentKind,
            definitionHash,
            normalizerContractVersion: NORMALIZER_CONTRACT_VERSION,
            content: row.content,
            format: row.format ?? null,
            firstSeenAt: now,
            lastSeenAt: now,
          },
          // Re-run: same fingerprint ⇒ same row, only freshness moves.
          update: { lastSeenAt: now },
          select: { id: true },
        });
        counts.versionsUpserted += 1;
        versionId = version.id;
        groupToVersionId.set(key, versionId);

        const created = await upsertBackfillOccurrence(client, {
          organizationId: row.organizationId,
          definitionVersionId: versionId,
          now,
        });
        if (created) {
          counts.occurrencesCreated += 1;
        }
      }

      // Stamp EVERY coarse row of this exact (org, content) group — idempotent:
      // the WHERE guards on NULL so a re-run links nothing.
      const linked = await client.agentComponentVersion.updateMany({
        where: {
          organizationId: row.organizationId,
          componentKind: row.componentKind,
          contentHash: row.contentHash,
          definitionVersionId: null,
        },
        data: { definitionVersionId: versionId },
      });
      counts.coarseRowsLinked += linked.count;
    }

    if (page.length < pageSize) {
      break;
    }
    cursor = page.at(-1)?.id;
  }

  return groupToVersionId;
}

/**
 * Phase 2 — link usage buckets to a version by joining
 * `component_version_hash → coarse (kind, key, contentHash) → definition_version_id`.
 *
 * CONSERVATIVE (AC-8): a usage row is linked ONLY when a stored coarse revision
 * with a matching `(componentKind, componentKey, contentHash)` exists AND that
 * revision already carries a `definitionVersionId` (i.e. Phase 1 could mint from
 * exact bytes). Where `component_version_hash` is null, or no stored revision
 * matches, the link is deliberately left NULL — "unknown", never fabricated.
 *
 * ORG-SCOPED (SECURITY, P0): the join tuple is bound to the usage row's own
 * `organizationId` (usage -> `SessionDetail` (session) -> `Artifact.organizationId`).
 * `(componentKind, componentKey, contentHash)` is NOT org-unique — two orgs can
 * store byte-identical content under the same hash — so without the org bound a
 * usage row in org A could link to org B's DefinitionVersion (cross-org leak).
 * The org participates in BOTH the coarse-row `where` and the resolve cache key.
 *
 * Streams usage in bounded, id-ordered pages. Only rows with a non-null
 * `component_version_hash` and a still-NULL link are scanned (idempotent).
 */
async function backfillUsage(
  client: BackfillClient,
  counts: BackfillCounts,
  pageSize: number
): Promise<void> {
  // Resolve each usage row against the stored coarse revisions on demand, using
  // a small memoized lookup keyed on the join tuple.
  const resolveCache = new Map<string, string | null>();

  async function resolveVersionId(
    organizationId: string,
    componentKind: string,
    componentKey: string,
    contentHash: string
  ): Promise<string | null> {
    // SECURITY (org-scoping): `organizationId` leads the cache key so two orgs
    // with byte-identical `(kind, key, contentHash)` never collide on one entry
    // and hand org A's version to org B's usage row.
    const cacheKey = `${organizationId.length}:${organizationId}|${componentKind.length}:${componentKind}|${componentKey.length}:${componentKey}|${contentHash}`;
    const cached = resolveCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const match = await client.agentComponentVersion.findMany({
      where: {
        // SECURITY (org-scoping): bind the coarse-row match to the usage row's
        // own org so the `(kind, key, contentHash)` tuple can only ever select a
        // DefinitionVersion minted from THIS org's stored bytes.
        organizationId,
        componentKind,
        componentKey,
        contentHash,
        definitionVersionId: { not: null },
      },
      take: 1,
      select: { id: true, definitionVersionId: true },
    });
    const resolved = match[0]?.definitionVersionId ?? null;
    resolveCache.set(cacheKey, resolved);
    return resolved;
  }

  let cursor: string | undefined;
  for (;;) {
    const page: UsageRow[] = await client.agentComponentSessionUsage.findMany({
      where: {
        componentVersionHash: { not: null },
        definitionVersionId: null,
      },
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        componentKind: true,
        componentKey: true,
        componentVersionHash: true,
        definitionVersionId: true,
        // SECURITY (org-scoping): pull the owning org alongside the usage row so
        // Phase-2 resolution can bind to it (usage -> session -> artifact.org).
        session: { select: { artifact: { select: { organizationId: true } } } },
      },
    });
    if (page.length === 0) {
      break;
    }

    for (const usage of page) {
      const hash = usage.componentVersionHash;
      if (hash == null) {
        // Guarded by the WHERE, but keep the type-narrowing honest.
        counts.usageRowsUnresolved += 1;
        continue;
      }
      const versionId = await resolveVersionId(
        usage.session.artifact.organizationId,
        usage.componentKind,
        usage.componentKey,
        hash
      );
      if (versionId == null) {
        // No exact stored evidence resolves this hash — leave NULL (AC-8).
        counts.usageRowsUnresolved += 1;
        continue;
      }
      const linked = await client.agentComponentSessionUsage.updateMany({
        where: { id: usage.id, definitionVersionId: null },
        data: { definitionVersionId: versionId },
      });
      counts.usageRowsLinked += linked.count;
    }

    if (page.length < pageSize) {
      break;
    }
    cursor = page.at(-1)?.id;
  }
}

/**
 * Run the conservative backfill against an injected client (the pure core).
 *
 * Exported so tests drive it with an in-memory fake — no database. The `main()`
 * wrapper below binds it to a real Prisma transaction.
 */
export async function runBackfill(
  client: BackfillClient,
  options: BackfillOptions = {}
): Promise<BackfillCounts> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const log = options.log ?? ((m: string) => console.info(m));
  const now = new Date();

  const counts: BackfillCounts = {
    contentGroupsScanned: 0,
    versionsUpserted: 0,
    occurrencesCreated: 0,
    coarseRowsLinked: 0,
    usageRowsLinked: 0,
    usageRowsUnresolved: 0,
  };

  await backfillVersionsAndCoarse(client, counts, pageSize, now);
  await backfillUsage(client, counts, pageSize);

  log(
    `[backfill-definition-versions] done: ${JSON.stringify(counts, null, 0)}`
  );
  return counts;
}

/**
 * Narrow a real Prisma `TransactionClient` down to the `BackfillClient` surface.
 *
 * `BackfillClient` deliberately keeps LOOSE (Prisma-generic-free) method
 * signatures so the unit test can inject a faithful in-memory fake with no
 * database. That looseness is why `tx` is not *directly* assignable — Prisma's
 * real delegate methods are overloaded and model-typed, a strict superset the
 * compiler can't prove equal to the loose subset. The old
 * `tx as unknown as BackfillClient` hid ALL drift behind that gap.
 *
 * Instead we build the client from the exact delegate methods the backfill
 * calls, each pinned to its real Prisma signature via `PrismaDelegateMethods`
 * below. If Prisma renames/removes any of these methods (`findMany`,
 * `updateMany`, `upsert`, `findFirst`, `create`, `update`) or drops a delegate,
 * `pinnedDelegates` fails to compile — surfacing the drift the double-cast hid.
 * The final assignment is the one narrowing that remains structurally
 * unavoidable (loose args ⊃ Prisma overloads), scoped to already-verified
 * method references rather than a blanket bypass.
 */
type PrismaDelegateMethods = {
  agentComponentVersion: Pick<
    TransactionClient["agentComponentVersion"],
    "findMany" | "updateMany"
  >;
  definitionVersion: Pick<TransactionClient["definitionVersion"], "upsert">;
  sourceOccurrence: Pick<
    TransactionClient["sourceOccurrence"],
    "findFirst" | "create" | "update"
  >;
  agentComponentSessionUsage: Pick<
    TransactionClient["agentComponentSessionUsage"],
    "findMany" | "updateMany"
  >;
};

function toBackfillClient(tx: TransactionClient): BackfillClient {
  const pinnedDelegates: PrismaDelegateMethods = {
    agentComponentVersion: tx.agentComponentVersion,
    definitionVersion: tx.definitionVersion,
    sourceOccurrence: tx.sourceOccurrence,
    agentComponentSessionUsage: tx.agentComponentSessionUsage,
  };
  return pinnedDelegates as unknown as BackfillClient;
}

/**
 * CLI entrypoint. Binds `runBackfill` to a single real Prisma transaction so the
 * whole sweep is atomic and re-runnable. Kept dependency-light: it defers the
 * heavy `@repo/database` client graph to runtime so importing this module for
 * tests never spins up a pool.
 */
async function main(): Promise<void> {
  const { withDb } = await import("../index");
  const counts = await withDb.tx(
    (tx) => runBackfill(toBackfillClient(tx)),
    // A full historical sweep can exceed the 5s default; give it room.
    { timeout: 15 * 60 * 1000, maxWait: 30 * 1000 }
  );
  console.info(
    `[backfill-definition-versions] committed: linked ${counts.coarseRowsLinked} coarse rows, ${counts.usageRowsLinked} usage rows (${counts.usageRowsUnresolved} usage left unresolved).`
  );
}

// Only run when invoked directly (not when imported by the test).
if (
  typeof process !== "undefined" &&
  import.meta.url === `file://${process.argv[1]}`
) {
  main().catch((error) => {
    console.error("[backfill-definition-versions] failed:", error);
    process.exitCode = 1;
  });
}
