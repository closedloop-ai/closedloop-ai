import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  PRIORITY_BEARING_ENTITY_TYPES,
  SearchEntityType,
  STATUS_TRIGGER_OWNED_ENTITY_TYPES,
} from "@repo/api/src/types/search-entity-kind";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

const waitUntilMock = vi.hoisted(() => vi.fn());

vi.mock("@vercel/functions", () => ({
  waitUntil: waitUntilMock,
}));

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  // Prisma.sql/empty are only used to build raw fragments; a passthrough tag is
  // enough for these behavior tests (no real SQL is executed).
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    // `join` builds a separator-joined fragment. The separator is recorded with
    // real `Prisma.join`'s default so a flattened statement reads as the SQL
    // Postgres would receive (no real SQL is executed).
    join: (parts: unknown[], separator = ",") => ({ join: parts, separator }),
  },
}));

import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import { ProjectStatus } from "@repo/api/src/types/project";
import { withDb } from "@repo/database";
import {
  agentComponentProjection,
  agentSessionProjection,
  branchProjection,
  commentProjection,
  documentProjection,
  projectProjection,
  pullRequestProjection,
  searchIndexService,
} from "./search-index-service";

const mockWithDb = withDb as unknown as Mock;

/**
 * Await the promise the service handed to `waitUntil` so a test can assert the
 * background upsert/remove settled (success or logged failure) deterministically
 * — no timers, no sleeps.
 */
async function drainWaitUntil() {
  for (const call of waitUntilMock.mock.calls) {
    await call[0];
  }
}

