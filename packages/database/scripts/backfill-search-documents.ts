/**
 * FEA-3857 (parent FEA-3800, PLN-1456 Slice 1) — one-shot, idempotent,
 * org-scoped backfill that populates the `search_document` full-text projection
 * from the DB-resident corpus: Document/Feature Artifacts, Projects, Loops,
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
 * {@link MAX_SEARCH_BODY_CHARS} (else left null) — a project's `description`, a
 * loop's `prompt` (the loop's own request text), and, since the Phase-2
 * navigation slice (parent FEA-3800), a DOCUMENT's latest-version content (no
 * longer title-only). ROUTE FIELDS: documents also carry `slug` + `entitySubtype`
 * (their `type`), and projects `slug` + `teamId` (owning team), so a hit can
 * build its real web route; loops route by id and carry none.
 */

import "server-only";

import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  boundSearchText,
  MAX_SEARCH_BODY_CHARS,
  MAX_SEARCH_TITLE_CHARS,
} from "@repo/api/src/types/search";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import type { TransactionClient } from "../index";
import {
  backfillAgentComponentSlug,
  branchSearchBody,
  uuidV7,
} from "./search-backfill-values";

/** Page size for the bounded cursor scan of each source table. */
export const DEFAULT_PAGE_SIZE = 500;

/**
 * A single projection row to upsert. Mirrors the writable columns of
 * `search_document` (the generated `tsv` is Postgres-owned and never set here).
 */
export type ProjectionRow = {
  organizationId: string;
  entityType: SearchEntityType;
  entityId: string;
  title: string;
  body: string | null;
  projectId: string | null;
  assigneeId: string | null;
  // Structured-filter columns (FEA-3930): the source entity's own status /
  // priority as raw strings, null where the source has no such field (loops have
  // no priority; comments/PRs/branches have neither).
  status: string | null;
  priority: string | null;
  updatedAt: Date;
  // Phase-2 route fields (parent FEA-3800): the type that does not carry a given
  // field leaves it null (documents: slug + entitySubtype; projects: slug +
  // teamId; loops: none).
  slug: string | null;
  entitySubtype: string | null;
  teamId: string | null;
  // Route anchor (FEA-3930 comment/PR/branch slice): the id of a DIFFERENT entity
  // the hit routes to (PR → owning branch; comment → anchored artifact). Null for
  // the types that route off their own `entityId`.
  anchorEntityId: string | null;
};

/** A source row as read from a page of one corpus table. */
type SourceRow = {
  id: string;
  organizationId: string;
  title: string;
  body: string | null;
  projectId: string | null;
  assigneeId: string | null;
  status: string | null;
  priority: string | null;
  updatedAt: Date;
  slug: string | null;
  entitySubtype: string | null;
  teamId: string | null;
  anchorEntityId: string | null;
};

/**
 * The minimal Prisma-shaped client surface the backfill needs, declared
 * structurally (a loose subset of `TransactionClient`) so the unit test can
 * inject a faithful in-memory fake and prove idempotency + row shape with NO
 * database — the same DB-free posture as the definition-versions backfill.
 */
