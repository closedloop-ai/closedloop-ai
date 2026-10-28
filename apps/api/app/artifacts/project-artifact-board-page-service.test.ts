import { ArtifactSubtype, ArtifactType } from "@repo/api/src/types/artifact";
import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  ProjectArtifactBoardGroup,
  ProjectArtifactBoardPageError,
  type ProjectArtifactBoardPageQuery,
} from "@repo/api/src/types/project-artifact-board-page";
import { PROJECT_ARTIFACT_LANE_POLICY_VERSION } from "@repo/api/src/types/project-artifact-lane-policy";
import { ProjectArtifactPlacementGroupField } from "@repo/api/src/types/project-artifact-placement";
import { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ArtifactFindArgs = {
  where?: { id?: { in?: string[] } };
};

type RawSql = { sql: string };

const mocks = vi.hoisted(() => ({
  documentDetails: vi.fn(),
  findMany: vi.fn(),
  queryRaw: vi.fn(),
  readPlacementState: vi.fn(),
  resolveLanePolicy: vi.fn(),
  txOptions: vi.fn(),
}));

vi.mock("@repo/database", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/database")>("@repo/database");
  const client = () => ({
    artifact: { findMany: mocks.findMany },
    documentDetail: { findMany: mocks.documentDetails },
    $queryRaw: mocks.queryRaw,
  });
  return {
    ...actual,
    withDb: Object.assign((run: (db: unknown) => unknown) => run(client()), {
      tx: (run: (db: unknown) => unknown, options: unknown) => {
        mocks.txOptions(options);
        return run(client());
      },
    }),
  };
});

vi.mock("@/app/documents/project-artifact-placement-service-support", () => ({
  readPlacementState: mocks.readPlacementState,
}));

vi.mock("./project-artifact-lane-policy", () => ({
  resolveProjectArtifactLanePolicy: mocks.resolveLanePolicy,
}));

import { projectArtifactBoardPageService } from "./project-artifact-board-page-service";
import { BoardStatusEvidence } from "./project-artifact-board-roots";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000002";

let roots = [
  artifact("00000000-0000-4000-8000-000000000011", IssueStatus.Todo, 1),
  artifact("00000000-0000-4000-8000-000000000012", IssueStatus.Todo, 2),
  artifact("00000000-0000-4000-8000-000000000013", IssueStatus.Done, 3),
];

function artifact(id: string, status: IssueStatus, order: number) {
  const timestamp = new Date(Date.UTC(2026, 9, 19, 0, 0, 0, order));
  return {
    assignee: null,
    assigneeId: null,
    createdAt: timestamp,
    createdById: null,
    dueDate: null,
    externalUrl: null,
    id,
    name: id,
    organizationId: ORGANIZATION_ID,
    priority: Priority.Medium,
    projectId: PROJECT_ID,
    slug: `ISS-${order}`,
    sortOrder: order * 1024,
    status,
    subtype: ArtifactSubtype.Feature,
    tagArtifacts: [],
    type: ArtifactType.Document,
    updatedAt: timestamp,
  };
}

function query(
  overrides: Partial<ProjectArtifactBoardPageQuery> = {}
): ProjectArtifactBoardPageQuery {
  return {
    groupBy: ProjectArtifactBoardGroup.Status,
    pageSize: 1,
    ...overrides,
  };
}

const VIEWER_ID = "00000000-0000-4000-8000-000000000099";
const REVISION_DIGEST = "d".repeat(64);

/**
 * The aggregate the database answers for {@link roots}: lanes in first-seen
 * order, counted over the whole population, loaded through the page's end.
 */
function aggregateRows(loadedThrough: number) {
  const lanes = new Map<string, { count: number; loadedCount: number }>();
  for (const [index, root] of roots.entries()) {
    const lane = lanes.get(root.status) ?? { count: 0, loadedCount: 0 };
    lane.count += 1;
    lane.loadedCount += index < loadedThrough ? 1 : 0;
    lanes.set(root.status, lane);
  }
  return [...lanes].map(([laneId, lane]) => ({
    ...lane,
    digest: REVISION_DIGEST,
    laneId,
    total: roots.length,
  }));
}

function rawSqlKind(query: RawSql) {
  if (query.sql.includes("WITH ordered")) {
    return "aggregate";
  }
  if (query.sql.includes("OFFSET")) {
    return "page";
  }
  return "descendants";
}

let pageOffset = 0;

beforeEach(() => {
  roots = [
    artifact("00000000-0000-4000-8000-000000000011", IssueStatus.Todo, 1),
    artifact("00000000-0000-4000-8000-000000000012", IssueStatus.Todo, 2),
    artifact("00000000-0000-4000-8000-000000000013", IssueStatus.Done, 3),
  ];
  pageOffset = 0;
  mocks.findMany.mockReset();
  mocks.findMany.mockImplementation((args: ArtifactFindArgs) => {
    const ids = args.where?.id?.in ?? [];
    return Promise.resolve(roots.filter((root) => ids.includes(root.id)));
  });
  mocks.queryRaw.mockReset();
  mocks.queryRaw.mockImplementation((sql: RawSql) => {
    switch (rawSqlKind(sql)) {
      case "aggregate":
        return Promise.resolve(aggregateRows(pageOffset + 1));
      case "page":
        return Promise.resolve(
          roots.slice(pageOffset, pageOffset + 1).map(({ id }) => ({ id }))
        );
      default:
        return Promise.resolve([]);
    }
  });
  mocks.resolveLanePolicy.mockReset();
  mocks.resolveLanePolicy.mockResolvedValue(null);
  mocks.readPlacementState.mockReset();
  mocks.readPlacementState.mockResolvedValue({
    projectVersions: { [PROJECT_ID]: "placement-v1" },
  });
  mocks.txOptions.mockReset();
  mocks.documentDetails.mockReset();
  mocks.documentDetails.mockResolvedValue([]);
});