describe("searchIndexService mappers", () => {
  it("maps a Document to a projection row carrying content body + slug + subtype", () => {
    const row = documentProjection({
      id: "doc-1",
      organizationId: "org-1",
      title: "My PRD",
      slug: "my-prd",
      entitySubtype: "PRD",
      body: "the full PRD content",
      projectId: "proj-1",
      assigneeId: "user-1",
      status: "IN_REVIEW",
      priority: "HIGH",
      updatedAt: new Date("2026-01-01"),
    });
    expect(row).toEqual({
      organizationId: "org-1",
      entityType: SearchEntityType.Document,
      entityId: "doc-1",
      title: "My PRD",
      body: "the full PRD content",
      projectId: "proj-1",
      assigneeId: "user-1",
      status: "IN_REVIEW",
      priority: "HIGH",
      updatedAt: new Date("2026-01-01"),
      slug: "my-prd",
      entitySubtype: "PRD",
      // Documents route by type+slug, not by team.
      teamId: null,
      anchorEntityId: null,
    });
  });

  it("maps a Project carrying its slug + owning team; own id is the visibility key", () => {
    const row = projectProjection({
      id: "proj-1",
      organizationId: "org-1",
      name: "Acme",
      slug: "acme",
      teamId: "team-1",
      description: "the acme project",
      assigneeId: null,
      status: "IN_PROGRESS",
      priority: "MEDIUM",
      updatedAt: new Date("2026-01-02"),
    });
    expect(row.entityType).toBe(SearchEntityType.Project);
    expect(row.entityId).toBe("proj-1");
    expect(row.projectId).toBe("proj-1");
    expect(row.title).toBe("Acme");
    expect(row.body).toBe("the acme project");
    expect(row.slug).toBe("acme");
    expect(row.teamId).toBe("team-1");
    // The project's status/priority ride into the projection for `:status`/`:priority`.
    expect(row.status).toBe("IN_PROGRESS");
    expect(row.priority).toBe("MEDIUM");
    // Projects have no document subtype.
    expect(row.entitySubtype).toBeNull();
  });

  it.each([
    {
      build: () =>
        commentProjection({
          anchorEntityId: "session-artifact-1",
          anchorEntityType: ArtifactType.Session,
          authorId: "author-3",
          body: "this needs a fix",
          id: "comment-1",
          organizationId: "org-1",
          title: "Comment",
          updatedAt: new Date("2026-01-05"),
        }),
      expectedType: SearchEntityType.Comment,
      name: "Comment",
    },
    {
      build: () =>
        pullRequestProjection({
          body: "the PR description",
          branchArtifactId: "branch-artifact-9",
          id: "pr-1",
          organizationId: "org-1",
          title: "Fix the thing",
          updatedAt: new Date("2026-01-06"),
        }),
      expectedType: SearchEntityType.PullRequest,
      name: "PullRequest",
    },
    {
      build: () =>
        agentComponentProjection({
          componentKey: "design-review",
          componentKind: "skill",
          description: "runs a design review pass",
          externalComponentId: "ext-1",
          id: "ac-1",
          name: "Design Review",
          organizationId: "org-1",
          updatedAt: new Date("2026-01-08"),
        }),
      expectedType: SearchEntityType.AgentComponent,
      name: "AgentComponent",
    },
  ])("$name projection hardcodes priority null", ({ build, expectedType }) => {
    const row = build();

    expect(row.entityType).toBe(expectedType);
    expect(row.priority).toBeNull();
  });

  // ISS-10332 / PLN-2086 Milestone 2: sessions and branches are priority-bearing
  // now, so their projections carry the artifact's value through exactly as the
  // document and project projections do — a member, or `null` for "holds none".
  it.each([
    {
      build: (priority: string | null) =>
        agentSessionProjection({
          artifactId: "session-artifact-1",
          body: "session transcript",
          organizationId: "org-1",
          priority,
          title: "Session one",
          updatedAt: new Date("2026-01-04"),
          userId: "user-9",
        }),
      expectedType: SearchEntityType.AgentSession,
      name: "AgentSession",
    },
    {
      build: (priority: string | null) =>
        branchProjection({
          artifactId: "branch-artifact-3",
          body: "acme/repo main",
          organizationId: "org-1",
          priority,
          title: "feature/search",
          updatedAt: new Date("2026-01-07"),
        }),
      expectedType: SearchEntityType.Branch,
      name: "Branch",
    },
  ])(
    "$name projection carries the artifact priority through (ISS-10332)",
    ({ build, expectedType }) => {
      const prioritized = build("HIGH");
      expect(prioritized.entityType).toBe(expectedType);
      expect(prioritized.priority).toBe("HIGH");

      expect(build(null).priority).toBeNull();
      // Both kinds are in the set `:priority=NONE` scopes to, so the null
      // above is a real "unset" the filter can find rather than "not applicable".
      expect(PRIORITY_BEARING_ENTITY_TYPES).toContain(expectedType);
    }
  );

  it("maps a Comment: body=plain text, anchor id + anchor artifact type route it (FEA-3930)", () => {
    const row = commentProjection({
      id: "comment-1",
      organizationId: "org-1",
      title: "Comment",
      body: "this needs a fix",
      anchorEntityId: "session-artifact-1",
      anchorEntityType: ArtifactType.Session,
      authorId: "author-3",
      updatedAt: new Date("2026-01-04"),
    });
    expect(row.entityType).toBe(SearchEntityType.Comment);
    expect(row.entityId).toBe("comment-1");
    expect(row.body).toBe("this needs a fix");
    // Visibility follows the comment author; a comment is not project-scoped.
    expect(row.assigneeId).toBe("author-3");
    expect(row.projectId).toBeNull();
    // Anchor artifact TYPE rides in entitySubtype; anchor id in anchorEntityId.
    expect(row.entitySubtype).toBe(ArtifactType.Session);
    expect(row.anchorEntityId).toBe("session-artifact-1");
  });

  it("maps a PullRequest: routes to its owning branch via anchorEntityId (FEA-3930)", () => {
    const row = pullRequestProjection({
      id: "pr-1",
      organizationId: "org-1",
      title: "Fix the thing",
      body: "the PR description",
      branchArtifactId: "branch-artifact-9",
      updatedAt: new Date("2026-01-05"),
    });
    expect(row.entityType).toBe(SearchEntityType.PullRequest);
    expect(row.entityId).toBe("pr-1");
    expect(row.title).toBe("Fix the thing");
    expect(row.body).toBe("the PR description");
    expect(row.anchorEntityId).toBe("branch-artifact-9");
    expect(row.entitySubtype).toBeNull();
  });

  it("maps a PullRequest with a null title to an empty title (FEA-3930)", () => {
    const row = pullRequestProjection({
      id: "pr-2",
      organizationId: "org-1",
      title: null,
      body: null,
      branchArtifactId: "branch-artifact-9",
      updatedAt: new Date("2026-01-05"),
    });
    expect(row.title).toBe("");
  });

  it("maps a Branch: keyed on its artifact id, routes by id, no anchor (FEA-3930)", () => {
    const row = branchProjection({
      artifactId: "branch-artifact-3",
      organizationId: "org-1",
      title: "feature/search",
      body: "acme/repo main",
      priority: null,
      updatedAt: new Date("2026-01-06"),
    });
    expect(row.entityType).toBe(SearchEntityType.Branch);
    expect(row.entityId).toBe("branch-artifact-3");
    expect(row.title).toBe("feature/search");
    expect(row.body).toBe("acme/repo main");
    expect(row.anchorEntityId).toBeNull();
    expect(row.entitySubtype).toBeNull();
  });

  it("maps an AgentComponent: title=name, slug via codec, subtype=kind, body=description (FEA-4011)", () => {
    const row = agentComponentProjection({
      id: "ac-1",
      organizationId: "org-1",
      componentKind: "skill",
      name: "Design Review",
      componentKey: "design-review",
      externalComponentId: "ext-1",
      description: "runs a design review pass",
      updatedAt: new Date("2026-01-07"),
    });
    expect(row).toEqual({
      organizationId: "org-1",
      entityType: SearchEntityType.AgentComponent,
      entityId: "ac-1",
      title: "Design Review",
      body: "runs a design review pass",
      projectId: null,
      assigneeId: null,
      status: null,
      priority: null,
      updatedAt: new Date("2026-01-07"),
      // slug is the org-identity handle from the shared SSOT codec.
      slug: encodeComponentSlug("skill", "design-review", "Design Review"),
      entitySubtype: "skill",
      teamId: null,
      anchorEntityId: null,
    });
  });

  it("falls back title name → componentKey → externalComponentId for an AgentComponent (FEA-4011)", () => {
    const byKey = agentComponentProjection({
      id: "ac-2",
      organizationId: "org-1",
      componentKind: "command",
      name: null,
      componentKey: "my-command",
      externalComponentId: "ext-2",
      description: null,
      updatedAt: new Date("2026-01-08"),
    });
    expect(byKey.title).toBe("my-command");

    const byExt = agentComponentProjection({
      id: "ac-3",
      organizationId: "org-1",
      componentKind: "tool",
      name: null,
      componentKey: null,
      externalComponentId: "ext-3",
      description: null,
      updatedAt: new Date("2026-01-08"),
    });
    expect(byExt.title).toBe("ext-3");
    // An identity-less component (no key, no name) has NO routable slug — an
    // empty `${kind}::` handle cannot resolve to a detail row (FEA-4011 review).
    expect(byExt.slug).toBeNull();
  });

  it("stores a null slug for an AgentComponent with an empty normalized identity (FEA-4011)", () => {
    const noIdentity = agentComponentProjection({
      id: "ac-empty",
      organizationId: "org-1",
      componentKind: "tool",
      // Both key and name blank → normalized identity is "".
      name: "   ",
      componentKey: null,
      externalComponentId: "ext-empty",
      description: null,
      updatedAt: new Date("2026-01-08"),
    });
    expect(noIdentity.slug).toBeNull();
    // Title still falls back to the external id so the row stays searchable.
    expect(noIdentity.title).toBe("   ");
  });
});

