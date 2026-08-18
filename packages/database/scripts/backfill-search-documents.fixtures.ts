/**
 * Shared DB-free test fixtures for the `search_document` backfill unit tests
 * (FEA-3857 / FEA-3930 / FEA-4011). Extracted from the test file so the
 * per-corpus test suites stay under the file-size ceiling while sharing ONE
 * faithful in-memory `SearchBackfillClient` fake and its record factories.
 *
 * Not a `*.test.ts` file — it declares no tests; it is imported by the corpus
 * test files.
 */

import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import type {
  ProjectionRow,
  SearchBackfillClient,
} from "./backfill-search-documents";

export const ORG_A = "00000000-0000-0000-0000-00000000000a";
export const ORG_B = "00000000-0000-0000-0000-00000000000b";

export const AT = new Date("2026-07-22T00:00:00.000Z");

export type ArtifactRecord = {
  id: string;
  organizationId: string;
  type: string;
  name: string;
  slug: string | null;
  subtype: string | null;
  projectId: string | null;
  assigneeId: string | null;
  status: string | null;
  priority: string | null;
  updatedAt: Date;
  // Latest-version content, exposed by the fake through the nested
  // `document.versions[0].content` shape the backfill reads.
  content: string | null;
};
export type ProjectRecord = {
  id: string;
  organizationId: string;
  name: string;
  slug: string | null;
  description: string | null;
  assigneeId: string | null;
  status: string | null;
  priority: string | null;
  updatedAt: Date;
  // Owning team ids; the backfill reads the first via `teams[0].teamId`.
  teamIds: string[];
};
export type LoopRecord = {
  id: string;
  organizationId: string;
  command: string;
  prompt: string | null;
  status: string | null;
  // The loop's target artifact carries the visibility project id (null when the
  // loop has no artifact, or its artifact has no project).
  artifact: { projectId: string | null } | null;
  userId: string;
  updatedAt: Date;
};
export type CommentRecord = {
  id: string;
  plainText: string | null;
  authorId: string;
  updatedAt: Date;
  deletedAt: Date | null;
  // The owning thread carries the org SSOT and the anchored artifact (id + type).
  thread: {
    organizationId: string;
    artifactId: string | null;
    artifactType: string | null;
  };
};
export type PullRequestRecord = {
  id: string;
  organizationId: string;
  title: string | null;
  body: string | null;
  branchArtifactId: string;
  // PullRequestDetail has no updatedAt column of its own; the backfill inherits
  // the owning branch artifact's updatedAt via the nested relation.
  branchUpdatedAt: Date;
};
export type BranchRecord = {
  artifactId: string;
  organizationId: string;
  branchName: string;
  baseBranch: string | null;
  repositoryFullName: string;
  updatedAt: Date;
  deletedAt: Date | null;
};
export type AgentComponentRecord = {
  id: string;
  organizationId: string;
  componentKind: string;
  name: string | null;
  componentKey: string | null;
  externalComponentId: string;
  description: string | null;
  updatedAt: Date;
  uninstalledAt: Date | null;
  // FEA-4335: the coarse content hash the backfill projects into the routable
  // search slug; optional so existing fixtures that omit it default to a
  // name-level slug.
  contentHash?: string | null;
};

/**
 * In-memory fake that mimics keyset pagination and an atomic upsert keyed on
 * `(organizationId, entityType, entityId)`. The projection store is a Map so a
 * conflicting insert overwrites in place — exactly like `ON CONFLICT DO UPDATE`.
 */
