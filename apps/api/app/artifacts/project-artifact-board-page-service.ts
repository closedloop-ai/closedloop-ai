import "server-only";

import { Buffer } from "node:buffer";
import type { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import {
  PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID,
  PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID,
} from "@repo/api/src/types/project-artifact-board-move";
import {
  PROJECT_ARTIFACT_BOARD_INVALID_CURSOR_MESSAGE,
  ProjectArtifactBoardGroup,
  type ProjectArtifactBoardLanePage,
  ProjectArtifactBoardPageError,
  type ProjectArtifactBoardPageError as ProjectArtifactBoardPageErrorValue,
  type ProjectArtifactBoardPageQuery,
  type ProjectArtifactBoardPageResponse,
  ProjectArtifactBoardSortDirection,
} from "@repo/api/src/types/project-artifact-board-page";
import { MOVE_ARTIFACT_CONFLICT } from "@repo/api/src/types/project-artifact-move";
import type { DetailedArtifact } from "@repo/api/src/types/project-tree";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import {
  ArtifactType,
  LinkType as DatabaseLinkType,
  Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { z } from "zod";
import { buildDocumentStatusMutation } from "@/app/documents/document-status-mutation-capability";
import { readPlacementState } from "@/app/documents/project-artifact-placement-service-support";
import { fetchDocumentVersionsByArtifact } from "@/app/documents/project-tree-version-read";
import {
  mapTagRelations,
  TAG_RELATION_INCLUDE,
} from "@/app/tags/tag-projection-select";
import { runWithAttributionEvidenceGate } from "@/lib/attribution-evidence-gate-scope";
import { basicUserSelect } from "@/lib/db-utils";
import { normalizeArtifactRowSubtype } from "./artifact-tree-shared";
import { readBoardListFilterEvidence } from "./project-artifact-board-list-filters";
import {
  type BoardStatusEvidence,
  readBoardRootAggregate,
  readBoardRootPage,
} from "./project-artifact-board-roots";
import { resolveProjectArtifactLanePolicy } from "./project-artifact-lane-policy";

type BoardPageError = {
  code: ProjectArtifactBoardPageErrorValue;
  message: string;
  status: StatusCode;
};

type BoardDb = TransactionClient;

const cursorSchema = z
  .object({
    groupBy: z.enum(ProjectArtifactBoardGroup),
    offset: z.number().int().min(0),
    revision: z.string().length(64),
  })
  .strict();

/** Project-scoped lane metadata and deterministic DB-backed root pages. */
export const projectArtifactBoardPageService = {
  read(
    projectId: string,
    organizationId: string,
    query: ProjectArtifactBoardPageQuery,
    viewer: BoardViewer
  ): Promise<Result<ProjectArtifactBoardPageResponse, BoardPageError>> {
    return runWithAttributionEvidenceGate(async () => {
      await readBoardListFilterEvidence(organizationId, query.filters);
      const [projection, lanePolicy] = await Promise.all([
        readBoardProjection(projectId, organizationId, query, viewer),
        resolveProjectArtifactLanePolicy(projectId, organizationId),
      ]);
      if (!projection.ok) {
        return projection;
      }
      return Result.ok({
        ...(await withDocumentVersions(organizationId, projection.value)),
        ...(lanePolicy ? { lanePolicy } : {}),
      });
    });
  },
};

function readBoardProjection(
  projectId: string,
  organizationId: string,
  query: ProjectArtifactBoardPageQuery,
  viewer: BoardViewer
): Promise<Result<ProjectArtifactBoardPageResponse, BoardPageError>> {
  return withDb.tx(
    (db) =>
      readBoardProjectionSnapshot(db, projectId, organizationId, query, viewer),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
}

/**
 * One snapshot carries the page and the PRD-725 placement version, so a move
 * made from this page is fenced against the hierarchy the board rendered.
 */
async function readBoardProjectionSnapshot(
  db: BoardDb,
  projectId: string,
  organizationId: string,
  query: ProjectArtifactBoardPageQuery,
  viewer: BoardViewer
): Promise<Result<ProjectArtifactBoardPageResponse, BoardPageError>> {
  const cursor = query.cursor ? decodeBoardCursor(query.cursor) : null;
  if (query.cursor && !cursor) {
    return boardPageError(ProjectArtifactBoardPageError.InvalidCursor);
  }
  if (cursor && cursor.groupBy !== query.groupBy) {
    return boardPageError(ProjectArtifactBoardPageError.StaleRevision);
  }
  const offset = cursor?.offset ?? 0;
  const scope = {
    filters: query.filters,
    groupBy: query.groupBy,
    organizationId,
    projectId,
    ...(query.sortBy
      ? {
          sort: {
            by: query.sortBy,
            direction: query.sortDir ?? ProjectArtifactBoardSortDirection.Asc,
            statusOrdering: viewer.statusOrdering,
          },
        }
      : {}),
    statusEvidence: viewer.statusEvidence,
    viewerUserId: viewer.userId,
  };
  const population = await readBoardRootAggregate(
    db,
    scope,
    offset + query.pageSize
  );
  if (cursor && cursor.revision !== population.revision) {
    return boardPageError(ProjectArtifactBoardPageError.StaleRevision);
  }
  const pageIds = await readBoardRootPage(db, scope, offset, query.pageSize);
  const [artifactRows, descendantCounts, placementState] = await Promise.all([
    readBoardArtifacts(db, organizationId, projectId, pageIds),
    readDescendantCounts(db, organizationId, pageIds),
    readPlacementState(db, organizationId, [projectId]),
  ]);
  const projectVersion = placementState.projectVersions[projectId];
  const artifactById = new Map(
    artifactRows.map((artifact) => [artifact.id, artifact])
  );
  const nextOffset = offset + pageIds.length;
  const lanes: ProjectArtifactBoardLanePage[] = population.lanes.map(
    (lane) => ({
      cards: pageIds.flatMap((id) => {
        const artifact = artifactById.get(id);
        return artifact && boardLaneId(artifact, query.groupBy) === lane.id
          ? [
              {
                artifact,
                descendantCount: descendantCounts.get(id) ?? 0,
              },
            ]
          : [];
      }),
      complete: lane.loadedCount >= lane.count,
      count: lane.count,
      id: lane.id,
      label: lane.id,
    })
  );
  return Result.ok({
    lanes,
    populationRevision: population.revision,
    ...(projectVersion ? { projectVersion } : {}),
    rootIds: pageIds,
    ...(nextOffset < population.total
      ? {
          nextCursor: encodeBoardCursor({
            groupBy: query.groupBy,
            offset: nextOffset,
            revision: population.revision,
          }),
        }
      : {}),
  });
}

type BoardCursor = z.infer<typeof cursorSchema>;

function encodeBoardCursor(cursor: BoardCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeBoardCursor(cursor: string): BoardCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    );
    const result = cursorSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function boardLaneId(
  root: Pick<DetailedArtifact, "assigneeId" | "priority" | "status">,
  groupBy: ProjectArtifactBoardGroup
) {
  switch (groupBy) {
    case ProjectArtifactBoardGroup.Status:
      return root.status;
    case ProjectArtifactBoardGroup.Priority:
      return root.priority ?? PROJECT_ARTIFACT_BOARD_NO_PRIORITY_LANE_ID;
    case ProjectArtifactBoardGroup.Assignee:
      return root.assigneeId ?? PROJECT_ARTIFACT_BOARD_UNASSIGNED_LANE_ID;
    case ProjectArtifactBoardGroup.None:
      return "all";
    default: {
      const exhaustive: never = groupBy;
      return exhaustive;
    }
  }
}

async function readBoardArtifacts(
  db: BoardDb,
  organizationId: string,
  projectId: string,
  artifactIds: readonly string[]
): Promise<DetailedArtifact[]> {
  if (artifactIds.length === 0) {
    return [];
  }
  const rows = await db.artifact.findMany({
    where: { id: { in: [...artifactIds] }, organizationId, projectId },
    include: BOARD_ARTIFACT_INCLUDE,
  });
  const position = new Map(artifactIds.map((id, index) => [id, index]));
  return rows
    .map((row) => {
      const { tagArtifacts, ...artifactRow } = row;
      const artifact = normalizeArtifactRowSubtype(artifactRow);
      return {
        ...artifact,
        ...(artifact.type === ArtifactType.DOCUMENT
          ? { statusMutation: buildDocumentStatusMutation(artifact.subtype) }
          : {}),
        tags: mapTagRelations(tagArtifacts),
      };
    })
    .sort(
      (left, right) =>
        (position.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (position.get(right.id) ?? Number.MAX_SAFE_INTEGER)
    );
}

async function readDescendantCounts(
  db: BoardDb,
  organizationId: string,
  rootIds: readonly string[]
) {
  if (rootIds.length === 0) {
    return new Map<string, number>();
  }
  const values = Prisma.join(rootIds.map((id) => Prisma.sql`(${id}::uuid)`));
  const rows = await db.$queryRaw<
    Array<{ descendantCount: number; rootId: string }>
  >(Prisma.sql`
    WITH RECURSIVE descendants(root_id, artifact_id) AS (
      SELECT input.id, input.id
      FROM (VALUES ${values}) AS input(id)
      UNION
      SELECT descendants.root_id, links.target_id
      FROM descendants
      JOIN artifact_links links
        ON links.source_id = descendants.artifact_id
       AND links.organization_id = ${organizationId}::uuid
       AND links.link_type = ${DatabaseLinkType.PRODUCES}::"LinkType"
    )
    SELECT root_id AS "rootId", (COUNT(*) - 1)::int AS "descendantCount"
    FROM descendants
    GROUP BY root_id
  `);
  return new Map(rows.map((row) => [row.rootId, row.descendantCount]));
}

function boardPageError(code: ProjectArtifactBoardPageErrorValue) {
  return Result.err<ProjectArtifactBoardPageResponse, BoardPageError>({
    code,
    message:
      code === ProjectArtifactBoardPageError.StaleRevision
        ? MOVE_ARTIFACT_CONFLICT
        : PROJECT_ARTIFACT_BOARD_INVALID_CURSOR_MESSAGE,
    status:
      code === ProjectArtifactBoardPageError.StaleRevision
        ? Status.Conflict
        : Status.BadRequest,
  });
}

const BOARD_ARTIFACT_INCLUDE = {
  assignee: basicUserSelect,
  tagArtifacts: { include: TAG_RELATION_INCLUDE },
} as const satisfies Prisma.ArtifactInclude;

/**
 * Who reads the board, and how the browser shows them statuses: the evidence
 * a status filter matches and the order a status sort follows.
 */
export type BoardViewer = {
  statusEvidence: BoardStatusEvidence;
  statusOrdering: ArtifactSectionOrdering;
  userId: string;
};

/**
 * ISS-12929 (724-F4): the same optional version enrichment the project tree
 * returns, so a card's Current version reads what the list column reads. Read
 * after the snapshot, never inside it: a failed statement aborts a Postgres
 * transaction, so an enrichment failure there would fail the whole board read
 * instead of omitting the field.
 */
async function withDocumentVersions(
  organizationId: string,
  page: ProjectArtifactBoardPageResponse
): Promise<ProjectArtifactBoardPageResponse> {
  const documentIds = page.lanes.flatMap((lane) =>
    lane.cards
      .filter((card) => card.artifact.type === ArtifactType.DOCUMENT)
      .map((card) => card.artifact.id)
  );
  if (documentIds.length === 0) {
    return page;
  }
  const versions = await fetchDocumentVersionsByArtifact(
    organizationId,
    documentIds
  );
  return {
    ...page,
    lanes: page.lanes.map((lane) => ({
      ...lane,
      cards: lane.cards.map((card) => {
        const currentVersion = versions.get(card.artifact.id);
        return currentVersion === undefined
          ? card
          : { ...card, artifact: { ...card.artifact, currentVersion } };
      }),
    })),
  };
}
