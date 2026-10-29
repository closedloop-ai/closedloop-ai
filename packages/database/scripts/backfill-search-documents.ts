/**
 * FEA-3857 (parent FEA-3800, PLN-1456 Slice 1) — one-shot, idempotent,
 * org-scoped backfill that populates the `search_document` full-text projection
 * from the DB-resident corpus: Document/Feature Artifacts, Projects,
 * (FEA-3930 corpus slice) Comments, Pull Requests, and Branches, and (FEA-4011
 * Slice A) org-scoped agentic Components. Comments carry their thread's anchor
 * artifact (id + type) so a hit deep-links to the session/branch it lives on;
 * pull requests route to their owning branch; branches route by their artifact
 * id; agent components route by their org-identity slug (`/agents/<slug>`).
 *
 * ADDITIVE / SHIPS DARK: the projection has no read or write path yet. This
 * backfill is the ONLY writer today (the Slice-2 write-time indexing hooks and
 * the Slice-3 `GET /search` FTS query land later). It is decoupled from
 * `migrate deploy` — run it once post-deploy, human-invoked:
 *
 *   pnpm --filter @repo/database backfill:search-documents
 *
 * TARGETED RE-RUNS (ISS-9699): `--only=<corpus>[,…]` restricts the sweep to the
 * named corpora — see {@link SearchBackfillSource} for the names.
 *
 *   pnpm --filter @repo/database backfill:search-documents --only=documents
 *
 * Without the selector the sweep has exactly one mode — every corpus in one
 * interactive transaction — so correcting drift on one corpus rewrites every
 * comment, pull request and branch projection row too. An unselected corpus
 * returns 0 without issuing its first page, and the anti-join prune is gated on
 * the same selection, so a narrowed run never reads, rewrites, or deletes what
 * it was not asked for.
 *
 * IT HOLDS UP STATUS WRITES WHILE IT RUNS (ISS-9938). The sweep is one
 * interactive transaction of up to 15 minutes, and it keeps every projection
 * row it has written locked until it commits. The `search_document` status-sync
 * trigger updates those same rows inside every document status write,
 * so a status change on an entity this run has already swept waits for the
 * commit, and a bulk status change (a 5-second transaction) fails with a
 * transaction timeout. A multi-row status write that locks a row this run has
 * not reached before one it has swept can also deadlock with it (40P01):
 * Postgres aborts one side, and when that is this sweep, every row it wrote
 * rolls back. Run it off-peak, narrowed with `--only=<corpus>`.
 *
 * NOT the ISS-9665 priority repair. That shipped with its producer fix in
 * #6796, as the data migration
 * `20260907140000_iss9665_search_document_unset_priority_backfill`: it runs
 * inside `migrate deploy`, before the new API serves a request, so there is no
 * operator step and no re-corruption window to order against. That migration's
 * header names THIS script as the general reconcile and says why it is not the
 * vehicle for a one-column fix — it re-derives every projected column,
 * including re-reading document bodies to rebuild `tsv`, which is far too heavy
 * for a deploy's critical path.
 *
 * IDEMPOTENT (re-runnable, zero net change on re-run): every source page is
 * written with a single `INSERT ... ON CONFLICT (organization_id, entity_type,
 * entity_id) DO UPDATE` — an atomic upsert on the projection's unique key
 * (AGENTS: prefer atomic upsert over findFirst-then-write). A second run
 * re-derives the same title/body/visibility keys and updates in place; no
 * duplicate rows.
 *
 * PAGINATED UNTIL EXHAUSTED (AGENTS: a capped-first-page backfill is a bug):
 * each source is scanned by ascending `id` cursor in fixed-size pages until a
 * short page proves the source is drained. The generated `tsv` column is owned
 * by Postgres, so the upsert never writes it — it is recomputed on every row
 * insert/update.
 *
 * ORG-SCOPED: `organization_id` is copied straight from each source row and
 * participates in the projection's unique key, so two orgs never collide and a
 * backfill for one org never reads or writes another's rows.
 *
 * TITLE/BODY: `body` is the entity's searchable text, bounded to
 * {@link MAX_SEARCH_BODY_CHARS} (else left null) — a project's `description`,
 * and, since the Phase-2
 * navigation slice (parent FEA-3800), a DOCUMENT's latest-version content (no
 * longer title-only). ROUTE FIELDS: documents also carry `slug` + `entitySubtype`
 * (their `type`), and projects `slug` + `teamId` (owning team), so a hit can
 * build its real web route.
 */