describe("searchIndexService batch write paths (pool-safe, FEA-4011)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upsertMany issues ONE multi-row INSERT for the whole batch", async () => {
    const executeRaw = vi.fn().mockResolvedValue(2);
    mockWithDb.mockImplementation((cb: (db: unknown) => unknown) =>
      cb({ $executeRaw: executeRaw })
    );

    await searchIndexService.upsertMany([
      agentComponentProjection({
        id: "ac-1",
        organizationId: "org-1",
        componentKind: "skill",
        name: "One",
        componentKey: "one",
        externalComponentId: "ext-1",
        description: null,
        updatedAt: new Date("2026-01-08"),
      }),
      agentComponentProjection({
        id: "ac-2",
        organizationId: "org-1",
        componentKind: "skill",
        name: "Two",
        componentKey: "two",
        externalComponentId: "ext-2",
        description: null,
        updatedAt: new Date("2026-01-08"),
      }),
    ]);

    // One connection, one statement — not one per row (FEA-3299).
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(readRawStatement(executeRaw.mock.calls[0])).toEqual({
      sql: searchDocumentUpsertSql([
        SEARCH_DOCUMENT_VALUES_ROW,
        SEARCH_DOCUMENT_VALUES_ROW,
      ]),
      values: [
        "org-1",
        SearchEntityType.AgentComponent,
        "ac-1",
        "One",
        null,
        null,
        null,
        new Date("2026-01-08"),
        encodeComponentSlug("skill", "one", "One"),
        "skill",
        "org-1",
        SearchEntityType.AgentComponent,
        "ac-2",
        "Two",
        null,
        null,
        null,
        new Date("2026-01-08"),
        encodeComponentSlug("skill", "two", "Two"),
        "skill",
        ...STATUS_TRIGGER_OWNED_ENTITY_TYPES,
      ],
    });
  });

  it("upsertMany is a no-op for an empty batch (no DB call)", async () => {
    const executeRaw = vi.fn();
    mockWithDb.mockImplementation((cb: (db: unknown) => unknown) =>
      cb({ $executeRaw: executeRaw })
    );

    await searchIndexService.upsertMany([]);

    expect(mockWithDb).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("removeMany emits one org-scoped DELETE per (org, entityType) group, and never names one org's ids under another org's scope", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    mockWithDb.mockImplementation((cb: (db: unknown) => unknown) =>
      cb({ $executeRaw: executeRaw })
    );

    await searchIndexService.removeMany([
      {
        organizationId: "org-1",
        entityType: SearchEntityType.AgentComponent,
        entityId: "ac-1",
      },
      {
        organizationId: "org-1",
        entityType: SearchEntityType.AgentComponent,
        entityId: "ac-2",
      },
      // The discriminating row: a DIFFERENT org's key in the same batch. Its id
      // must never appear in org-1's statement, and it must carry its own org
      // in its own WHERE.
      {
        organizationId: "org-2",
        entityType: SearchEntityType.AgentComponent,
        entityId: "ac-3",
      },
      // A second entity type under org-1 — pins that the grouping key is
      // (org, entityType), not org alone.
      {
        organizationId: "org-1",
        entityType: SearchEntityType.Document,
        entityId: "doc-1",
      },
    ]);

    expect(executeRaw.mock.calls.map(readRawStatement)).toEqual([
      {
        sql: `DELETE FROM "search_document" WHERE "organization_id" = ?::uuid AND "entity_type" = ? AND "entity_id" IN (?::uuid,?::uuid)`,
        values: ["org-1", SearchEntityType.AgentComponent, "ac-1", "ac-2"],
      },
      {
        sql: `DELETE FROM "search_document" WHERE "organization_id" = ?::uuid AND "entity_type" = ? AND "entity_id" IN (?::uuid)`,
        values: ["org-2", SearchEntityType.AgentComponent, "ac-3"],
      },
      {
        sql: `DELETE FROM "search_document" WHERE "organization_id" = ?::uuid AND "entity_type" = ? AND "entity_id" IN (?::uuid)`,
        values: ["org-1", SearchEntityType.Document, "doc-1"],
      },
    ]);
    // FEA-3299 pool safety: one pooled connection for the whole batch, not one
    // per group — `withDb` must stay OUTSIDE the per-group loop.
    expect(mockWithDb).toHaveBeenCalledTimes(1);
  });

  it("removeMany is a no-op for an empty batch (no DB call)", async () => {
    const executeRaw = vi.fn();
    mockWithDb.mockImplementation((cb: (db: unknown) => unknown) =>
      cb({ $executeRaw: executeRaw })
    );

    await searchIndexService.removeMany([]);

    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("indexManyAfterCommit / removeManyAfterCommit are no-ops for an empty batch (no waitUntil)", () => {
    searchIndexService.indexManyAfterCommit([]);
    searchIndexService.removeManyAfterCommit([]);
    expect(waitUntilMock).not.toHaveBeenCalled();
  });
});

/**
 * ISS-10332: the single session and branch priority writers re-project one
 * row's priority in place. Asserted on the reconstructed statement for the
 * reason the sibling write paths above are — the org scope lives in the SQL
 * text, and a decode of the bound values alone is green when `AND` becomes
 * `OR` (ISS-6746).
 */
describe("searchIndexService.updatePriority (ISS-10332)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const KEY = {
    organizationId: "org-1",
    entityType: SearchEntityType.AgentSession,
    entityId: "ses-1",
  };

  it("issues one UPDATE scoped by organization, entity type and entity id", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    mockWithDb.mockImplementation((cb: (db: unknown) => unknown) =>
      cb({ $executeRaw: executeRaw })
    );

    await searchIndexService.updatePriority(KEY, "HIGH");

    expect(executeRaw.mock.calls.map(readRawStatement)).toEqual([
      {
        sql: `UPDATE "search_document" SET "priority" = ? WHERE "organization_id" = ?::uuid AND "entity_type" = ? AND "entity_id" = ?::uuid`,
        values: ["HIGH", "org-1", SearchEntityType.AgentSession, "ses-1"],
      },
    ]);
  });

  it("binds a cleared priority as null rather than dropping the SET", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    mockWithDb.mockImplementation((cb: (db: unknown) => unknown) =>
      cb({ $executeRaw: executeRaw })
    );

    await searchIndexService.updatePriority(KEY, null);

    expect(readRawStatement(executeRaw.mock.calls[0]).values).toEqual([
      null,
      "org-1",
      SearchEntityType.AgentSession,
      "ses-1",
    ]);
  });

  // Pins the fail-open wiring only: `withDb` rejects here, so no statement is
  // ever built and there is nothing to reconstruct. The two cases above own the
  // SQL text.
  it("updatePriorityAfterCommit defers to waitUntil and swallows a failed re-projection", async () => {
    mockWithDb.mockRejectedValue(new Error("update failed"));

    expect(() =>
      searchIndexService.updatePriorityAfterCommit(KEY, "LOW")
    ).not.toThrow();
    expect(waitUntilMock).toHaveBeenCalledTimes(1);
    await expect(drainWaitUntil()).resolves.toBeUndefined();
    expect(mockWithDb).toHaveBeenCalledTimes(1);
  });
});