function read(overrides: Partial<ProjectArtifactBoardPageQuery> = {}) {
  return projectArtifactBoardPageService.read(
    PROJECT_ID,
    ORGANIZATION_ID,
    query(overrides),
    {
      statusEvidence: BoardStatusEvidence.Stored,
      statusOrdering: ArtifactSectionOrdering.Vocabulary,
      userId: VIEWER_ID,
    }
  );
}

/**
 * Unit half of CT-08: how the service shapes a response from its two root
 * queries. The SQL itself (filters, order, revision, continuation) is proved
 * against Postgres in `__tests__/integration/project-artifact-board-filters`.
 */
describe("CT-08 AC-001 board lane pagination service", () => {
  it("reads only the page's artifacts and maps the database lane aggregate", async () => {
    const first = await read();
    if (!first.ok) {
      throw new Error(first.error.message);
    }
    expect(first.value.lanes).toMatchObject([
      { id: IssueStatus.Todo, count: 2, complete: false },
      { id: IssueStatus.Done, count: 1, complete: false },
    ]);
    expect(first.value.lanes[0]?.cards.map((card) => card.artifact.id)).toEqual(
      [roots[0]?.id]
    );
    expect(first.value.rootIds).toEqual([roots[0]?.id]);
    expect(first.value.nextCursor).toBeDefined();
    expect(first.value.projectVersion).toBe("placement-v1");
    // ISS-12929 724-F5: no read of the whole root population into the server.
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.findMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: [roots[0]?.id] },
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
        }),
      })
    );
    expect(mocks.readPlacementState).toHaveBeenCalledWith(
      expect.anything(),
      ORGANIZATION_ID,
      [PROJECT_ID]
    );
    expect(mocks.txOptions).toHaveBeenCalledWith({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  });

  it("continues with the cursor's offset and ends without a cursor", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await read(cursor ? { cursor } : {});
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      seen.push(...result.value.rootIds);
      cursor = result.value.nextCursor;
      pageOffset += 1;
    } while (cursor);
    expect(seen).toEqual(roots.map((root) => root.id));
  });

  it("ISS-12929 724-F4 carries each document card's current version and omits an unread one", async () => {
    mocks.documentDetails.mockResolvedValue([
      { artifactId: roots[0]?.id, latestVersion: 4 },
    ]);
    mocks.queryRaw.mockImplementation((sql: RawSql) => {
      switch (rawSqlKind(sql)) {
        case "aggregate":
          return Promise.resolve(aggregateRows(2));
        case "page":
          return Promise.resolve(roots.slice(0, 2).map(({ id }) => ({ id })));
        default:
          return Promise.resolve([]);
      }
    });
    const result = await read({ pageSize: 2 });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const cards = result.value.lanes.flatMap((lane) => lane.cards);
    expect(cards[0]?.artifact.currentVersion).toBe(4);
    expect(cards[1]?.artifact).not.toHaveProperty("currentVersion");
  });

  it("ISS-12929 724-F4 keeps the board read when the version enrichment fails", async () => {
    mocks.documentDetails.mockRejectedValue(new Error("versions unavailable"));
    const result = await read();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value.rootIds).toEqual([roots[0]?.id]);
    expect(
      result.value.lanes.flatMap((lane) => lane.cards)[0]?.artifact
    ).not.toHaveProperty("currentVersion");
  });

  it("returns the authoritative optional adapter policy with the board read", async () => {
    mocks.resolveLanePolicy.mockResolvedValue({
      field: ProjectArtifactPlacementGroupField.Status,
      revision: "policy-v1",
      version: PROJECT_ARTIFACT_LANE_POLICY_VERSION,
      wipLimitByLane: { [IssueStatus.Todo]: 4 },
    });
    const result = await read();
    expect(result).toMatchObject({
      ok: true,
      value: { lanePolicy: { revision: "policy-v1" } },
    });
  });

  it("rejects malformed, regrouped and stale cursors without returning plausible data", async () => {
    expect(await read({ cursor: "not-a-board-cursor" })).toMatchObject({
      ok: false,
      error: { code: ProjectArtifactBoardPageError.InvalidCursor },
    });

    const first = await read();
    if (!(first.ok && first.value.nextCursor)) {
      throw new Error("expected first board page cursor");
    }
    expect(
      await read({
        cursor: first.value.nextCursor,
        groupBy: ProjectArtifactBoardGroup.Priority,
      })
    ).toMatchObject({
      ok: false,
      error: { code: ProjectArtifactBoardPageError.StaleRevision },
    });
    expect(
      await read({
        cursor: first.value.nextCursor,
        filters: { search: "another population" },
      })
    ).toMatchObject({
      ok: false,
      error: { code: ProjectArtifactBoardPageError.StaleRevision },
    });
  });

  it("fails the whole read when the authoritative projection fails", async () => {
    const failure = new Error("projection unavailable");
    mocks.queryRaw.mockRejectedValue(failure);
    await expect(read()).rejects.toBe(failure);
  });
});