import "server-only";

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  boundSearchText,
  MAX_SEARCH_BODY_CHARS,
  MAX_SEARCH_TITLE_CHARS,
} from "@repo/api/src/types/search";
import {
  isStatusTriggerOwned,
  SearchEntityType,
  type StatusTriggerOwnedEntityType,
} from "@repo/api/src/types/search-entity-kind";
import type { Prisma } from "../generated/client";
import type { TransactionClient } from "../index";
import {
  ALL_SEARCH_BACKFILL_SOURCES,
  parseSearchBackfillSources,
  SearchBackfillSource,
} from "./search-backfill-sources";
import type {
  ProjectionRow,
  SearchBackfillClient,
  SearchBackfillCounts,
  SourceRow,
} from "./search-backfill-types";
import {
  backfillAgentComponentSlug,
  branchSearchBody,
  uuidV7,
} from "./search-backfill-values";

/** Page size for the bounded cursor scan of each source table. */
export const DEFAULT_PAGE_SIZE = 500;

function boundTitle(raw: string): string {
  return boundSearchText(raw, MAX_SEARCH_TITLE_CHARS) ?? "";
}

/**
 * Trim an optional body snippet to {@link MAX_SEARCH_BODY_CHARS}. Returns null
 * for a null/blank source so the projection stores SQL NULL rather than an empty
 * string (the generated vector already COALESCEs null to '').
 */
function boundBody(raw: string | null): string | null {
  return boundSearchText(raw, MAX_SEARCH_BODY_CHARS);
}

/** Everything one sweep needs that does not vary between corpora. */
type SweepContext = {
  client: SearchBackfillClient;
  pageSize: number;
  /** The corpora this run was asked for; every other one is skipped whole. */
  selected: ReadonlySet<SearchBackfillSource>;
};

/**
 * Page a single source through the cursor scan and hand each page to `mapPage`,
 * upserting the mapped rows. Returns the count of projection rows written.
 * Paginates until a short page proves the source is exhausted.
 *
 * An unselected corpus returns 0 without issuing its first page, so a narrowed
 * run never reads — let alone rewrites — a corpus the operator did not name.
 */
async function backfillSource(
  ctx: SweepContext,
  source: SearchBackfillSource,
  readPage: (cursorId: string | null) => Promise<SourceRow[]>
): Promise<number> {
  if (!ctx.selected.has(source)) {
    return 0;
  }

  const { client, pageSize } = ctx;
  let written = 0;
  let cursorId: string | null = null;

  for (;;) {
    const page = await readPage(cursorId);
    if (page.length === 0) {
      break;
    }

    const rows: ProjectionRow[] = page.map((source) => ({
      organizationId: source.organizationId,
      entityType: entityTypeForSource(source),
      entityId: source.id,
      title: boundTitle(source.title),
      body: boundBody(source.body),
      projectId: source.projectId,
      assigneeId: source.assigneeId,
      status: source.status,
      priority: source.priority,
      updatedAt: source.updatedAt,
      slug: source.slug,
      entitySubtype: source.entitySubtype,
      teamId: source.teamId,
      anchorEntityId: source.anchorEntityId,
    }));

    written += await client.upsertProjectionRows(rows);

    if (page.length < pageSize) {
      break;
    }
    cursorId = page.at(-1)?.id ?? null;
    if (cursorId === null) {
      break;
    }
  }

  return written;
}

/**
 * The entity type is carried on the mapped `SourceRow` via a symbol-free tag:
 * each corpus mapper stamps the right `SearchEntityType` before this runs. We
 * read it back off a field the mappers set so `backfillSource` stays generic.
 */
const ENTITY_TYPE_KEY = "__entityType" as const;

type TaggedSourceRow = SourceRow & { [ENTITY_TYPE_KEY]: SearchEntityType };

function entityTypeForSource(source: SourceRow): SearchEntityType {
  return (source as TaggedSourceRow)[ENTITY_TYPE_KEY];
}