describe("searchIndexService.updateAssignee (ISS-12251)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const SCOPE = {
    organizationId: "org-1",
    entityType: SearchEntityType.AgentSession,
  };

  function captureStatements() {
    const executeRaw = vi.fn().mockResolvedValue(1);
    mockWithDb.mockImplementation((cb: (db: unknown) => unknown) =>
      cb({ $executeRaw: executeRaw })
    );
    return executeRaw;
  }

  it("updateAssigneeMany issues ONE UPDATE over the set, scoped by organization and entity type", async () => {
    const executeRaw = captureStatements();

    await searchIndexService.updateAssigneeMany(
      SCOPE,
      ["ses-1", "ses-2"],
      "user-9"
    );

    expect(executeRaw.mock.calls.map(readRawStatement)).toEqual([
      {
        sql: `UPDATE "search_document" SET "assignee_id" = ?::uuid WHERE "organization_id" = ?::uuid AND "entity_type" = ? AND "entity_id" IN (?::uuid,?::uuid)`,
        values: [
          "user-9",
          "org-1",
          SearchEntityType.AgentSession,
          "ses-1",
          "ses-2",
        ],
      },
    ]);
    expect(mockWithDb).toHaveBeenCalledTimes(1);
  });

  it("updateAssignee re-projects the key's one row and binds a cleared assignee as null", async () => {
    const executeRaw = captureStatements();

    await searchIndexService.updateAssignee(
      { ...SCOPE, entityId: "ses-1" },
      null
    );

    expect(executeRaw.mock.calls.map(readRawStatement)).toEqual([
      {
        sql: `UPDATE "search_document" SET "assignee_id" = ?::uuid WHERE "organization_id" = ?::uuid AND "entity_type" = ? AND "entity_id" IN (?::uuid)`,
        values: [null, "org-1", SearchEntityType.AgentSession, "ses-1"],
      },
    ]);
  });

  it("an empty set touches neither the database nor waitUntil", async () => {
    await searchIndexService.updateAssigneeMany(SCOPE, [], "user-9");
    searchIndexService.updateAssigneeManyAfterCommit(SCOPE, [], "user-9");

    expect(mockWithDb).not.toHaveBeenCalled();
    expect(waitUntilMock).not.toHaveBeenCalled();
  });

  it("both AfterCommit variants defer to waitUntil and swallow a failed re-projection", async () => {
    mockWithDb.mockRejectedValue(new Error("update failed"));

    expect(() => {
      searchIndexService.updateAssigneeAfterCommit(
        { ...SCOPE, entityId: "ses-1" },
        "user-9"
      );
      searchIndexService.updateAssigneeManyAfterCommit(
        SCOPE,
        ["ses-1"],
        "user-9"
      );
    }).not.toThrow();
    expect(waitUntilMock).toHaveBeenCalledTimes(2);
    await expect(drainWaitUntil()).resolves.toBeUndefined();
    expect(mockWithDb).toHaveBeenCalledTimes(2);
  });
});

