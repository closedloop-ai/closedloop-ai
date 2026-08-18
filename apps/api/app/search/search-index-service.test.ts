import { ArtifactType } from "@repo/api/src/types/artifact";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
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
    // `join` builds a comma-separated fragment; a passthrough that records the
    // parts is enough for these behavior tests (no real SQL is executed).
    join: (parts: unknown[]) => ({ join: parts }),
  },
}));

import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import { withDb } from "@repo/database";
import {
  agentComponentProjection,
  branchProjection,
  commentProjection,
  documentProjection,
  loopProjection,
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

  it("maps a Loop: title=command, body=prompt, assignee=initiating user, no route fields", () => {
    const row = loopProjection({
      id: "loop-1",
      organizationId: "org-1",
      command: "plan",
      prompt: "make a plan",
      userId: "user-9",
      status: "RUNNING",
      updatedAt: new Date("2026-01-03"),
    });
    expect(row.entityType).toBe(SearchEntityType.Loop);
    expect(row.title).toBe("plan");
    expect(row.body).toBe("make a plan");
    expect(row.assigneeId).toBe("user-9");
    expect(row.projectId).toBeNull();
    // A loop carries a status but no priority.
    expect(row.status).toBe("RUNNING");
    expect(row.priority).toBeNull();
    // Loops route by id — no slug/subtype/team.
    expect(row.slug).toBeNull();
    expect(row.entitySubtype).toBeNull();
    expect(row.teamId).toBeNull();
    expect(row.anchorEntityId).toBeNull();
  });

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

  it("removeMany deletes per (org, entityType) group so the org scope stays in every WHERE", async () => {
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
      {
        organizationId: "org-2",
        entityType: SearchEntityType.AgentComponent,
        entityId: "ac-3",
      },
    ]);

    // Two orgs → two grouped DELETEs (org-1's two ids collapse into one IN-list).
    expect(executeRaw).toHaveBeenCalledTimes(2);
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
  });

  it("swallows a projection-write failure — never throws to the caller", async () => {
    mockWithDb.mockRejectedValue(new Error("projection db down"));

    // The hook returns void synchronously and must not throw even though the
    // underlying write will reject.
    expect(() =>
      searchIndexService.indexAfterCommit(
        loopProjection({
          id: "loop-1",
          organizationId: "org-1",
          command: "chat",
          prompt: null,
          userId: "user-1",
          status: "PENDING",
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