/**
 * Run the full Phase-1 backfill against the provided client. Documents/Features
 * are the DOCUMENT-typed Artifacts (title = artifact name); Projects carry their
 * description as body.
 */
export async function runSearchDocumentBackfill(
  client: SearchBackfillClient,
  options: {
    pageSize?: number;
    /** Omit to sweep every corpus; name corpora for a targeted refresh. */
    sources?: readonly SearchBackfillSource[];
  } = {}
): Promise<SearchBackfillCounts> {
  const ctx: SweepContext = {
    client,
    pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
    selected: new Set(options.sources ?? ALL_SEARCH_BACKFILL_SOURCES),
  };
  const { pageSize } = ctx;

  const documents = await backfillSource(
    ctx,
    SearchBackfillSource.Documents,
    async (cursorId) => {
      const page = await client.artifact.findMany({
        // DOCUMENT-typed artifacts cover PRD/Implementation-Plan/Template docs and
        // Features (subtype FEATURE) — the Phase-1 "documents/features" corpus.
        where: { type: ArtifactType.Document },
        orderBy: { id: "asc" },
        take: pageSize,
        ...cursorPage(cursorId),
        select: {
          id: true,
          organizationId: true,
          name: true,
          slug: true,
          subtype: true,
          projectId: true,
          assigneeId: true,
          status: true,
          priority: true,
          updatedAt: true,
          // Latest version content is the searchable body (Phase-2: documents are
          // no longer title-only). `take: 1` by descending version bounds the read.
          document: {
            select: {
              versions: {
                orderBy: { version: "desc" },
                take: 1,
                select: { content: true },
              },
            },
          },
        },
      });
      return page.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        title: row.name,
        body: row.document?.versions[0]?.content ?? null,
        projectId: row.projectId,
        assigneeId: row.assigneeId,
        status: row.status,
        priority: row.priority,
        updatedAt: row.updatedAt,
        slug: row.slug,
        entitySubtype: row.subtype,
        teamId: null,
        anchorEntityId: null,
        [ENTITY_TYPE_KEY]: SearchEntityType.Document,
      }));
    }
  );

  const projects = await backfillSource(
    ctx,
    SearchBackfillSource.Projects,
    async (cursorId) => {
      const page = await client.project.findMany({
        where: {},
        orderBy: { id: "asc" },
        take: pageSize,
        ...cursorPage(cursorId),
        select: {
          id: true,
          organizationId: true,
          name: true,
          slug: true,
          description: true,
          assigneeId: true,
          status: true,
          priority: true,
          updatedAt: true,
          // Owning team for the team-scoped project route; first team only.
          teams: {
            take: 1,
            select: { teamId: true },
          },
        },
      });
      return page.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        title: row.name,
        body: row.description,
        projectId: row.id,
        assigneeId: row.assigneeId,
        status: row.status,
        priority: row.priority,
        updatedAt: row.updatedAt,
        slug: row.slug,
        entitySubtype: null,
        teamId: row.teams[0]?.teamId ?? null,
        anchorEntityId: null,
        [ENTITY_TYPE_KEY]: SearchEntityType.Project,
      }));
    }
  );

  const comments = await backfillSource(
    ctx,
    SearchBackfillSource.Comments,
    async (cursorId) => {
      const page = await client.comment.findMany({
        // Only non-deleted comments are indexed; a soft-deleted comment must not
        // surface in search (matches the query-side re-auth `deletedAt: null`).
        where: { deletedAt: null },
        orderBy: { id: "asc" },
        take: pageSize,
        ...cursorPage(cursorId),
        select: {
          id: true,
          plainText: true,
          authorId: true,
          updatedAt: true,
          // The thread carries the org SSOT and the anchored artifact (id + type),
          // which together build the comment's deep link.
          thread: {
            select: {
              organizationId: true,
              artifactId: true,
              artifact: { select: { type: true } },
            },
          },
        },
      });
      return page.map((row) => ({
        id: row.id,
        organizationId: row.thread.organizationId,
        // A short, human-readable title; the searchable text is the comment body.
        title: "Comment",
        body: row.plainText,
        projectId: null,
        assigneeId: row.authorId,
        // A comment carries no status/priority.
        status: null,
        priority: null,
        updatedAt: row.updatedAt,
        slug: null,
        // The anchor artifact's TYPE picks the session, branch or document route.
        entitySubtype: row.thread.artifact.type,
        teamId: null,
        anchorEntityId: row.thread.artifactId,
        [ENTITY_TYPE_KEY]: SearchEntityType.Comment,
      }));
    }
  );

  const pullRequests = await backfillSource(
    ctx,
    SearchBackfillSource.PullRequests,
    async (cursorId) => {
      const page = await client.pullRequestDetail.findMany({
        where: {},
        orderBy: { id: "asc" },
        take: pageSize,
        ...cursorPage(cursorId),
        select: {
          id: true,
          organizationId: true,
          title: true,
          body: true,
          branchArtifactId: true,
          // No PR updatedAt column; inherit the owning branch artifact's.
          branchArtifact: { select: { updatedAt: true } },
        },
      });
      return page.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        title: row.title ?? "",
        body: row.body,
        projectId: null,
        assigneeId: null,
        // A PR carries no status/priority in the projection.
        status: null,
        priority: null,
        updatedAt: row.branchArtifact.updatedAt,
        slug: null,
        entitySubtype: null,
        teamId: null,
        // A PR routes to its owning branch's detail page.
        anchorEntityId: row.branchArtifactId,
        [ENTITY_TYPE_KEY]: SearchEntityType.PullRequest,
      }));
    }
  );

  const branches = await backfillSource(
    ctx,
    SearchBackfillSource.Branches,
    async (cursorId) => {
      const page = await client.branchDetail.findMany({
        // Exclude soft-deleted branches (query-side re-auth also filters them out).
        where: { deletedAt: null },
        orderBy: { artifactId: "asc" },
        take: pageSize,
        ...cursorPageByArtifactId(cursorId),
        select: {
          artifactId: true,
          organizationId: true,
          branchName: true,
          baseBranch: true,
          repositoryFullName: true,
          updatedAt: true,
          // ISS-10332: the priority lives on the parent artifact. Read here so
          // this reconcile net cannot erase a value the write hook projected.
          artifact: { select: { priority: true } },
        },
      });
      return page.map((row) => ({
        // The branch's own entity id in the projection is its artifact id.
        id: row.artifactId,
        organizationId: row.organizationId,
        title: row.branchName,
        // Body carries the repo + base branch for extra full-text signal.
        body: branchSearchBody(row.repositoryFullName, row.baseBranch),
        projectId: null,
        assigneeId: null,
        // A branch carries no status in the projection; its priority is the
        // artifact's (ISS-10332), same as the write hook projects it.
        status: null,
        priority: row.artifact.priority,
        updatedAt: row.updatedAt,
        slug: null,
        entitySubtype: null,
        teamId: null,
        anchorEntityId: null,
        [ENTITY_TYPE_KEY]: SearchEntityType.Branch,
      }));
    }
  );

  const agentComponents = await backfillSource(
    ctx,
    SearchBackfillSource.AgentComponents,
    async (cursorId) => {
      const page = await client.agentComponent.findMany({
        // Index every org-scoped component (FEA-4011 Slice A). Uninstalled rows
        // are kept out of the projection so a removed component does not linger
        // in search.
        where: { uninstalledAt: null },
        orderBy: { id: "asc" },
        take: pageSize,
        ...cursorPage(cursorId),
        select: {
          id: true,
          organizationId: true,
          componentKind: true,
          name: true,
          componentKey: true,
          externalComponentId: true,
          description: true,
          updatedAt: true,
          // FEA-4335: content hash so the backfilled search slug routes to the
          // content-hash detail URI, matching the write-hook projection.
          contentHash: true,
        },
      });
      return page.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        // Title prefers the display name, then the component key, then the
        // always-present external id (a component's name is frequently null).
        title: row.name ?? row.componentKey ?? row.externalComponentId,
        // Body is the description only — the full definition content is never
        // indexed (it can be hundreds of KiB and would bloat the tsv).
        body: row.description,
        projectId: null,
        assigneeId: null,
        status: null,
        priority: null,
        updatedAt: row.updatedAt,
        // FEA-4335: prefer the content-hash routable slug so two same-named
        // different-content components backfill to DISTINCT detail URIs (matches
        // the write-hook `agentComponentProjection`); fall back to the name-level
        // handle for a hash-less row. Null for an empty identity so an
        // identity-less component degrades to a non-link instead of a `${kind}::`
        // 404. SSOT codec — never re-derived here.
        slug: backfillAgentComponentSlug(
          row.componentKind,
          row.componentKey,
          row.name,
          row.contentHash
        ),
        // The component kind rides in entity_subtype (matches the write hook).
        entitySubtype: row.componentKind,
        teamId: null,
        anchorEntityId: null,
        [ENTITY_TYPE_KEY]: SearchEntityType.AgentComponent,
      }));
    }
  );

  // After refreshing the live component rows, prune any `agent_component`
  // projection whose source component was uninstalled or cascade-deleted since
  // an earlier run — the upsert path never removes, so this anti-join is what
  // keeps the projection eventually consistent with removals (FEA-4011 review).
  //
  // It is the sweep's only DESTRUCTIVE statement, so it is gated on the same
  // selection as the corpus it prunes: a run narrowed to documents must not
  // delete component rows it never refreshed.
  const staleAgentComponentsRemoved = ctx.selected.has(
    SearchBackfillSource.AgentComponents
  )
    ? await client.removeStaleAgentComponentProjections()
    : 0;

  return {
    documents,
    projects,
    comments,
    pullRequests,
    branches,
    agentComponents,
    staleAgentComponentsRemoved,
    total:
      documents +
      projects +
      comments +
      pullRequests +
      branches +
      agentComponents,
  };
}