export function makeFakeClient(seed: {
  artifacts: ArtifactRecord[];
  projects: ProjectRecord[];
  loops: LoopRecord[];
  comments?: CommentRecord[];
  pullRequests?: PullRequestRecord[];
  branches?: BranchRecord[];
  agentComponents?: AgentComponentRecord[];
}): {
  client: SearchBackfillClient;
  store: Map<string, ProjectionRow>;
  upsertCalls: number;
} {
  const store = new Map<string, ProjectionRow>();
  let upsertCalls = 0;

  function pageById<T extends { id: string }>(
    all: T[],
    args: { take: number; cursor?: { id: string }; skip?: number }
  ): T[] {
    const sorted = [...all].sort((a, b) => (a.id < b.id ? -1 : 1));
    let start = 0;
    if (args.cursor) {
      const idx = sorted.findIndex((r) => r.id === args.cursor?.id);
      start = idx === -1 ? sorted.length : idx + (args.skip ?? 0);
    }
    return sorted.slice(start, start + args.take);
  }

  function pageByArtifactId<T extends { artifactId: string }>(
    all: T[],
    args: { take: number; cursor?: { artifactId: string }; skip?: number }
  ): T[] {
    const sorted = [...all].sort((a, b) =>
      a.artifactId < b.artifactId ? -1 : 1
    );
    let start = 0;
    if (args.cursor) {
      const idx = sorted.findIndex(
        (r) => r.artifactId === args.cursor?.artifactId
      );
      start = idx === -1 ? sorted.length : idx + (args.skip ?? 0);
    }
    return sorted.slice(start, start + args.take);
  }

  const client: SearchBackfillClient = {
    artifact: {
      findMany: (args) => {
        const matched = seed.artifacts.filter(
          (a) => a.type === (args.where as { type?: string }).type
        );
        return Promise.resolve(
          pageById(matched, args).map((a) => ({
            id: a.id,
            organizationId: a.organizationId,
            name: a.name,
            slug: a.slug,
            subtype: a.subtype,
            projectId: a.projectId,
            assigneeId: a.assigneeId,
            status: a.status,
            priority: a.priority,
            updatedAt: a.updatedAt,
            document:
              a.content === null
                ? { versions: [] }
                : { versions: [{ content: a.content }] },
          }))
        );
      },
    },
    project: {
      findMany: (args) =>
        Promise.resolve(
          pageById(seed.projects, args).map((p) => ({
            id: p.id,
            organizationId: p.organizationId,
            name: p.name,
            slug: p.slug,
            description: p.description,
            assigneeId: p.assigneeId,
            status: p.status,
            priority: p.priority,
            updatedAt: p.updatedAt,
            teams: p.teamIds.map((teamId) => ({ teamId })),
          }))
        ),
    },
    loop: {
      findMany: (args) =>
        Promise.resolve(
          pageById(seed.loops, args).map((l) => ({
            id: l.id,
            organizationId: l.organizationId,
            command: l.command,
            prompt: l.prompt,
            status: l.status,
            artifact: l.artifact,
            userId: l.userId,
            updatedAt: l.updatedAt,
          }))
        ),
    },
    comment: {
      findMany: (args) => {
        // Mirror the production `where: { deletedAt: null }` filter.
        const live = (seed.comments ?? []).filter((c) => c.deletedAt === null);
        return Promise.resolve(
          pageById(live, args).map((c) => ({
            id: c.id,
            plainText: c.plainText,
            authorId: c.authorId,
            updatedAt: c.updatedAt,
            thread: {
              organizationId: c.thread.organizationId,
              artifactId: c.thread.artifactId,
              artifact:
                c.thread.artifactType === null
                  ? null
                  : { type: c.thread.artifactType },
            },
          }))
        );
      },
    },
    pullRequestDetail: {
      findMany: (args) =>
        Promise.resolve(
          pageById(seed.pullRequests ?? [], args).map((pr) => ({
            id: pr.id,
            organizationId: pr.organizationId,
            title: pr.title,
            body: pr.body,
            branchArtifactId: pr.branchArtifactId,
            branchArtifact: { updatedAt: pr.branchUpdatedAt },
          }))
        ),
    },
    branchDetail: {
      findMany: (args) => {
        const live = (seed.branches ?? []).filter((b) => b.deletedAt === null);
        return Promise.resolve(
          pageByArtifactId(live, args).map((b) => ({
            artifactId: b.artifactId,
            organizationId: b.organizationId,
            branchName: b.branchName,
            baseBranch: b.baseBranch,
            repositoryFullName: b.repositoryFullName,
            updatedAt: b.updatedAt,
          }))
        );
      },
    },
    agentComponent: {
      findMany: (args) => {
        // Mirror the production `where: { uninstalledAt: null }` filter.
        const live = (seed.agentComponents ?? []).filter(
          (c) => c.uninstalledAt === null
        );
        return Promise.resolve(
          pageById(live, args).map((c) => ({
            id: c.id,
            organizationId: c.organizationId,
            componentKind: c.componentKind,
            name: c.name,
            componentKey: c.componentKey,
            externalComponentId: c.externalComponentId,
            description: c.description,
            updatedAt: c.updatedAt,
            // FEA-4335: null unless the fixture sets a hash (name-level slug).
            contentHash: c.contentHash ?? null,
          }))
        );
      },
    },
    upsertProjectionRows: (rows) => {
      upsertCalls += 1;
      for (const row of rows) {
        store.set(
          `${row.organizationId}|${row.entityType}|${row.entityId}`,
          row
        );
      }
      return Promise.resolve(rows.length);
    },
    removeStaleAgentComponentProjections: () => {
      // Mirror the production anti-join: drop every agent_component projection
      // whose entityId no longer maps to a live (uninstalledAt === null) seeded
      // component. Org-agnostic like the SQL (the entity id is globally unique).
      const liveIds = new Set(
        (seed.agentComponents ?? [])
          .filter((c) => c.uninstalledAt === null)
          .map((c) => c.id)
      );
      let removed = 0;
      for (const [key, row] of store) {
        if (
          row.entityType === SearchEntityType.AgentComponent &&
          !liveIds.has(row.entityId)
        ) {
          store.delete(key);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },
  };

  return {
    client,
    store,
    get upsertCalls() {
      return upsertCalls;
    },
  } as {
    client: SearchBackfillClient;
    store: Map<string, ProjectionRow>;
    upsertCalls: number;
  };
}

export function artifact(
  over: Partial<ArtifactRecord> & { id: string }
): ArtifactRecord {
  return {
    organizationId: ORG_A,
    type: "DOCUMENT",
    name: "Doc",
    slug: null,
    subtype: null,
    projectId: null,
    assigneeId: null,
    status: null,
    priority: null,
    updatedAt: AT,
    content: null,
    ...over,
  };
}
export function project(
  over: Partial<ProjectRecord> & { id: string }
): ProjectRecord {
  return {
    organizationId: ORG_A,
    name: "Proj",
    slug: null,
    description: null,
    assigneeId: null,
    status: null,
    priority: null,
    updatedAt: AT,
    teamIds: [],
    ...over,
  };
}
export function loop(over: Partial<LoopRecord> & { id: string }): LoopRecord {
  return {
    organizationId: ORG_A,
    command: "plan",
    prompt: null,
    status: null,
    artifact: null,
    userId: "user-1",
    updatedAt: AT,
    ...over,
  };
}
export function comment(
  over: Partial<CommentRecord> & { id: string }
): CommentRecord {
  return {
    plainText: null,
    authorId: "author-1",
    updatedAt: AT,
    deletedAt: null,
    thread: {
      organizationId: ORG_A,
      artifactId: null,
      artifactType: null,
    },
    ...over,
  };
}
export function pullRequest(
  over: Partial<PullRequestRecord> & { id: string }
): PullRequestRecord {
  return {
    organizationId: ORG_A,
    title: null,
    body: null,
    branchArtifactId: "branch-artifact-1",
    branchUpdatedAt: AT,
    ...over,
  };
}
export function branch(
  over: Partial<BranchRecord> & { artifactId: string }
): BranchRecord {
  return {
    organizationId: ORG_A,
    branchName: "feature/x",
    baseBranch: null,
    repositoryFullName: "acme/repo",
    updatedAt: AT,
    deletedAt: null,
    ...over,
  };
}
export function agentComponent(
  over: Partial<AgentComponentRecord> & { id: string }
): AgentComponentRecord {
  return {
    organizationId: ORG_A,
    componentKind: "skill",
    name: null,
    componentKey: null,
    externalComponentId: "ext-1",
    description: null,
    updatedAt: AT,
    uninstalledAt: null,
    ...over,
  };
}
