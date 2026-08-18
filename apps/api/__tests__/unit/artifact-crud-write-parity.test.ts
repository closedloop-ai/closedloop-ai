/**
 * ISS-6320 (batch 4 of the ISS-6317..6322 narrowing sweep) — parity for the
 * discarded artifact-CRUD writes in `app/documents`, `app/comments`, `app/tags`
 * and `app/projects`.
 *
 * Those writes throw their returned row away, so narrowing what Postgres
 * RETURNs is invisible to every existing assertion in the suite. What is NOT
 * invisible is swapping `update` for `updateMany` to get the same saving:
 * `update` throws `P2025` on a `where` that matches nothing, `updateMany`
 * reports `{ count: 0 }`. Each site below sits behind a caller that reads the
 * loud failure — a returned count that must reconcile with the rows it claims
 * to have written, or a `catch` that turns a Prisma code into a distinct
 * outcome — so the throw is load-bearing and every conversion in this batch is
 * `select`, never a batch form.
 *
 * These tests run against `createFakeDelegate`, which models the row set and
 * reproduces those semantics, so a site rewritten to `updateMany` fails here
 * instead of silently under-writing in production. They are paired with
 * narrowing assertions that pin the RETURNING list to the model's real primary
 * key — `GitHubCommentProjection` is keyed on `commentId` and
 * `GitHubCommentThreadProjection` on `threadId`, not `id`.
 */

import { GitHubCommentThreadKind } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  };
});

const labelReconciliation = vi.hoisted(() => ({
  reconcileLinkedPullRequestLabelsForArtifact: vi.fn(),
  reconcileLinkedPullRequestLabelsForArtifacts: vi.fn(),
}));

vi.mock(
  "@/lib/github/artifact-tag-label-reconciliation",
  () => labelReconciliation
);

import { TagEntityType } from "@repo/api/src/types/tag";
import {
  createFakeDelegate,
  type FakeDelegate,
  PrimaryKeyColumn,
  PrismaWriteErrorCode,
} from "@/__tests__/support/prisma-write-semantics.test-fixtures";
import {
  mockWithDbAll,
  mockWithDbCall,
  mockWithDbTx,
} from "@/__tests__/utils/db-helpers";
import { softDeleteGitHubCommentProjection } from "@/app/comments/github-projection";
import { projectsService } from "@/app/projects/service";
import { tagService } from "@/app/tags/service";

const ORG_ID = "org-1";
const BRANCH_ARTIFACT_ID = "branch-artifact-1";
const PR_DETAIL_ID = "pr-detail-1";
const DELETED_AT = new Date("2026-03-01T00:00:00.000Z");

type SoftDeleteTx = {
  gitHubCommentProjection: FakeDelegate;
  gitHubCommentThreadProjection: FakeDelegate;
  comment: FakeDelegate;
};

/**
 * `softDeleteGitHubCommentProjection` reads its targets with `findMany` and then
 * updates each one by primary key, so the row set here is what the loop walks.
 * `stalePresent: false` removes the projection row the loop will try to update
 * while leaving the `findMany` result intact — the missing-row case, which is
 * the only way to tell `update` and `updateMany` apart.
 */
function makeSoftDeleteTx(options: { stalePresent: boolean }): SoftDeleteTx {
  const projectionRow = {
    commentId: "comment-1",
    threadId: "thread-1",
    githubCommentId: "gh-stale-1",
    githubDeletedAt: null,
  };

  const projection = createFakeDelegate(
    options.stalePresent ? [{ ...projectionRow }] : [],
    [["commentId"]]
  );
  // The read that seeds the loop is scoped by relation filters the fake does not
  // model, so it is stubbed directly; the WRITE path is what this suite covers.
  projection.findMany.mockResolvedValue([
    { commentId: projectionRow.commentId, threadId: projectionRow.threadId },
  ]);

  const threadProjection = createFakeDelegate(
    [{ threadId: "thread-1", deletedAt: null }],
    [["threadId"]]
  );
  threadProjection.findMany.mockResolvedValue([
    { threadId: "thread-1", commentProjections: [] },
  ]);

  const comment = createFakeDelegate(
    options.stalePresent ? [{ id: "comment-1", deletedAt: null }] : [],
    [["id"]]
  );

  return {
    gitHubCommentProjection: projection,
    gitHubCommentThreadProjection: threadProjection,
    comment,
  };
}