/**
 * Build the cursor/skip fragment for a keyset page. The first page has no
 * cursor; subsequent pages start strictly after the last id (`skip: 1`).
 */
function cursorPage(
  cursorId: string | null
): { cursor: { id: string }; skip: number } | Record<string, never> {
  if (cursorId === null) {
    return {};
  }
  return { cursor: { id: cursorId }, skip: 1 };
}

/**
 * The keyset page fragment for a table whose primary key is `artifactId` rather
 * than `id` (BranchDetail). The `cursorId` handed back by {@link backfillSource}
 * is the mapped `SourceRow.id` — for branches that is the branch's artifact id,
 * so it keys the Prisma cursor.
 */
function cursorPageByArtifactId(
  cursorId: string | null
): { cursor: { artifactId: string }; skip: number } | Record<string, never> {
  if (cursorId === null) {
    return {};
  }
  return { cursor: { artifactId: cursorId }, skip: 1 };
}

/**
 * Production `upsertProjectionRows`: one atomic multi-row
 * `INSERT ... ON CONFLICT DO UPDATE` per page over `search_document`. The
 * generated `tsv` column is Postgres-owned and never named here. A document
 * row's status is re-read from its source row inside this statement
 * (ISS-9938), not taken from the page read earlier: a status write committed in
 * between has already been copied onto the row by its trigger, and the page's
 * value would overwrite it. A status write still open when this statement reads
 * the source is not covered: the subselect sees the old status, the conflict
 * waits on the row lock that write's trigger holds, and the update then applies
 * the old value, which stays until the row's next status write.
 */
