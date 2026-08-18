/**
 * FEA-3909 / PRD-527 F4 — CONSERVATIVE pack-membership → F1 definition-version
 * backfill.
 *
 * One-shot, idempotent, org-scoped data backfill that links existing pack members
 * to the provenance-free F1 registry (`definition_versions` + `source_occurrences`)
 * and stamps the nullable link column
 * (`catalog_item_versions.definition_version_id`) from **exact stored content
 * only**. It also closes the previously-never-written `pack` occurrence seam for
 * historical members: every linked member gets a
 * `SourceOccurrence(occurrence_type = 'pack', pack_id = <top-level pack id>)`.
 *
 * This mirrors the Slice-5 `backfill-definition-versions.ts` shape exactly
 * (bounded id-ordered paging, an in-memory `(org, kind, content) → versionId`
 * cache, idempotent upserts, no local hashing).
 *
 * CONSERVATIVE by contract (PD5-aligned): a version is minted ONLY from bytes we
 * actually have on disk — the `content` column of a member's `catalog_item_versions`
 * row. Members with no stored body (null/empty `content`) stay
 * `definition_version_id = NULL`. We NEVER guess a hash from a component
 * name/owner/source and NEVER fabricate a link.
 *
 * ORG-SCOPED: only members whose owning `CatalogItem.organizationId` is non-null
 * are backfilled — the F1 registry is org-scoped, and a global/curated member
 * (organizationId IS NULL) has no org to key a `DefinitionVersion` under, so it is
 * conservatively left unlinked. `organizationId` participates in every version /
 * occurrence key.
 *
 * MEMBERSHIP many-to-many (PD3): the version is keyed on `(org, definitionHash)`
 * only — never the pack — so two packs carrying byte-identical content share ONE
 * `DefinitionVersion` and get one `pack` occurrence each (per distinct pack id).
 * The version is referenced, never copied. The Pack is never versioned (PD2).
 *
 * The fingerprint is produced ONLY by `computeDefinitionHash` from
 * `@repo/api/src/definition-fingerprint` (Slice-1). There is deliberately no local
 * hashing here — the same reason Slice 5 is a TS script, not migration SQL.
 *
 * IDEMPOTENT (re-runnable, zero-change on re-run):
 *   - `definition_versions` upserts on `(organizationId, definitionHash)`.
 *   - `source_occurrences` (pack) dedupes on its natural key via NULL-safe
 *     find-then-create (Postgres treats NULL `compute_target_id` as distinct).
 *     This is safe here because the backfill is a single-process, human-invoked
 *     one-shot; the LIVE pack writer (`definition-registry/service.ts`), which can
 *     race concurrent imports, instead uses an atomic `INSERT … ON CONFLICT`
 *     against the null-target partial unique index.
 *   - already-linked members are skipped in-code BEFORE any upsert, so a clean
 *     re-run neither re-stamps a link nor bumps existing registry timestamps.
 *   - the link column is stamped with `UPDATE … WHERE definition_version_id IS NULL`,
 *     so a re-run stamps zero rows.
 *
 * PER-PAGE TRANSACTIONS: the paged scan runs outside any transaction and each
 * page's writes commit in their own short transaction, so lock windows stay small
 * and a late failure only rolls back the current page (restartable progress) —
 * not one 15-minute interactive transaction holding page-one rows locked.
 *
 * RUN ONCE POST-DEPLOY (human-invoked; see the PR body):
 *   pnpm --filter @repo/database backfill:pack-definition-versions
 * Do not run it during ordinary migration; it is decoupled from `migrate deploy`
 * and safe to re-run at any time.
 */

// NOTE: no `import "server-only"` here. This is a Node-only CLI script run via
// `tsx` (pnpm run backfill:pack-definition-versions), NOT a bundled server
// component. The `server-only` package's `default` export (index.js) throws on
// import outside a `react-server` condition, so the marker would make the CLI
// throw before `main()` runs (Vitest only hides this because it aliases the
// marker to the empty stub). The module is inherently server-side — it imports
// the Prisma client at runtime — so the marker adds nothing but a broken entry.
import { catalogTargetKindToComponentKind } from "@repo/api/src/catalog-component-kind";
import {
  computeDefinitionHash,
  NORMALIZER_CONTRACT_VERSION,
} from "@repo/api/src/definition-fingerprint";
import { SourceAccessState, SourceOccurrenceType } from "../generated/client";
import type { TransactionClient } from "../index";