function softDeleteInput() {
  return {
    organizationId: ORG_ID,
    branchArtifactId: BRANCH_ARTIFACT_ID,
    pullRequestDetailId: PR_DETAIL_ID,
    threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
    liveGithubCommentIds: new Set<string>(),
    deletedAt: DELETED_AT,
  };
}

describe("ISS-6320 parity: softDeleteGitHubCommentProjection", () => {
  it("soft-deletes the stale projection and its comment, and reports the count", async () => {
    const tx = makeSoftDeleteTx({ stalePresent: true });

    const result = await softDeleteGitHubCommentProjection(
      tx as never,
      softDeleteInput()
    );

    expect(result).toEqual({ comments: 1, threads: 1 });
    expect(tx.gitHubCommentProjection.rows[0]?.githubDeletedAt).toEqual(
      DELETED_AT
    );
    expect(tx.comment.rows[0]?.deletedAt).toEqual(DELETED_AT);
    expect(tx.gitHubCommentThreadProjection.rows[0]?.deletedAt).toEqual(
      DELETED_AT
    );
  });

  it("propagates P2025 rather than reporting a soft-delete that never happened", async () => {
    const tx = makeSoftDeleteTx({ stalePresent: false });

    // The returned `{ comments }` counts the rows the READ found, not the rows
    // the loop wrote. Under `updateMany` this call resolves to
    // `{ comments: 1 }` for a projection nobody touched; the throw is what
    // keeps the count honest.
    await expect(
      softDeleteGitHubCommentProjection(tx as never, softDeleteInput())
    ).rejects.toMatchObject({ code: PrismaWriteErrorCode.NotFound });
  });

  it("returns only each model's primary key from the three discarded writes", async () => {
    const tx = makeSoftDeleteTx({ stalePresent: true });

    await softDeleteGitHubCommentProjection(tx as never, softDeleteInput());

    expect(tx.gitHubCommentProjection.writes).toEqual([
      expect.objectContaining({
        method: "update",
        selected: [PrimaryKeyColumn.GitHubCommentProjection],
      }),
    ]);
    expect(tx.comment.writes).toEqual([
      expect.objectContaining({
        method: "update",
        selected: [PrimaryKeyColumn.Comment],
      }),
    ]);
    expect(tx.gitHubCommentThreadProjection.writes).toEqual([
      expect.objectContaining({
        method: "update",
        selected: [PrimaryKeyColumn.GitHubCommentThreadProjection],
      }),
    ]);
  });
});

describe("ISS-6320 parity: projectsService.clearRepositorySettingsForOrganization", () => {
  function makeProjectDb(options: { rowPresent: boolean }) {
    const settings = { repositoryOverrides: { owner: "acme" }, theme: "dark" };
    const project = createFakeDelegate(
      options.rowPresent ? [{ id: "project-1", settings }] : []
    );
    project.findMany.mockResolvedValue([{ id: "project-1", settings }]);
    return { project };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears the override, reports one cleared project, and returns only its id", async () => {
    const db = makeProjectDb({ rowPresent: true });
    mockWithDbTx(db);

    const cleared =
      await projectsService.clearRepositorySettingsForOrganization(ORG_ID);

    expect(cleared).toBe(1);
    expect(db.project.rows[0]?.settings).toEqual({ theme: "dark" });
    expect(db.project.writes).toEqual([
      expect.objectContaining({
        method: "update",
        selected: [PrimaryKeyColumn.Project],
      }),
    ]);
  });

  it("propagates P2025 rather than counting a project it never cleared", async () => {
    const db = makeProjectDb({ rowPresent: false });
    mockWithDbTx(db);

    // `cleared++` runs unconditionally after the write, so `updateMany` here
    // would resolve to `1` for a project whose `repositoryOverrides` is still
    // in the database.
    await expect(
      projectsService.clearRepositorySettingsForOrganization(ORG_ID)
    ).rejects.toMatchObject({ code: PrismaWriteErrorCode.NotFound });
  });
});