async function upsertRowsRaw(
  tx: TransactionClient,
  rows: ProjectionRow[]
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }

  const { Prisma } = await import("../generated/client");

  const values = rows.map(
    (r) =>
      // Generate the PK app-side as UUIDv7 to match schema.prisma's
      // `id String @default(uuid(7))` (Postgres has no v7 generator; the raw
      // insert bypasses Prisma's client-side default, so we supply it here). A
      // time-ordered id keeps the primary-key B-tree append-mostly as the
      // projection grows. On CONFLICT the row is updated in place, so a fresh
      // id per attempt is harmless.
      Prisma.sql`(${uuidV7()}::uuid, ${r.organizationId}::uuid, ${r.entityType}, ${r.entityId}::uuid, ${r.title}, ${r.body}, ${r.projectId ? Prisma.sql`${r.projectId}::uuid` : Prisma.sql`NULL`}, ${r.assigneeId ? Prisma.sql`${r.assigneeId}::uuid` : Prisma.sql`NULL`}, ${freshStatusSql(Prisma, r)}, ${r.priority}, ${r.updatedAt}, ${r.slug}, ${r.entitySubtype}, ${r.teamId ? Prisma.sql`${r.teamId}::uuid` : Prisma.sql`NULL`}, ${r.anchorEntityId ? Prisma.sql`${r.anchorEntityId}::uuid` : Prisma.sql`NULL`})`
  );

  const result = await tx.$executeRaw`
    INSERT INTO "search_document" (
      "id", "organization_id", "entity_type", "entity_id",
      "title", "body", "project_id", "assignee_id", "status", "priority",
      "updated_at", "slug", "entity_subtype", "team_id", "anchor_entity_id"
    )
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("organization_id", "entity_type", "entity_id")
    DO UPDATE SET
      "title" = EXCLUDED."title",
      "body" = EXCLUDED."body",
      "project_id" = EXCLUDED."project_id",
      "assignee_id" = EXCLUDED."assignee_id",
      "status" = EXCLUDED."status",
      "priority" = EXCLUDED."priority",
      "updated_at" = EXCLUDED."updated_at",
      "slug" = EXCLUDED."slug",
      "entity_subtype" = EXCLUDED."entity_subtype",
      "team_id" = EXCLUDED."team_id",
      "anchor_entity_id" = EXCLUDED."anchor_entity_id"
  `;

  return result;
}