describe("searchIndexService.indexAfterCommit (fail-open, non-blocking)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("schedules the projection upsert via waitUntil and executes it", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    mockWithDb.mockImplementation((cb: (db: unknown) => unknown) =>
      cb({ $executeRaw: executeRaw })
    );

    searchIndexService.indexAfterCommit(
      documentProjection({
        id: "doc-1",
        organizationId: "org-1",
        title: "Findable Doc",
        slug: "findable-doc",
        entitySubtype: "PRD",
        body: "searchable content",
        projectId: null,
        assigneeId: null,
        status: "DRAFT",
        priority: "LOW",
        updatedAt: new Date("2026-01-01"),
      })
    );

    expect(waitUntilMock).toHaveBeenCalledTimes(1);
    await drainWaitUntil();
    // The primary write path never awaited this; the projection ran in the
    // background and reached the DB.
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(readRawStatement(executeRaw.mock.calls[0])).toEqual({
      sql: searchDocumentUpsertSql([DOCUMENT_VALUES_ROW]),
      values: [
        "org-1",
        SearchEntityType.Document,
        "doc-1",
        "Findable Doc",
        "searchable content",
        // The inserted status is the source row's, read in this statement;
        // the captured value is only the fallback (ISS-9938).
        "doc-1",
        "org-1",
        "DRAFT",
        "LOW",
        new Date("2026-01-01"),
        "findable-doc",
        "PRD",
        ...STATUS_TRIGGER_OWNED_ENTITY_TYPES,
      ],
    });
  });

  it("swallows a projection-write failure — never throws to the caller", async () => {
    mockWithDb.mockRejectedValue(new Error("projection db down"));

    // The hook returns void synchronously and must not throw even though the
    // underlying write will reject.
    expect(() =>
      searchIndexService.indexAfterCommit(
        projectProjection({
          id: "proj-1",
          organizationId: "org-1",
          name: "Acme",
          slug: "acme",
          teamId: null,
          description: null,
          assigneeId: null,
          status: ProjectStatus.InProgress,
          priority: null,
          updatedAt: new Date(),
        })
      )
    ).not.toThrow();

    // Draining the scheduled work must also not reject — the error is caught and
    // logged inside the best-effort wrapper (fail-open).
    await expect(drainWaitUntil()).resolves.toBeUndefined();
  });

  it("removeAfterCommit schedules a fail-open delete", async () => {
    mockWithDb.mockRejectedValue(new Error("delete failed"));

    expect(() =>
      searchIndexService.removeAfterCommit({
        organizationId: "org-1",
        entityType: SearchEntityType.Project,
        entityId: "proj-1",
      })
    ).not.toThrow();
    expect(waitUntilMock).toHaveBeenCalledTimes(1);
    await expect(drainWaitUntil()).resolves.toBeUndefined();
  });
});

