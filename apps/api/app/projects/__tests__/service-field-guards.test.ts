import { ProjectStatus } from "@repo/api/src/types/project";
import { ProjectFieldMutationErrorCode } from "@repo/api/src/types/project-field-mutation";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-11198: `expectedName` and `expectedDescription` on `PUT /projects/{id}`,
 * compared against the `FOR UPDATE` before-image the write already locks.
 */

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  lockedRow: vi.fn(),
  projectUpdate: vi.fn(),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/app/search/search-index-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/app/search/search-index-service")
  >("@/app/search/search-index-service");
  return {
    ...actual,
    searchIndexService: {
      indexAfterCommit: vi.fn(),
      removeAfterCommit: vi.fn(),
    },
  };
});

import { projectsService } from "../service";

const PROJECT_ID = "project-1";
const ORG_ID = "org-1";

beforeEach(() => {
  vi.clearAllMocks();
  // The post-commit search indexer's team lookup, which runs outside the tx.
  mocks.withDb.mockResolvedValue(null);
  mocks.projectUpdate.mockResolvedValue({ id: PROJECT_ID, name: "Artemis" });
  mocks.withDb.tx.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback({
      $queryRaw: mocks.lockedRow,
      project: {
        update: mocks.projectUpdate,
        findFirst: vi.fn().mockResolvedValue(null),
      },
    })
  );
});

function lock(row: { name: string; description: string | null }) {
  mocks.lockedRow.mockResolvedValue([
    { status: ProjectStatus.InProgress, priority: null, ...row },
  ]);
}

describe("projectsService.update field guards", () => {
  it("refuses a stale name before writing", async () => {
    lock({ name: "Gemini", description: null });

    const result = await projectsService.update(PROJECT_ID, ORG_ID, {
      name: "Artemis",
      expectedName: "Apollo",
    });

    expect(mocks.projectUpdate).not.toHaveBeenCalled();
    expect(result.ok ? null : result.error).toEqual({
      status: Status.Conflict,
      code: ProjectFieldMutationErrorCode.StaleName,
      message: "One or more projects changed before the name update",
      details: {
        staleNames: [
          {
            projectId: PROJECT_ID,
            currentName: "Gemini",
            expectedName: "Apollo",
          },
        ],
      },
    });
  });

  it("writes a matching name, scoped to the org, with the guard kept out of the row", async () => {
    lock({ name: "Apollo", description: null });

    const result = await projectsService.update(PROJECT_ID, ORG_ID, {
      name: "Artemis",
      expectedName: "Apollo",
    });

    expect(result.ok).toBe(true);
    expect(mocks.projectUpdate).toHaveBeenCalledWith({
      where: { id: PROJECT_ID, organizationId: ORG_ID },
      data: { name: "Artemis" },
    });
    const [sql, ...values] = mocks.lockedRow.mock.calls[0];
    expect(sql.join("?")).toContain("FOR UPDATE");
    expect(values).toEqual([PROJECT_ID, ORG_ID]);
  });

  it("leaves an unguarded write last-write-wins", async () => {
    lock({ name: "Gemini", description: "Moved on" });

    const result = await projectsService.update(PROJECT_ID, ORG_ID, {
      name: "Artemis",
      description: "Mine",
    });

    expect(result.ok).toBe(true);
    expect(mocks.projectUpdate).toHaveBeenCalledTimes(1);
  });

  it("reads an unset description as the empty one a client renders", async () => {
    lock({ name: "Apollo", description: null });

    const honored = await projectsService.update(PROJECT_ID, ORG_ID, {
      description: "Scope",
      expectedDescription: "",
    });

    expect(honored.ok).toBe(true);
    expect(mocks.projectUpdate).toHaveBeenCalledWith({
      where: { id: PROJECT_ID, organizationId: ORG_ID },
      data: { description: "Scope" },
    });

    lock({ name: "Apollo", description: "Written elsewhere" });
    const refused = await projectsService.update(PROJECT_ID, ORG_ID, {
      description: "Scope",
      expectedDescription: "",
    });

    expect(mocks.projectUpdate).toHaveBeenCalledTimes(1);
    expect(refused.ok ? null : refused.error).toMatchObject({
      status: Status.Conflict,
      code: ProjectFieldMutationErrorCode.StaleDescription,
      details: {
        staleDescriptions: [
          {
            projectId: PROJECT_ID,
            currentDescription: "Written elsewhere",
            expectedDescription: "",
          },
        ],
      },
    });
  });

  it("accepts a retried rename the row already holds", async () => {
    lock({ name: "Artemis", description: null });

    const result = await projectsService.update(PROJECT_ID, ORG_ID, {
      name: "Artemis",
      expectedName: "Apollo",
    });

    expect(result.ok).toBe(true);
  });
});