/**
 * Production `removeStaleAgentComponentProjections`: delete every
 * `agent_component` projection row whose `entity_id` no longer maps to a live
 * (`uninstalled_at IS NULL`) `agent_components` row — an anti-join against the
 * current inventory. Scoped to the `agent_component` entity type so no other
 * corpus is touched. Returns the number of stale rows removed.
 */
async function removeStaleAgentComponentProjectionsRaw(
  tx: TransactionClient
): Promise<number> {
  return await tx.$executeRaw`
    DELETE FROM "search_document" sd
    WHERE sd."entity_type" = ${SearchEntityType.AgentComponent}
      AND NOT EXISTS (
        SELECT 1
        FROM "agent_components" ac
        WHERE ac."id" = sd."entity_id"
          AND ac."uninstalled_at" IS NULL
      )
  `;
}

/**
 * The exact Prisma delegate methods the backfill reads, each pinned to its real
 * `TransactionClient` signature. If Prisma renames/removes `findMany` on any of
 * these delegates the assignment in {@link toSearchBackfillClient} fails to
 * compile, surfacing the drift that a per-call `as` cast would hide.
 */
type PrismaDelegateMethods = {
  artifact: Pick<TransactionClient["artifact"], "findMany">;
  project: Pick<TransactionClient["project"], "findMany">;
  comment: Pick<TransactionClient["comment"], "findMany">;
  pullRequestDetail: Pick<TransactionClient["pullRequestDetail"], "findMany">;
  branchDetail: Pick<TransactionClient["branchDetail"], "findMany">;
  agentComponent: Pick<TransactionClient["agentComponent"], "findMany">;
};

/**
 * Bind the real Prisma delegates to the loose backfill-client surface. Mirrors
 * the pinned-delegate pattern in backfill-definition-versions.ts: the read
 * delegates are structurally verified against Prisma via
 * {@link PrismaDelegateMethods} and narrowed once (loose args ⊃ Prisma's
 * model-typed overloads), instead of casting args + return at every call site.
 * `upsertProjectionRows` is a custom raw-SQL method, not a Prisma delegate, so
 * it is wired directly.
 */
export function toSearchBackfillClient(
  tx: TransactionClient
): SearchBackfillClient {
  const pinnedDelegates: PrismaDelegateMethods = {
    artifact: tx.artifact,
    project: tx.project,
    comment: tx.comment,
    pullRequestDetail: tx.pullRequestDetail,
    branchDetail: tx.branchDetail,
    agentComponent: tx.agentComponent,
  };
  const readClient = pinnedDelegates as unknown as Pick<
    SearchBackfillClient,
    | "artifact"
    | "project"
    | "comment"
    | "pullRequestDetail"
    | "branchDetail"
    | "agentComponent"
  >;
  return {
    ...readClient,
    upsertProjectionRows: (rows) => upsertRowsRaw(tx, rows),
    removeStaleAgentComponentProjections: () =>
      removeStaleAgentComponentProjectionsRaw(tx),
  };
}

