import { SearchMode } from "@repo/api/src/types/search";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { withDb } from "@repo/database";
import { type Mock, vi } from "vitest";
import type { UnifiedSearchParams } from "@/app/search/search-fts-service";

/**
 * Shared doubles for the `search-fts-service` suites. Each suite mocks
 * `@repo/database` itself, so `withDb` here is that suite's mock.
 */

export const mockWithDb = withDb as unknown as Mock;
export const ORG = "11111111-1111-1111-1111-111111111111";
/** The `entity_id = …` equality predicate only the EXACT id/slug lane emits. */
export const EXACT_ID_PREDICATE = /entity_id"?\s*=/;

export type Candidate = {
  entity_type: string;
  entity_id: string;
  title: string;
  snippet: string;
  rank: number;
  updated_at: Date;
  slug: string | null;
  entity_subtype: string | null;
  team_id: string | null;
  anchor_entity_id: string | null;
};

/**
 * Flatten a mocked Prisma.sql fragment tree to raw SQL text so the `$queryRaw`
 * fake can tell the EXACT id/slug lane (`entity_id = …::uuid` / `lower("slug")`)
 * apart from the FTS candidate scan.
 */
export function sqlText(node: unknown): string {
  if (node === null || node === undefined) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (typeof node === "object") {
    const n = node as {
      strings?: string[];
      values?: unknown[];
      join?: unknown[];
    };
    if (Array.isArray(n.join)) {
      return n.join.map(sqlText).join(" ");
    }
    if (Array.isArray(n.strings)) {
      return n.strings.join(" ") + (n.values ?? []).map(sqlText).join(" ");
    }
  }
  return "";
}

/**
 * Install a fake `withDb` whose db exposes `$queryRaw` (returns the given
 * candidates) and `artifact/project.findMany` (returns only the ids present
 * in `visible[type]`) — the source-of-truth re-auth mock. Records the ids each
 * source table was queried with so a test can assert re-auth is set-based.
 */