/** Default page size for the bounded scan of pack-member version rows. */
const DEFAULT_PAGE_SIZE = 500;

/**
 * A Prisma-shaped `select` clause: each field is `true` (scalar) or a nested
 * `{ select: … }` (relation). Loose on purpose so the unit test can inject a
 * faithful in-memory fake with no database — the same DB-free posture as the
 * Slice-3 writer and Slice-5 backfill.
 */
type SelectArg = Record<string, boolean | { select: Record<string, unknown> }>;

export type PackBackfillClient = {
  catalogItemVersion: {
    findMany(args: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, unknown> | Record<string, unknown>[];
      take?: number;
      cursor?: { id: string };
      skip?: number;
      select?: SelectArg;
    }): Promise<PackMemberVersionRow[]>;
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
};

/**
 * The columns of a pack-member version row the backfill reads. `catalogItem` is
 * the owning child `CatalogItem`, joined for its org, `targetKind` (the kind
 * folded into the fingerprint), and `parentPackId` (the top-level pack id that
 * becomes the `pack` occurrence's `packId`).
 */
export type PackMemberVersionRow = {
  id: string;
  content: string | null;
  definitionVersionId: string | null;
  catalogItem: {
    organizationId: string | null;
    targetKind: string;
    parentPackId: string | null;
  };
};

/** Counts logged at the end of a run (also returned for the tests to assert). */
export type PackBackfillCounts = {
  /** Pack-member version rows scanned (content-bearing + still-unlinked). */
  membersScanned: number;
  /** DefinitionVersion rows upserted this run (create-or-touch). */
  versionsUpserted: number;
  /** `pack` SourceOccurrence rows created this run (0 on a clean re-run). */
  packOccurrencesCreated: number;
  /** Member version rows stamped with a link this run. */
  membersLinked: number;
  /**
   * Members deliberately left NULL — no stored body, or org-less (global/curated)
   * where there is no org to key a version under (conservative, PD5).
   */
  membersUnresolved: number;
  /**
   * Members skipped because they were ALREADY linked (`definitionVersionId` set)
   * — a clean re-run's steady state. Counted separately so an already-linked row
   * is never miscounted as `membersUnresolved` (its link + registry rows already
   * exist; we don't re-touch their timestamps).
   */
  membersAlreadyLinked: number;
};

/**
 * Opens a bounded transaction for ONE page's writes and runs `body` inside it,
 * returning the body's result. Injected so the CLI binds it to a real short
 * `withDb.tx` (per-page commit) while tests pass the page client straight through
 * with no real transaction.
 */
export type PageTransactionRunner = <T>(
  body: (tx: PackBackfillClient) => Promise<T>
) => Promise<T>;

export type PackBackfillOptions = {
  /** Bounded page size for the member-version scan. */
  pageSize?: number;
  /** Sink for progress logs; defaults to `console.info`. */
  log?: (message: string) => void;
  /**
   * Per-page transaction boundary. When provided, each page's writes commit in
   * their own short transaction (short lock windows, restartable progress); the
   * body receives the transactional write client. Defaults to running the body on
   * the scan `client` directly (no separate transaction) — the shape tests use.
   */
  runPageTransaction?: PageTransactionRunner;
};

/** Group key for a distinct exact definition within an org. */
function contentGroupKey(
  organizationId: string,
  targetKind: string,
  content: string
): string {
  // Length-prefix org + kind so no content byte can shift a boundary (content is
  // appended last, unframed, but is the final field). Mirrors the Slice-5 key.
  return `${organizationId.length}:${organizationId}|${targetKind.length}:${targetKind}|${content}`;
}

/**
 * Idempotently create the `pack` `SourceOccurrence` for a member's exact version.
 *
 * A `pack` occurrence carries `compute_target_id = NULL` and every non-pack
 * evidence key participant coalesced to `""` (repo columns + local path), with the
 * `pack_id` set to the top-level pack id. Postgres treats NULL as distinct in a
 * unique index, so we dedupe through the application (find-then-create) exactly
 * like the live writer's null-target path — a re-run creates zero rows. Returns
 * `true` iff a new occurrence was created.
 */