/**
 * Resolve `--only` out of an argv tail and run the sweep with exactly that
 * selection, returning the counts alongside the selection actually applied.
 *
 * The seam exists so the argv→`sources` wiring is reachable from a test: a
 * `main()` that composed it inline could lose the option and still leave every
 * unit test green while `--only=documents` silently swept — and pruned — the
 * whole corpus. Returning the resolved `sources` is what lets the caller name
 * the selection it ran, rather than the one it merely parsed.
 */
export async function runSearchDocumentBackfillFromArgv(
  client: SearchBackfillClient,
  argv: readonly string[]
): Promise<{
  counts: SearchBackfillCounts;
  sources: readonly SearchBackfillSource[];
}> {
  const sources =
    parseSearchBackfillSources(argv) ?? ALL_SEARCH_BACKFILL_SOURCES;
  const counts = await runSearchDocumentBackfill(client, { sources });
  return { counts, sources };
}

/**
 * CLI entrypoint. Runs the sweep inside one interactive transaction so a
 * failure rolls back cleanly and the run stays re-runnable. Defers the heavy
 * `@repo/database` client graph to runtime so importing this module for tests
 * never spins up a pool. `--only=<corpus>[,…]` narrows which corpora it sweeps.
 */
async function main(): Promise<void> {
  const { withDb } = await import("../index");
  const { counts, sources } = await withDb.tx(
    (tx) =>
      runSearchDocumentBackfillFromArgv(
        toSearchBackfillClient(tx),
        process.argv.slice(2)
      ),
    // A full historical sweep can exceed the 5s default; give it room.
    { timeout: 15 * 60 * 1000, maxWait: 30 * 1000 }
  );
  // Every per-corpus count below is 0 both for "swept, nothing to write" and
  // for "not selected", so the selection is printed beside them — and it is the
  // one the run applied, not the one parsed, so the label cannot outlive the
  // wiring that narrows the sweep.
  console.info(
    `[backfill-search-documents] committed: ${counts.total} projection rows over sources=${sources.join(",")} (documents=${counts.documents}, projects=${counts.projects}, comments=${counts.comments}, pullRequests=${counts.pullRequests}, branches=${counts.branches}, agentComponents=${counts.agentComponents}; staleAgentComponentsRemoved=${counts.staleAgentComponentsRemoved}).`
  );
}

// Only run when invoked directly (not when imported by the test).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  main().catch((error) => {
    console.error("[backfill-search-documents] failed:", error);
    process.exitCode = 1;
  });
}

/**
 * The contract types moved to `search-backfill-types.ts` for the file-size
 * split, but this module exported them first and stays their import path: a
 * split that relocates a name is refactoring, one that removes it is a contract
 * removal. `search-backfill-types.ts` is the canonical declaration; new callers
 * should import from there.
 */
export type {
  ProjectionRow,
  SearchBackfillClient,
  SearchBackfillCounts,
} from "./search-backfill-types";

/**
 * The `status` a projection row is written with. A trigger-owned row type
 * (ISS-9938) reads its source row's current status inside the upsert
 * statement, falling back to the page's value only when the source row is
 * gone; every other row type keeps the page's value. The apps/api indexer's
 * insert follows the same rule (`search-index-service.ts`).
 */
function freshStatusSql(prisma: typeof Prisma, r: ProjectionRow): Prisma.Sql {
  if (isStatusTriggerOwned(r.entityType)) {
    const readSource = STATUS_SOURCE_READS[r.entityType];
    return prisma.sql`COALESCE((${readSource(prisma, r.entityId, r.organizationId)}), ${r.status})`;
  }
  return prisma.sql`${r.status}`;
}

/**
 * Each trigger-owned row type's read of its source row's current status.
 * Keyed on the shared set, so a kind added to it does not compile until it has
 * a read here; `search-index-service.ts` carries the same record.
 */
const STATUS_SOURCE_READS: Record<
  StatusTriggerOwnedEntityType,
  (
    prisma: typeof Prisma,
    entityId: string,
    organizationId: string
  ) => Prisma.Sql
> = {
  [SearchEntityType.Document]: (prisma, entityId, organizationId) =>
    prisma.sql`SELECT a."status" FROM "artifacts" AS a WHERE a."id" = ${entityId}::uuid AND a."organization_id" = ${organizationId}::uuid`,
};