describe("ISS-6320 parity: projectsService.addFavorite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("favorites the project and returns only the favorite's id", async () => {
    const favoriteProject = createFakeDelegate([], [["userId", "projectId"]]);
    // The org-scope guard reads `{ id, organizationId }`, so a row without the
    // org short-circuits to `null` and the upsert under test never runs.
    const project = createFakeDelegate([
      { id: "project-1", organizationId: ORG_ID },
    ]);
    mockWithDbCall({ project, favoriteProject });

    const result = await projectsService.addFavorite(
      "project-1",
      "user-1",
      ORG_ID
    );

    expect(result).toEqual({ favorited: true });
    expect(favoriteProject.rows).toHaveLength(1);
    expect(favoriteProject.writes).toEqual([
      expect.objectContaining({
        method: "upsert",
        selected: [PrimaryKeyColumn.FavoriteProject],
      }),
    ]);
  });

  it("stays idempotent on a second favorite", async () => {
    const favoriteProject = createFakeDelegate(
      [{ id: "fav-1", userId: "user-1", projectId: "project-1" }],
      [["userId", "projectId"]]
    );
    // The org-scope guard reads `{ id, organizationId }`, so a row without the
    // org short-circuits to `null` and the upsert under test never runs.
    const project = createFakeDelegate([
      { id: "project-1", organizationId: ORG_ID },
    ]);
    mockWithDbCall({ project, favoriteProject });

    const result = await projectsService.addFavorite(
      "project-1",
      "user-1",
      ORG_ID
    );

    expect(result).toEqual({ favorited: true });
    expect(favoriteProject.writes).toHaveLength(1);
    expect(favoriteProject.rows).toHaveLength(1);
  });
});

describe("ISS-6320 parity: tagService.applyTag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeTagDb(existing: Record<string, unknown>[]) {
    const tagArtifact = createFakeDelegate(existing, [["tagId", "artifactId"]]);
    return {
      tag: createFakeDelegate([{ id: "tag-1", organizationId: ORG_ID }]),
      artifact: createFakeDelegate([
        { id: "artifact-1", organizationId: ORG_ID },
      ]),
      tagArtifact,
    };
  }

  it("writes the tag link and returns only its id", async () => {
    const db = makeTagDb([]);
    mockWithDbAll(db);

    await tagService.applyTag(
      "tag-1",
      TagEntityType.Artifact,
      "artifact-1",
      ORG_ID
    );

    expect(db.tagArtifact.rows).toHaveLength(1);
    expect(db.tagArtifact.writes).toEqual([
      expect.objectContaining({
        method: "create",
        selected: [PrimaryKeyColumn.TagArtifact],
      }),
    ]);
    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifact
    ).toHaveBeenCalledTimes(1);
  });

  it("still reconciles labels when the tag link already exists (P2002)", async () => {
    const db = makeTagDb([
      { id: "tag-artifact-1", tagId: "tag-1", artifactId: "artifact-1" },
    ]);
    mockWithDbAll(db);

    // The already-tagged branch is reached ONLY through the `create` throwing
    // P2002. `createMany` with `skipDuplicates` would resolve quietly and skip
    // the reconciliation this catch block exists to run.
    await tagService.applyTag(
      "tag-1",
      TagEntityType.Artifact,
      "artifact-1",
      ORG_ID
    );

    expect(db.tagArtifact.rows).toHaveLength(1);
    expect(
      labelReconciliation.reconcileLinkedPullRequestLabelsForArtifact
    ).toHaveBeenCalledTimes(1);
  });
});