export function installDb(options: {
  candidates: Candidate[];
  visible: Partial<Record<string, string[]>>;
  onFind?: (type: string, ids: string[]) => void;
  /** Org's `searchIncludeTranscripts` value returned by organization.findUnique. */
  transcriptGateOn?: boolean;
  /** Rows the EXACT id/slug lookup lane returns (defaults to none). */
  exactCandidates?: Candidate[];
  /** Users the `@owner` resolver returns (defaults to none). */
  ownerUserIds?: string[];
  /** Projects the `:project` resolver returns (defaults to none). */
  projectRows?: Array<{ id: string }>;
}): FakeSearchDb {
  const findFor = (type: string) =>
    vi.fn(
      (args: { where: { id: { in: string[] }; [key: string]: unknown } }) => {
        const requested = args.where.id.in;
        options.onFind?.(type, requested);
        const allowed = new Set(options.visible[type] ?? []);
        return Promise.resolve(
          requested.filter((id) => allowed.has(id)).map((id) => ({ id }))
        );
      }
    );

  // agent_session re-auth queries SessionDetail by `artifactId` and returns
  // `{ artifactId }` rows, so it needs its own shaped fake.
  const sessionFindMany = vi.fn(
    (args: { where: { artifactId: { in: string[] } } }) => {
      const requested = args.where.artifactId.in;
      options.onFind?.(SearchEntityType.AgentSession, requested);
      const allowed = new Set(
        options.visible[SearchEntityType.AgentSession] ?? []
      );
      return Promise.resolve(
        requested
          .filter((id) => allowed.has(id))
          .map((id) => ({ artifactId: id }))
      );
    }
  );

  // Comment re-auth queries `comment.findMany` scoped through the owning thread
  // (`thread.is.organizationId`) + `deletedAt: null`, returning `{ id }` rows.
  const commentFindMany = vi.fn(
    (args: { where: { id: { in: string[] }; [key: string]: unknown } }) => {
      const requested = args.where.id.in;
      options.onFind?.(SearchEntityType.Comment, requested);
      const allowed = new Set(options.visible[SearchEntityType.Comment] ?? []);
      return Promise.resolve(
        requested.filter((id) => allowed.has(id)).map((id) => ({ id }))
      );
    }
  );

  // Branch re-auth queries `branchDetail.findMany` by `artifactId`, returning
  // `{ artifactId }` rows.
  const branchFindMany = vi.fn(
    (args: { where: { artifactId: { in: string[] } } }) => {
      const requested = args.where.artifactId.in;
      options.onFind?.(SearchEntityType.Branch, requested);
      const allowed = new Set(options.visible[SearchEntityType.Branch] ?? []);
      return Promise.resolve(
        requested
          .filter((id) => allowed.has(id))
          .map((id) => ({ artifactId: id }))
      );
    }
  );

  // The EXACT id/slug lane and the FTS candidate scan both hit `$queryRaw`; route
  // by SQL shape (the exact lane carries `entity_id = …::uuid` / `lower("slug")`
  // and never a `tsv @@` match).
  const queryRaw = vi.fn((node: unknown) => {
    const text = sqlText(node);
    const isExactLane =
      text.includes("lower(") || EXACT_ID_PREDICATE.test(text);
    return Promise.resolve(
      isExactLane ? (options.exactCandidates ?? []) : options.candidates
    );
  });

  const projectFindMany = vi.fn(
    (args: { where: { id?: { in: string[] }; organizationId?: string } }) => {
      // `:project` resolver (id-less where) vs the project re-auth lane (id.in).
      if (args.where.id?.in) {
        const requested = args.where.id.in;
        options.onFind?.(SearchEntityType.Project, requested);
        const allowed = new Set(
          options.visible[SearchEntityType.Project] ?? []
        );
        return Promise.resolve(
          requested.filter((id) => allowed.has(id)).map((id) => ({ id }))
        );
      }
      return Promise.resolve(options.projectRows ?? []);
    }
  );

  const db = {
    $queryRaw: queryRaw,
    artifact: { findMany: findFor(SearchEntityType.Document) },
    project: { findMany: projectFindMany },
    user: {
      findMany: vi.fn(() =>
        Promise.resolve((options.ownerUserIds ?? []).map((id) => ({ id })))
      ),
    },
    sessionDetail: { findMany: sessionFindMany },
    comment: { findMany: commentFindMany },
    pullRequestDetail: { findMany: findFor(SearchEntityType.PullRequest) },
    branchDetail: { findMany: branchFindMany },
    // agent_component re-auth (FEA-4011 Slice A) queries `agentComponent.findMany`
    // by `id` scoped to the org, returning `{ id }` rows — same shape as findFor.
    agentComponent: { findMany: findFor(SearchEntityType.AgentComponent) },
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        searchIncludeTranscripts: options.transcriptGateOn ?? false,
      }),
    },
  };
  mockWithDb.mockImplementation((cb: (d: unknown) => unknown) => cb(db));
  return db;
}

type FakeFindMany = { findMany: Mock };

export type FakeSearchDb = {
  $queryRaw: Mock;
  artifact: FakeFindMany;
  project: FakeFindMany;
  user: FakeFindMany;
  sessionDetail: FakeFindMany;
  comment: FakeFindMany;
  pullRequestDetail: FakeFindMany;
  branchDetail: FakeFindMany;
  agentComponent: FakeFindMany;
  organization: { findUnique: Mock };
};

export function baseParams(
  over: Partial<UnifiedSearchParams> = {}
): UnifiedSearchParams {
  return {
    organizationId: ORG,
    query: "acme",
    mode: SearchMode.Fulltext,
    types: [],
    since: null,
    until: null,
    limit: 25,
    cursor: null,
    filters: {},
    ...over,
  };
}

export function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    entity_type: SearchEntityType.Document,
    entity_id: "aaaaaaaa-0000-0000-0000-000000000001",
    title: "Acme",
    snippet: "<b>Acme</b>",
    rank: 0.5,
    updated_at: new Date("2026-01-01"),
    slug: null,
    entity_subtype: null,
    team_id: null,
    anchor_entity_id: null,
    ...over,
  };
}
