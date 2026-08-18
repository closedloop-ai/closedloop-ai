/**
 * FEA-3857 (PLN-1456 Slice 1) — DB-free unit tests for the search_document
 * backfill.
 *
 * These drive the exported `runSearchDocumentBackfill` against a faithful
 * in-memory `SearchBackfillClient` fake (NO database) and prove the contracts
 * the Slice-1 acceptance criteria call out:
 *
 *  1. ROW SHAPE: each Document/Feature Artifact, Project, and Loop projects
 *     exactly one row with the correct `entityType`, `title`, `body`, and
 *     visibility keys.
 *  2. IDEMPOTENT: a second run over the already-populated projection produces no
 *     new rows (upsert on the unique key), only in-place updates.
 *  3. TWO-ORG ISOLATION: a row's `organizationId` is copied straight from its
 *     source, and the unique key is org-scoped, so byte-identical entities in
 *     two orgs yield two distinct rows and neither displaces the other.
 *  4. PAGINATION-UNTIL-EXHAUSTED: a corpus larger than the page size is fully
 *     projected (no capped first page).
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { describe, expect, it } from "vitest";
import { runSearchDocumentBackfill } from "./backfill-search-documents";
import {
  AT,
  artifact,
  branch,
  comment,
  loop,
  makeFakeClient,
  ORG_A,
  ORG_B,
  project,
  pullRequest,
} from "./backfill-search-documents.fixtures";

describe("runSearchDocumentBackfill", () => {
  it("projects one correctly-shaped row per Document, Project, and Loop", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [
        artifact({
          id: "a1",
          name: "PRD One",
          projectId: "p1",
          assigneeId: "u9",
        }),
      ],
      projects: [
        project({ id: "p1", name: "Alpha", description: "the alpha project" }),
      ],
      loops: [loop({ id: "l1", command: "execute", prompt: "do the thing" })],
    });

    const counts = await runSearchDocumentBackfill(client, { pageSize: 500 });

    expect(counts).toEqual({
      documents: 1,
      projects: 1,
      loops: 1,
      comments: 0,
      pullRequests: 0,
      branches: 0,
      agentComponents: 0,
      staleAgentComponentsRemoved: 0,
      total: 3,
    });

    const doc = store.get(`${ORG_A}|${SearchEntityType.Document}|a1`);
    expect(doc).toMatchObject({
      entityType: SearchEntityType.Document,
      entityId: "a1",
      title: "PRD One",
      body: null,
      projectId: "p1",
      assigneeId: "u9",
      updatedAt: AT,
    });

    const proj = store.get(`${ORG_A}|${SearchEntityType.Project}|p1`);
    expect(proj).toMatchObject({
      entityType: SearchEntityType.Project,
      entityId: "p1",
      title: "Alpha",
      body: "the alpha project",
      // A project is its own visibility scope.
      projectId: "p1",
    });

    const lp = store.get(`${ORG_A}|${SearchEntityType.Loop}|l1`);
    expect(lp).toMatchObject({
      entityType: SearchEntityType.Loop,
      entityId: "l1",
      title: "execute",
      body: "do the thing",
      projectId: null,
      assigneeId: "user-1",
    });
  });

  it("projects Phase-2 route fields and the document's latest-version content body", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [
        artifact({
          id: "a1",
          name: "PRD One",
          slug: "prd-one",
          subtype: "PRD",
          content: "the full body of the PRD document",
        }),
      ],
      projects: [
        project({ id: "p1", name: "Alpha", slug: "alpha", teamIds: ["t1"] }),
      ],
      loops: [loop({ id: "l1", command: "execute", prompt: "do the thing" })],
    });

    await runSearchDocumentBackfill(client);

    // Document: slug + subtype carried, body is the latest version content
    // (Phase-2: no longer title-only), no team.
    const doc = store.get(`${ORG_A}|${SearchEntityType.Document}|a1`);
    expect(doc).toMatchObject({
      slug: "prd-one",
      entitySubtype: "PRD",
      body: "the full body of the PRD document",
      teamId: null,
    });

    // Project: slug + owning team carried, no subtype.
    const proj = store.get(`${ORG_A}|${SearchEntityType.Project}|p1`);
    expect(proj).toMatchObject({
      slug: "alpha",
      teamId: "t1",
      entitySubtype: null,
    });

    // Loop: routes by id — no slug/subtype/team.
    const lp = store.get(`${ORG_A}|${SearchEntityType.Loop}|l1`);
    expect(lp).toMatchObject({
      slug: null,
      entitySubtype: null,
      teamId: null,
    });
  });

  it("projects status/priority for documents and projects, status-only for loops (FEA-3930)", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [
        artifact({
          id: "a1",
          subtype: "FEATURE",
          status: "TODO",
          priority: "HIGH",
        }),
      ],
      projects: [
        project({ id: "p1", status: "IN_PROGRESS", priority: "MEDIUM" }),
      ],
      // A loop carries a status but no priority.
      loops: [loop({ id: "l1", status: "RUNNING" })],
    });

    await runSearchDocumentBackfill(client);

    expect(store.get(`${ORG_A}|${SearchEntityType.Document}|a1`)).toMatchObject(
      {
        status: "TODO",
        priority: "HIGH",
      }
    );
    expect(store.get(`${ORG_A}|${SearchEntityType.Project}|p1`)).toMatchObject({
      status: "IN_PROGRESS",
      priority: "MEDIUM",
    });
    expect(store.get(`${ORG_A}|${SearchEntityType.Loop}|l1`)).toMatchObject({
      status: "RUNNING",
      priority: null,
    });
  });

  it("leaves status/priority null for comment/pull-request/branch rows (FEA-3930)", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      comments: [comment({ id: "c1", plainText: "hi" })],
      pullRequests: [pullRequest({ id: "pr1", title: "PR" })],
      branches: [
        branch({
          artifactId: "b1",
          branchName: "feat",
          repositoryFullName: "o/r",
        }),
      ],
    });

    await runSearchDocumentBackfill(client);

    expect(store.get(`${ORG_A}|${SearchEntityType.Comment}|c1`)).toMatchObject({
      status: null,
      priority: null,
    });
    expect(
      store.get(`${ORG_A}|${SearchEntityType.PullRequest}|pr1`)
    ).toMatchObject({ status: null, priority: null });
    expect(store.get(`${ORG_A}|${SearchEntityType.Branch}|b1`)).toMatchObject({
      status: null,
      priority: null,
    });
  });

  it("leaves a document body null when it has no versions and a project team null when unteamed", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [artifact({ id: "a1", slug: "d", subtype: "FEATURE" })],
      projects: [project({ id: "p1", slug: "p", teamIds: [] })],
      loops: [],
    });

    await runSearchDocumentBackfill(client);

    expect(
      store.get(`${ORG_A}|${SearchEntityType.Document}|a1`)?.body
    ).toBeNull();
    expect(
      store.get(`${ORG_A}|${SearchEntityType.Project}|p1`)?.teamId
    ).toBeNull();
  });

  it("only projects DOCUMENT-typed artifacts (documents/features), not branches or sessions", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [
        artifact({ id: "a1", type: "DOCUMENT", name: "Feature X" }),
        artifact({ id: "a2", type: "BRANCH", name: "some-branch" }),
        artifact({ id: "a3", type: "SESSION", name: "a session" }),
      ],
      projects: [],
      loops: [],
    });

    const counts = await runSearchDocumentBackfill(client);

    expect(counts.documents).toBe(1);
    expect(store.has(`${ORG_A}|${SearchEntityType.Document}|a1`)).toBe(true);
    expect(store.has(`${ORG_A}|${SearchEntityType.Document}|a2`)).toBe(false);
    expect(store.has(`${ORG_A}|${SearchEntityType.Document}|a3`)).toBe(false);
  });

  it("bounds an oversized body and stores blank bodies as null (metadata-first)", async () => {
    const hugePrompt = "x".repeat(5000);
    const { client, store } = makeFakeClient({
      artifacts: [],
      projects: [
        project({ id: "p1", name: "P", description: "   " }),
        project({ id: "p2", name: "Q", description: hugePrompt }),
      ],
      loops: [loop({ id: "l1", command: "chat", prompt: hugePrompt })],
    });

    await runSearchDocumentBackfill(client);

    // Blank description → null, not an empty string.
    expect(
      store.get(`${ORG_A}|${SearchEntityType.Project}|p1`)?.body
    ).toBeNull();
    // Oversized bodies are capped at the metadata-first ceiling (< raw length).
    const projBody = store.get(`${ORG_A}|${SearchEntityType.Project}|p2`)?.body;
    expect(projBody).not.toBeNull();
    expect((projBody as string).length).toBeLessThan(hugePrompt.length);
    const loopBody = store.get(`${ORG_A}|${SearchEntityType.Loop}|l1`)?.body;
    expect((loopBody as string).length).toBeLessThan(hugePrompt.length);
  });

  it("is idempotent: a second run adds no rows and re-upserts the same keys", async () => {
    const fake = makeFakeClient({
      artifacts: [artifact({ id: "a1", name: "Doc" })],
      projects: [project({ id: "p1" })],
      loops: [loop({ id: "l1" })],
    });

    await runSearchDocumentBackfill(fake.client);
    const sizeAfterFirst = fake.store.size;
    const snapshot = new Map(fake.store);

    await runSearchDocumentBackfill(fake.client);

    expect(fake.store.size).toBe(sizeAfterFirst);
    // Same keys, same shape — a re-run is a no-op on the projection contents.
    expect([...fake.store.keys()].sort()).toEqual([...snapshot.keys()].sort());
    for (const [key, row] of fake.store) {
      expect(row).toEqual(snapshot.get(key));
    }
  });

  it("keeps two orgs isolated even with byte-identical entities", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [
        artifact({ id: "shared-doc", organizationId: ORG_A, name: "Same" }),
        artifact({ id: "shared-doc", organizationId: ORG_B, name: "Same" }),
      ],
      projects: [],
      loops: [],
    });

    await runSearchDocumentBackfill(client);

    // Same entityId + entityType, different org → two distinct rows; neither
    // displaced the other.
    expect(store.has(`${ORG_A}|${SearchEntityType.Document}|shared-doc`)).toBe(
      true
    );
    expect(store.has(`${ORG_B}|${SearchEntityType.Document}|shared-doc`)).toBe(
      true
    );
    expect(store.size).toBe(2);
  });

  it("derives a loop's project visibility from its target artifact", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [
        // Loop attached to an artifact that lives in project p1.
        loop({ id: "l1", command: "execute", artifact: { projectId: "p1" } }),
        // Loop whose artifact has no project (cloud/legacy) → null visibility.
        loop({ id: "l2", command: "plan", artifact: { projectId: null } }),
        // Loop with no artifact at all → null visibility.
        loop({ id: "l3", command: "chat", artifact: null }),
      ],
    });

    await runSearchDocumentBackfill(client);

    expect(store.get(`${ORG_A}|${SearchEntityType.Loop}|l1`)?.projectId).toBe(
      "p1"
    );
    expect(
      store.get(`${ORG_A}|${SearchEntityType.Loop}|l2`)?.projectId
    ).toBeNull();
    expect(
      store.get(`${ORG_A}|${SearchEntityType.Loop}|l3`)?.projectId
    ).toBeNull();
  });

  it("paginates until exhausted (no capped first page)", async () => {
    const artifacts = Array.from({ length: 7 }, (_, i) =>
      artifact({ id: `a${i}`, name: `Doc ${i}` })
    );
    const fake = makeFakeClient({
      artifacts,
      projects: [],
      loops: [],
    });

    // Page size 2 forces multiple pages over 7 rows (2,2,2,1).
    const counts = await runSearchDocumentBackfill(fake.client, {
      pageSize: 2,
    });

    expect(counts.documents).toBe(7);
    expect(fake.store.size).toBe(7);
    // 4 artifact pages (2,2,2,1) each upsert once; the empty project/loop
    // sources upsert nothing — proving every page was flushed, not just the
    // first.
    expect(fake.upsertCalls).toBe(4);
  });
});

describe("runSearchDocumentBackfill — comment/pull_request/branch corpus (FEA-3930)", () => {
  it("projects a comment with its author-scoped visibility, body, and anchored session route data", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      comments: [
        comment({
          id: "c1",
          plainText: "this looks wrong to me",
          authorId: "author-9",
          thread: {
            organizationId: ORG_A,
            artifactId: "session-artifact-1",
            artifactType: ArtifactType.Session,
          },
        }),
      ],
    });

    const counts = await runSearchDocumentBackfill(client);

    expect(counts.comments).toBe(1);
    const row = store.get(`${ORG_A}|${SearchEntityType.Comment}|c1`);
    expect(row).toMatchObject({
      entityType: SearchEntityType.Comment,
      entityId: "c1",
      body: "this looks wrong to me",
      // Visibility follows the comment author.
      assigneeId: "author-9",
      projectId: null,
      // The anchor artifact's TYPE (session) rides in entitySubtype; the anchor
      // artifact id in anchorEntityId — together they build the deep link.
      entitySubtype: ArtifactType.Session,
      anchorEntityId: "session-artifact-1",
    });
  });

  it("carries a branch-anchored comment's anchor type so it routes to the branch", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      comments: [
        comment({
          id: "c2",
          plainText: "branch note",
          thread: {
            organizationId: ORG_A,
            artifactId: "branch-artifact-2",
            artifactType: ArtifactType.Branch,
          },
        }),
      ],
    });

    await runSearchDocumentBackfill(client);

    expect(store.get(`${ORG_A}|${SearchEntityType.Comment}|c2`)).toMatchObject({
      entitySubtype: ArtifactType.Branch,
      anchorEntityId: "branch-artifact-2",
    });
  });

  it("excludes soft-deleted comments from the projection", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      comments: [
        comment({ id: "live", plainText: "keep me" }),
        comment({ id: "gone", plainText: "drop me", deletedAt: AT }),
      ],
    });

    const counts = await runSearchDocumentBackfill(client);

    expect(counts.comments).toBe(1);
    expect(store.has(`${ORG_A}|${SearchEntityType.Comment}|live`)).toBe(true);
    expect(store.has(`${ORG_A}|${SearchEntityType.Comment}|gone`)).toBe(false);
  });

  it("projects a pull request that routes to its owning branch (title + description body)", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      pullRequests: [
        pullRequest({
          id: "pr1",
          title: "Fix the thing",
          body: "This PR fixes the thing by doing X.",
          branchArtifactId: "branch-artifact-7",
        }),
      ],
    });

    const counts = await runSearchDocumentBackfill(client);

    expect(counts.pullRequests).toBe(1);
    expect(
      store.get(`${ORG_A}|${SearchEntityType.PullRequest}|pr1`)
    ).toMatchObject({
      entityType: SearchEntityType.PullRequest,
      entityId: "pr1",
      title: "Fix the thing",
      body: "This PR fixes the thing by doing X.",
      // Routes to the owning branch.
      anchorEntityId: "branch-artifact-7",
      projectId: null,
      entitySubtype: null,
    });
  });

  it("projects a branch keyed on its artifact id with repo/base-branch body", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      branches: [
        branch({
          artifactId: "branch-artifact-3",
          branchName: "feature/search",
          baseBranch: "main",
          repositoryFullName: "acme/widgets",
        }),
      ],
    });

    const counts = await runSearchDocumentBackfill(client);

    expect(counts.branches).toBe(1);
    const row = store.get(
      `${ORG_A}|${SearchEntityType.Branch}|branch-artifact-3`
    );
    expect(row).toMatchObject({
      entityType: SearchEntityType.Branch,
      entityId: "branch-artifact-3",
      title: "feature/search",
      body: "acme/widgets main",
      // Branches route by their own id — no anchor.
      anchorEntityId: null,
    });
  });

  it("excludes soft-deleted branches from the projection", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      branches: [
        branch({ artifactId: "b-live" }),
        branch({ artifactId: "b-gone", deletedAt: AT }),
      ],
    });

    const counts = await runSearchDocumentBackfill(client);

    expect(counts.branches).toBe(1);
    expect(store.has(`${ORG_A}|${SearchEntityType.Branch}|b-live`)).toBe(true);
    expect(store.has(`${ORG_A}|${SearchEntityType.Branch}|b-gone`)).toBe(false);
  });

  it("keeps two orgs isolated for byte-identical comments/PRs/branches", async () => {
    const { client, store } = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      comments: [
        comment({
          id: "shared-c",
          thread: {
            organizationId: ORG_A,
            artifactId: "s1",
            artifactType: ArtifactType.Session,
          },
        }),
        comment({
          id: "shared-c",
          thread: {
            organizationId: ORG_B,
            artifactId: "s1",
            artifactType: ArtifactType.Session,
          },
        }),
      ],
      pullRequests: [
        pullRequest({ id: "shared-pr", organizationId: ORG_A }),
        pullRequest({ id: "shared-pr", organizationId: ORG_B }),
      ],
      branches: [
        branch({ artifactId: "shared-b", organizationId: ORG_A }),
        branch({ artifactId: "shared-b", organizationId: ORG_B }),
      ],
    });

    await runSearchDocumentBackfill(client);

    // Each (entityId, entityType) pair is org-scoped in the unique key, so the
    // two orgs never collide — neither displaces the other.
    for (const org of [ORG_A, ORG_B]) {
      expect(store.has(`${org}|${SearchEntityType.Comment}|shared-c`)).toBe(
        true
      );
      expect(
        store.has(`${org}|${SearchEntityType.PullRequest}|shared-pr`)
      ).toBe(true);
      expect(store.has(`${org}|${SearchEntityType.Branch}|shared-b`)).toBe(
        true
      );
    }
    expect(store.size).toBe(6);
  });

  it("paginates the branch source (keyed on artifactId) until exhausted", async () => {
    const branches = Array.from({ length: 5 }, (_, i) =>
      branch({ artifactId: `b${i}` })
    );
    const fake = makeFakeClient({
      artifacts: [],
      projects: [],
      loops: [],
      branches,
    });

    const counts = await runSearchDocumentBackfill(fake.client, {
      pageSize: 2,
    });

    // All 5 branches projected across pages (2,2,1) — no capped first page.
    expect(counts.branches).toBe(5);
    expect(fake.store.size).toBe(5);
  });
});