const WHITESPACE_RUN = /\s+/g;

/** A fragment built by the mocked `Prisma.sql` / `Prisma.join` above. */
type SqlNode =
  | { strings: readonly string[]; values: readonly unknown[] }
  | { join: readonly unknown[]; separator: string }
  | unknown;

/**
 * Reconstruct the statement a `$executeRaw` call would send: the composed SQL
 * with every bound value replaced by `?`, plus the flat parameter list.
 *
 * The whole statement is the assertion target because the org scope lives in
 * the statement's SHAPE, not only in its parameters. A decode that reads the
 * three bound values but not the text between them is green when `AND` becomes
 * `OR` — same values, same group count, and a `DELETE` that reaches every org
 * (ISS-6746). Reading the text also survives a pure refactor: hoisting the
 * predicate into a `Prisma.sql` fragment flattens to the same string.
 *
 * Mirrors `flattenSql` in `search-fts-filters.test.ts`, adapted to this file's
 * own `@repo/database` mock.
 */
function readRawStatement(call: readonly unknown[]): {
  sql: string;
  values: unknown[];
} {
  // `mock.calls` entries are `any[]`, so the tagged-template shape is asserted
  // by `isTemplateFragment` below rather than by a cast: a call that is not one
  // flattens to a bare `?` and fails the assertion instead of passing quietly.
  const [strings, ...values] = call;
  const flat = flattenSql({ strings, values });
  return {
    sql: flat.sql.replace(WHITESPACE_RUN, " ").trim(),
    values: flat.values,
  };
}