async function upsertPackOccurrence(
  client: PackBackfillClient,
  args: {
    organizationId: string;
    definitionVersionId: string;
    packId: string;
    now: Date;
  }
): Promise<boolean> {
  const naturalKey = {
    organizationId: args.organizationId,
    definitionVersionId: args.definitionVersionId,
    occurrenceType: SourceOccurrenceType.pack,
    repoFullName: "",
    repoPath: "",
    repoCommit: "",
    computeTargetId: null,
    localPath: "",
    packId: args.packId,
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
 * Mint (or reuse) the exact `DefinitionVersion` for one member's stored bytes,
 * using the SSOT frontmatter/body split (whole file as `body`, `frontmatter: ""`)
 * — identical to the Slice-3 writer + Slice-5 backfill, so a live-linked member
 * and a backfilled one share the same `definitionHash`.
 */
async function upsertMemberVersion(
  client: PackBackfillClient,
  args: {
    organizationId: string;
    targetKind: string;
    content: string;
    now: Date;
  }
): Promise<string> {
  // Canonicalize the catalog `targetKind` (`"agent"` → `subagent`) exactly as the
  // live pack-import writer does, so a backfilled member and a live-linked one —
  // and a device-synced `subagent` — share the same `definitionHash` and the same
  // stored `componentKind`. Folding the raw catalog string here would fork F1
  // dedup between the two paths.
  const componentKind = catalogTargetKindToComponentKind(args.targetKind);
  const { definitionHash } = computeDefinitionHash({
    frontmatter: "",
    body: args.content,
    kind: componentKind,
  });
  const version = await client.definitionVersion.upsert({
    where: {
      organizationId_definitionHash: {
        organizationId: args.organizationId,
        definitionHash,
      },
    },
    create: {
      organizationId: args.organizationId,
      componentKind,
      definitionHash,
      normalizerContractVersion: NORMALIZER_CONTRACT_VERSION,
      content: args.content,
      format: null,
      firstSeenAt: args.now,
      lastSeenAt: args.now,
    },
    // Re-run: same fingerprint ⇒ same row, only freshness moves.
    update: { lastSeenAt: args.now },
    select: { id: true },
  });
  return version.id;
}

/**
 * The per-member outcome, so the caller can tally each case exactly once:
 *  - `linked`: this run minted/reused a version and stamped the member.
 *  - `already-linked`: the member was already linked (steady-state re-run) — its
 *    version/occurrence/link already exist and are NOT re-touched (no timestamp
 *    bump), so it is neither "linked" nor "unresolved".
 *  - `unresolved`: conservatively left NULL (no stored body / no org / no pack).
 */
type MemberOutcome = "linked" | "already-linked" | "unresolved";

/**
 * Run the conservative pack backfill against an injected client (the pure core).
 *
 * Exported so tests drive it with an in-memory fake — no database. The `main()`
 * wrapper below binds it to a real per-page Prisma transaction.
 *
 * Streams member-version rows in bounded, id-ordered pages (stable cursor) so the
 * memory footprint is O(pageSize), not O(table). Each page's writes commit in
 * their own short transaction (`runPageTransaction`) so lock windows stay small
 * and progress is restartable — page-one rows are not held locked until the last
 * page commits. A PER-PAGE `(org, kind, content)` cache means byte-identical
 * members within a page mint one version + one occurrence per distinct pack id;
 * the DB upsert dedupes across page boundaries, so the cache is cleared each page
 * to keep memory O(pageSize) rather than O(all unique historical content).
 */
export async function runPackBackfill(
  client: PackBackfillClient,
  options: PackBackfillOptions = {}
): Promise<PackBackfillCounts> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const log = options.log ?? ((m: string) => console.info(m));
  const runPageTransaction: PageTransactionRunner =
    options.runPageTransaction ?? ((body) => body(client));
  const now = new Date();

  const counts: PackBackfillCounts = {
    membersScanned: 0,
    versionsUpserted: 0,
    packOccurrencesCreated: 0,
    membersLinked: 0,
    membersUnresolved: 0,
    membersAlreadyLinked: 0,
  };

  let cursor: string | undefined;

  for (;;) {
    // Scan OUTSIDE any transaction so the read holds no long-lived locks.
    const page: PackMemberVersionRow[] = await scanPage(
      client,
      pageSize,
      cursor
    );
    if (page.length === 0) {
      break;
    }

    // Commit THIS page's writes in their own bounded transaction. A late failure
    // rolls back only the current page, and a restart resumes from committed
    // progress instead of redoing the whole sweep.
    await runPageTransaction(async (tx) => {
      // Per-page cache: the key contains the full content body, so scoping it to
      // one page bounds memory at O(pageSize). Cross-page dedupe is handled by the
      // `(org, definitionHash)` DB upsert, which is idempotent regardless.
      const groupToVersionId = new Map<string, string>();
      for (const member of page) {
        const outcome = await backfillOneMember(
          tx,
          member,
          groupToVersionId,
          counts,
          now
        );
        tallyOutcome(counts, outcome);
      }
    });

    if (page.length < pageSize) {
      break;
    }
    cursor = page.at(-1)?.id;
  }

  log(
    `[backfill-pack-definition-versions] done: ${JSON.stringify(counts, null, 0)}`
  );
  return counts;
}

/** Read one id-ordered page of pack members (stable cursor). */
function scanPage(
  client: PackBackfillClient,
  pageSize: number,
  cursor: string | undefined
): Promise<PackMemberVersionRow[]> {
  return client.catalogItemVersion.findMany({
    where: {
      // Pack members only: the child CatalogItem is inside a Pack.
      catalogItem: { parentPackId: { not: null } },
      // NOTE: do NOT filter on `definitionVersionId: null` here. This scan pages
      // with `cursor + skip: 1`, and stamping the link column as it goes would,
      // if the filter were present, shrink the result set mid-sweep and silently
      // drop one still-unlinked member per page boundary. Already-linked rows are
      // instead skipped in-code (`backfillOneMember`), which also avoids bumping
      // their registry timestamps on a clean re-run.
    },
    orderBy: { id: "asc" },
    take: pageSize,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      content: true,
      definitionVersionId: true,
      catalogItem: {
        select: {
          organizationId: true,
          targetKind: true,
          parentPackId: true,
        },
      },
    },
  });
}