export type SearchBackfillClient = {
  artifact: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
      take: number;
      cursor?: { id: string };
      skip?: number;
      // Documents select the latest version content through a nested relation
      // (`document: { select: { versions: { orderBy, take, select } } }`), so a
      // scalar boolean map is not enough here.
      select: Record<string, boolean | Record<string, unknown>>;
    }): Promise<
      Array<{
        id: string;
        organizationId: string;
        name: string;
        slug: string | null;
        subtype: string | null;
        projectId: string | null;
        assigneeId: string | null;
        // Freeform artifact status (FeatureStatus/DocumentStatus) + priority.
        status: string | null;
        priority: string | null;
        updatedAt: Date;
        // Latest version (take: 1, version desc) carries the document's content
        // as the searchable body; empty when the document has no versions.
        document: { versions: Array<{ content: string | null }> } | null;
      }>
    >;
  };
  project: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
      take: number;
      cursor?: { id: string };
      skip?: number;
      // Projects select the owning team through a nested relation
      // (`teams: { take: 1, select: { teamId } }`).
      select: Record<string, boolean | Record<string, unknown>>;
    }): Promise<
      Array<{
        id: string;
        organizationId: string;
        name: string;
        slug: string | null;
        description: string | null;
        assigneeId: string | null;
        // ProjectStatus + Priority as their raw string values.
        status: string | null;
        priority: string | null;
        updatedAt: Date;
        // First team association carries the owning team id; empty when none.
        teams: Array<{ teamId: string }>;
      }>
    >;
  };
  loop: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
      take: number;
      cursor?: { id: string };
      skip?: number;
      // Loops select a nested relation (`artifact: { select: { projectId } }`)
      // for visibility, so a scalar boolean map is not enough here.
      select: Record<string, boolean | { select: Record<string, boolean> }>;
    }): Promise<
      Array<{
        id: string;
        organizationId: string;
        command: string;
        prompt: string | null;
        // LoopStatus as its raw string; a loop has no priority.
        status: string | null;
        // The loop's visibility follows its target artifact's project; the
        // nested select carries that project id (null for cloud/legacy runs
        // with no artifact, or an artifact that itself has no project).
        artifact: { projectId: string | null } | null;
        userId: string;
        updatedAt: Date;
      }>
    >;
  };
  comment: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
      take: number;
      cursor?: { id: string };
      skip?: number;
      // Comments select the owning thread's org + anchor artifact (id + type)
      // through a nested relation (`thread: { select: { organizationId,
      // artifactId, artifact: { select: { type } } } }`).
      select: Record<string, boolean | Record<string, unknown>>;
    }): Promise<
      Array<{
        id: string;
        plainText: string | null;
        authorId: string;
        updatedAt: Date;
        // The comment's thread carries the org SSOT and the anchored artifact.
        thread: {
          organizationId: string;
          artifactId: string | null;
          artifact: { type: string } | null;
        };
      }>
    >;
  };
  pullRequestDetail: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
      take: number;
      cursor?: { id: string };
      skip?: number;
      // PullRequestDetail has no updatedAt column of its own, so the branch
      // artifact's updatedAt is selected through the nested relation
      // (`branchArtifact: { select: { updatedAt } }`) as the PR row's freshness.
      select: Record<string, boolean | Record<string, unknown>>;
    }): Promise<
      Array<{
        id: string;
        organizationId: string;
        title: string | null;
        body: string | null;
        branchArtifactId: string;
        branchArtifact: { updatedAt: Date };
      }>
    >;
  };
  branchDetail: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
      take: number;
      cursor?: { artifactId: string };
      skip?: number;
      select: Record<string, boolean>;
    }): Promise<
      Array<{
        artifactId: string;
        organizationId: string;
        branchName: string;
        baseBranch: string | null;
        repositoryFullName: string;
        updatedAt: Date;
      }>
    >;
  };
  agentComponent: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
      take: number;
      cursor?: { id: string };
      skip?: number;
      select: Record<string, boolean>;
    }): Promise<
      Array<{
        id: string;
        organizationId: string;
        componentKind: string;
        name: string | null;
        componentKey: string | null;
        externalComponentId: string;
        description: string | null;
        updatedAt: Date;
        contentHash: string | null;
      }>
    >;
  };
  /**
   * Atomic per-page upsert into `search_document` keyed on
   * `(organization_id, entity_type, entity_id)`. Returns the number of rows
   * written (inserted + updated). Implemented over raw SQL in production; the
   * test fake records rows into a keyed map.
   */
  upsertProjectionRows(rows: ProjectionRow[]): Promise<number>;
  /**
   * Remove `agent_component` projection rows whose source `AgentComponent` is
   * gone or uninstalled (an anti-join against the live inventory). The upsert
   * path only ADDS/refreshes rows, so a component that was uninstalled or
   * cascade-deleted after an earlier run would otherwise linger in search
   * forever. Returns the number of stale rows deleted. FEA-4011 review.
   */
  removeStaleAgentComponentProjections(): Promise<number>;
};

/** Per-source and total counts returned by a run. */
export type SearchBackfillCounts = {
  documents: number;
  projects: number;
  loops: number;
  comments: number;
  pullRequests: number;
  branches: number;
  agentComponents: number;
  /** Stale `agent_component` projection rows removed by the anti-join cleanup. */
  staleAgentComponentsRemoved: number;
  total: number;
};

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

/**
 * Page a single source through the cursor scan and hand each page to `mapPage`,
 * upserting the mapped rows. Returns the count of projection rows written.
 * Paginates until a short page proves the source is exhausted.
 */