function flattenSql(node: SqlNode): { sql: string; values: unknown[] } {
  if (isTemplateFragment(node)) {
    return flattenTemplate(node.strings, node.values);
  }
  if (isJoinFragment(node)) {
    const parts = node.join.map(flattenSql);
    return {
      sql: parts.map((part) => part.sql).join(node.separator),
      values: parts.flatMap((part) => part.values),
    };
  }
  // A leaf bound value — every non-fragment reaches the driver as a parameter.
  return { sql: "?", values: [node] };
}

function flattenTemplate(
  strings: readonly string[],
  values: readonly unknown[]
): { sql: string; values: unknown[] } {
  let sql = "";
  const bound: unknown[] = [];
  strings.forEach((chunk, index) => {
    sql += chunk;
    if (index < values.length) {
      const inner = flattenSql(values[index]);
      sql += inner.sql;
      bound.push(...inner.values);
    }
  });
  return { sql, values: bound };
}

function isTemplateFragment(
  node: SqlNode
): node is { strings: readonly string[]; values: readonly unknown[] } {
  return (
    typeof node === "object" &&
    node !== null &&
    Array.isArray(Reflect.get(node, "strings")) &&
    Array.isArray(Reflect.get(node, "values"))
  );
}

function isJoinFragment(
  node: SqlNode
): node is { join: readonly unknown[]; separator: string } {
  return (
    typeof node === "object" &&
    node !== null &&
    Array.isArray(Reflect.get(node, "join"))
  );
}

/**
 * One projection row as the driver receives it. All four nullable id columns
 * are inlined as literal `NULL`s by `projectionValuesRow`, so they bind nothing.
 */
const SEARCH_DOCUMENT_VALUES_ROW =
  "( gen_random_uuid(), ?::uuid, ?, ?::uuid, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL )";

/**
 * A document row: its `status` is the source artifact's, read inside the
 * statement, with the captured value as the fallback (ISS-9938).
 */
const DOCUMENT_VALUES_ROW =
  '( gen_random_uuid(), ?::uuid, ?, ?::uuid, ?, ?, NULL, NULL, COALESCE((SELECT a."status" FROM "artifacts" AS a WHERE a."id" = ?::uuid AND a."organization_id" = ?::uuid), ?), ?, ?, ?, ?, NULL, NULL )';

/**
 * The whole upsert statement, conflict target spelled out, because that target
 * IS the row identity: drop `"organization_id"` from it and two orgs projecting
 * the same entity id overwrite each other — same bound values, same call count,
 * same group shape, so nothing but the statement text can see it.
 */
function searchDocumentUpsertSql(valuesRows: readonly string[]): string {
  const rows = valuesRows.join(",");
  return `INSERT INTO "search_document" ( "id", "organization_id", "entity_type", "entity_id", "title", "body", "project_id", "assignee_id", "status", "priority", "updated_at", "slug", "entity_subtype", "team_id", "anchor_entity_id" ) VALUES ${rows} ON CONFLICT ("organization_id", "entity_type", "entity_id") DO UPDATE SET "title" = EXCLUDED."title", "body" = EXCLUDED."body", "project_id" = EXCLUDED."project_id", "assignee_id" = EXCLUDED."assignee_id", "status" = CASE WHEN "search_document"."entity_type" IN (${STATUS_TRIGGER_OWNED_ENTITY_TYPES.map(() => "?").join(",")}) THEN "search_document"."status" ELSE EXCLUDED."status" END, "priority" = EXCLUDED."priority", "updated_at" = EXCLUDED."updated_at", "slug" = EXCLUDED."slug", "entity_subtype" = EXCLUDED."entity_subtype", "team_id" = EXCLUDED."team_id", "anchor_entity_id" = EXCLUDED."anchor_entity_id"`;
}