/** Tally a per-member outcome into the run counts exactly once. */
function tallyOutcome(
  counts: PackBackfillCounts,
  outcome: MemberOutcome
): void {
  if (outcome === "unresolved") {
    counts.membersUnresolved += 1;
  } else if (outcome === "already-linked") {
    counts.membersAlreadyLinked += 1;
  }
}

/**
 * Backfill a single pack member. Returns its {@link MemberOutcome}. Extracted so
 * `runPackBackfill` stays under the complexity budget.
 */
async function backfillOneMember(
  client: PackBackfillClient,
  member: PackMemberVersionRow,
  groupToVersionId: Map<string, string>,
  counts: PackBackfillCounts,
  now: Date
): Promise<MemberOutcome> {
  const { organizationId, targetKind, parentPackId } = member.catalogItem;
  const content = member.content;
  // Conservative (PD5): no stored bytes, no org, or no parent pack ⇒ never mint.
  // (The scan `where` already excludes non-members, but org-less global/curated
  // members can still surface — leave them unlinked.)
  if (
    content == null ||
    content.length === 0 ||
    organizationId == null ||
    parentPackId == null
  ) {
    return "unresolved";
  }

  // Already linked (steady-state re-run): skip BEFORE any upsert so its
  // version/occurrence timestamps are not bumped and it is not miscounted as
  // unresolved. The scan can't filter this out (page-boundary drop), so it's
  // done here.
  if (member.definitionVersionId != null) {
    return "already-linked";
  }

  counts.membersScanned += 1;

  const key = contentGroupKey(organizationId, targetKind, content);
  let versionId = groupToVersionId.get(key);
  if (versionId === undefined) {
    versionId = await upsertMemberVersion(client, {
      organizationId,
      targetKind,
      content,
      now,
    });
    counts.versionsUpserted += 1;
    groupToVersionId.set(key, versionId);
  }

  // Record the `pack` occurrence (per distinct pack id) — the never-written seam.
  const created = await upsertPackOccurrence(client, {
    organizationId,
    definitionVersionId: versionId,
    packId: parentPackId,
    now,
  });
  if (created) {
    counts.packOccurrencesCreated += 1;
  }

  // Stamp the link — idempotent: the WHERE guards on NULL so a concurrent racer
  // that linked it first stamps nothing.
  const stamped = await client.catalogItemVersion.updateMany({
    where: { id: member.id, definitionVersionId: null },
    data: { definitionVersionId: versionId },
  });
  counts.membersLinked += stamped.count;
  return stamped.count > 0 ? "linked" : "already-linked";
}