async function backfillSource(
  client: SearchBackfillClient,
  pageSize: number,
  readPage: (cursorId: string | null) => Promise<SourceRow[]>
): Promise<number> {
  let written = 0;
  let cursorId: string | null = null;

  // eslint-disable-next-line no-constant-condition
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
 * description as body; Loops are titled by command with the prompt as body.
 */
export async function runSearchDocumentBackfill(
  client: SearchBackfillClient,
  options: { pageSize?: number } = {}
): Promise<SearchBackfillCounts> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

  const documents = await backfillSource(client, pageSize, async (cursorId) => {
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
  });

  const projects = await backfillSource(client, pageSize, async (cursorId) => {
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
  });

  const loops = await backfillSource(client, pageSize, async (cursorId) => {
    const page = await client.loop.findMany({
      where: {},
      orderBy: { id: "asc" },
      take: pageSize,
      ...cursorPage(cursorId),
      select: {
        id: true,
        organizationId: true,
        command: true,
        prompt: true,
        status: true,
        artifact: { select: { projectId: true } },
        userId: true,
        updatedAt: true,
      },
    });
    return page.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      title: row.command,
      body: row.prompt,
      // A loop's visibility follows its target artifact's project (null for
      // cloud/legacy runs without an artifact, or an artifact with no project);
      // assignee maps to the initiating user.
      projectId: row.artifact?.projectId ?? null,
      assigneeId: row.userId,
      // A loop carries a status (LoopStatus) but no priority.
      status: row.status,
      priority: null,
      updatedAt: row.updatedAt,
      // Loops route by id (`/loops/<id>`) and carry no slug/subtype/team.
      slug: null,
      entitySubtype: null,
      teamId: null,
      anchorEntityId: null,
      [ENTITY_TYPE_KEY]: SearchEntityType.Loop,
    }));
  });

  const comments = await backfillSource(client, pageSize, async (cursorId) => {
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
      // The anchor artifact's TYPE drives session-vs-branch route selection.
      entitySubtype: row.thread.artifact?.type ?? null,
      teamId: null,
      anchorEntityId: row.thread.artifactId,
      [ENTITY_TYPE_KEY]: SearchEntityType.Comment,
    }));
  });

  const pullRequests = await backfillSource(
    client,
    pageSize,
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

  const branches = await backfillSource(client, pageSize, async (cursorId) => {
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
      // A branch carries no status/priority in the projection.
      status: null,
      priority: null,
      updatedAt: row.updatedAt,
      slug: null,
      entitySubtype: null,
      teamId: null,
      anchorEntityId: null,
      [ENTITY_TYPE_KEY]: SearchEntityType.Branch,
    }));
  });

  const agentComponents = await backfillSource(
    client,
    pageSize,
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
  const staleAgentComponentsRemoved =
    await client.removeStaleAgentComponentProjections();

  return {
    documents,
    projects,
    loops,
    comments,
    pullRequests,
    branches,
    agentComponents,
    staleAgentComponentsRemoved,
    total:
      documents +
      projects +
      loops +
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
 * generated `tsv` column is Postgres-owned and never named here.
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
      Prisma.sql`(${uuidV7()}::uuid, ${r.organizationId}::uuid, ${r.entityType}, ${r.entityId}::uuid, ${r.title}, ${r.body}, ${r.projectId ? Prisma.sql`${r.projectId}::uuid` : Prisma.sql`NULL`}, ${r.assigneeId ? Prisma.sql`${r.assigneeId}::uuid` : Prisma.sql`NULL`}, ${r.status}, ${r.priority}, ${r.updatedAt}, ${r.slug}, ${r.entitySubtype}, ${r.teamId ? Prisma.sql`${r.teamId}::uuid` : Prisma.sql`NULL`}, ${r.anchorEntityId ? Prisma.sql`${r.anchorEntityId}::uuid` : Prisma.sql`NULL`})`
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
  loop: Pick<TransactionClient["loop"], "findMany">;
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
    loop: tx.loop,
    comment: tx.comment,
    pullRequestDetail: tx.pullRequestDetail,
    branchDetail: tx.branchDetail,
    agentComponent: tx.agentComponent,
  };
  const readClient = pinnedDelegates as unknown as Pick<
    SearchBackfillClient,
    | "artifact"
    | "project"
    | "loop"
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
 * CLI entrypoint. Runs the whole sweep inside one interactive transaction so a
 * failure rolls back cleanly and the run stays re-runnable. Defers the heavy
 * `@repo/database` client graph to runtime so importing this module for tests
 * never spins up a pool.
 */
async function main(): Promise<void> {
  const { withDb } = await import("../index");
  const counts = await withDb.tx(
    (tx) => runSearchDocumentBackfill(toSearchBackfillClient(tx)),
    // A full historical sweep can exceed the 5s default; give it room.
    { timeout: 15 * 60 * 1000, maxWait: 30 * 1000 }
  );
  console.info(
    `[backfill-search-documents] committed: ${counts.total} projection rows (documents=${counts.documents}, projects=${counts.projects}, loops=${counts.loops}, comments=${counts.comments}, pullRequests=${counts.pullRequests}, branches=${counts.branches}, agentComponents=${counts.agentComponents}; staleAgentComponentsRemoved=${counts.staleAgentComponentsRemoved}).`
  );
}

// Only run when invoked directly (not when imported by the test).
if (
  typeof process !== "undefined" &&
  import.meta.url === `file://${process.argv[1]}`
) {
  main().catch((error) => {
    console.error("[backfill-search-documents] failed:", error);
    process.exitCode = 1;
  });
}
