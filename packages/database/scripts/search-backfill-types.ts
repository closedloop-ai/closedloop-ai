/**
 * The contract types for the `search_document` backfill: the projection row it
 * writes, the source row each corpus mapper produces, the Prisma-shaped client
 * surface it reads through, and the counts a run returns.
 *
 * Split out of `backfill-search-documents.ts` (ISS-9699) so that file carries
 * only the sweep itself and stays under the repository's file-size ceiling.
 * `SearchBackfillClient` is declared structurally — a loose subset of
 * `TransactionClient` — so the unit tests can inject a faithful in-memory fake
 * and prove row shape and idempotency with NO database.
 */

import type { SearchEntityType } from "@repo/api/src/types/search-entity-kind";

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
  // priority as raw strings, null where the source has no such field
  // (comments/PRs/branches have neither).
  status: string | null;
  priority: string | null;
  updatedAt: Date;
  // Phase-2 route fields (parent FEA-3800): the type that does not carry a given
  // field leaves it null (documents: slug + entitySubtype; projects: slug +
  // teamId).
  slug: string | null;
  entitySubtype: string | null;
  teamId: string | null;
  // Route anchor (FEA-3930 comment/PR/branch slice): the id of a DIFFERENT entity
  // the hit routes to (PR → owning branch; comment → anchored artifact). Null for
  // the types that route off their own `entityId`.
  anchorEntityId: string | null;
};

/** A source row as read from a page of one corpus table. */
export type SourceRow = {
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
          artifactId: string;
          artifact: { type: string };
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
      // Branches select the parent artifact's priority through a nested
      // relation (`artifact: { select: { priority } }`, ISS-10332).
      select: Record<string, boolean | { select: Record<string, boolean> }>;
    }): Promise<
      Array<{
        artifactId: string;
        organizationId: string;
        branchName: string;
        baseBranch: string | null;
        repositoryFullName: string;
        updatedAt: Date;
        artifact: { priority: string | null };
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
  comments: number;
  pullRequests: number;
  branches: number;
  agentComponents: number;
  /** Stale `agent_component` projection rows removed by the anti-join cleanup. */
  staleAgentComponentsRemoved: number;
  total: number;
};