/**
 * Narrow a real Prisma `TransactionClient` down to the `PackBackfillClient`
 * surface, pinning each delegate method to its real Prisma signature so a
 * Prisma rename/removal fails to compile (surfacing drift a blanket double-cast
 * would hide). Mirrors `toBackfillClient` in the Slice-5 backfill.
 */
type PrismaDelegateMethods = {
  catalogItemVersion: Pick<
    TransactionClient["catalogItemVersion"],
    "findMany" | "updateMany"
  >;
  definitionVersion: Pick<TransactionClient["definitionVersion"], "upsert">;
  sourceOccurrence: Pick<
    TransactionClient["sourceOccurrence"],
    "findFirst" | "create" | "update"
  >;
};

function toPackBackfillClient(tx: TransactionClient): PackBackfillClient {
  const pinnedDelegates: PrismaDelegateMethods = {
    catalogItemVersion: tx.catalogItemVersion,
    definitionVersion: tx.definitionVersion,
    sourceOccurrence: tx.sourceOccurrence,
  };
  return pinnedDelegates as unknown as PackBackfillClient;
}

/** Per-page transaction budget: bounded so each page commits well within a short
 * interactive-transaction window (not the whole-sweep 15-minute window this
 * replaced), keeping lock windows small and progress restartable. */
const PAGE_TRANSACTION_TIMEOUT_MS = 60 * 1000;
const PAGE_TRANSACTION_MAX_WAIT_MS = 30 * 1000;

/**
 * CLI entrypoint. The paged scan runs OUTSIDE any transaction; each page's writes
 * commit in their own short transaction (`runPageTransaction`), so a late failure
 * rolls back only the current page and a restart resumes from committed progress
 * — no single 15-minute interactive transaction holding page-one rows locked
 * until the whole sweep commits. Kept dependency-light: it defers the heavy
 * `@repo/database` client graph to runtime so importing this module for tests
 * never spins up a pool.
 */
async function main(): Promise<void> {
  const { withDb } = await import("../index");
  // Scan client: each page read borrows a pooled connection (no long-lived tx).
  // Only `catalogItemVersion.findMany` is exercised on this client — the writes
  // all run on the per-page transaction client below.
  const scanClient = toScanClient(withDb);
  const counts = await runPackBackfill(scanClient, {
    runPageTransaction: (body) =>
      withDb.tx((tx) => body(toPackBackfillClient(tx)), {
        timeout: PAGE_TRANSACTION_TIMEOUT_MS,
        maxWait: PAGE_TRANSACTION_MAX_WAIT_MS,
      }),
  });
  console.info(
    `[backfill-pack-definition-versions] committed: linked ${counts.membersLinked} pack members, created ${counts.packOccurrencesCreated} pack occurrences (${counts.membersUnresolved} left unresolved, ${counts.membersAlreadyLinked} already linked).`
  );
}

/**
 * A read-only `PackBackfillClient` whose paged `findMany` borrows a pooled
 * connection per page via `withDb` (no transaction), for the scan phase. The
 * write delegates are never invoked on this client (they run on the per-page
 * transaction client), so they throw if reached — surfacing a wiring mistake
 * instead of silently writing outside a transaction.
 */
function toScanClient(
  withDbFn: typeof import("../index").withDb
): PackBackfillClient {
  const unreachable = () => {
    throw new Error("scan client is read-only; writes must use the page tx");
  };
  const findMany: PackBackfillClient["catalogItemVersion"]["findMany"] = (
    args
  ) =>
    // The scan always passes the narrowing `select` (see `scanPage`), so each row
    // is a `PackMemberVersionRow` at runtime; the Prisma delegate widens the type
    // because `select` is dynamic here, so narrow it back (mirrors the cast in
    // `toPackBackfillClient`).
    withDbFn((db) =>
      db.catalogItemVersion.findMany(args)
    ) as unknown as Promise<PackMemberVersionRow[]>;
  return {
    catalogItemVersion: { findMany, updateMany: unreachable },
    definitionVersion: { upsert: unreachable },
    sourceOccurrence: {
      findFirst: unreachable,
      create: unreachable,
      update: unreachable,
    },
  };
}

// Only run when invoked directly (not when imported by the test).
if (
  typeof process !== "undefined" &&
  import.meta.url === `file://${process.argv[1]}`
) {
  main().catch((error) => {
    console.error("[backfill-pack-definition-versions] failed:", error);
    process.exitCode = 1;
  });
}
