import {
  ThreadSource,
  TRACE_COMMENT_METADATA_KIND,
  TraceCommentKind,
  TraceCommentTargetType,
  traceCommentKindSchema,
  traceTextAnchorSchema,
} from "@repo/api/src/types/comment";
import {
  GOLDEN_CANDIDATE_LIST_DEFAULT_LIMIT,
  GOLDEN_CANDIDATE_LIST_MAX_LIMIT,
  type GoldenCandidateListResponse,
  type GoldenDatasetCandidate,
} from "@repo/api/src/types/golden-candidate";
import { Prisma, withDb } from "@repo/database";
import { z } from "zod";
import { formatUserFullName } from "@/lib/user-display-name";

/**
 * Golden-dataset CANDIDATE pipeline (FEA-4171).
 *
 * Surfaces trace comments a human flagged as parsing/data bugs
 * (`TraceCommentKind.ParsingBug`) as read-only CANDIDATES for a human to promote
 * into `packages/golden-sessions/`. This service ONLY reads comment threads and
 * projects them; it never writes any golden-sessions oracle file. Promotion is a
 * human-only action performed outside this pipeline.
 */
export const goldenCandidatesService = {
  async listAll(input: {
    organizationId: string;
    filters: {
      sessionId?: string;
      limit?: number;
      offset?: number;
      cursor?: number;
    };
  }): Promise<GoldenCandidateListResponse> {
    const limit = Math.min(
      Math.max(1, input.filters.limit ?? GOLDEN_CANDIDATE_LIST_DEFAULT_LIMIT),
      GOLDEN_CANDIDATE_LIST_MAX_LIMIT
    );
    const offset = Math.max(
      0,
      input.filters.cursor ?? input.filters.offset ?? 0
    );
    const where = buildGoldenCandidateWhere(
      input.organizationId,
      input.filters
    );

    const [rows, total] = await withDb((db) =>
      Promise.all([
        db.commentThread.findMany({
          where,
          select: goldenCandidateThreadSelect,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: offset,
          take: limit,
        }),
        db.commentThread.count({ where }),
      ])
    );

    const items = await mapGoldenCandidateRows(input.organizationId, rows);
    // Advance the offset by DB rows consumed (not `limit`, not the mapped count)
    // so a defensively dropped row never desyncs paging and a short final page
    // reports `null`.
    const nextCursor =
      offset + rows.length < total ? String(offset + rows.length) : null;
    return { items, total, nextCursor };
  },
};

const goldenCandidateThreadSelect = {
  id: true,
  artifactId: true,
  metadata: true,
  createdAt: true,
  comments: {
    where: { deletedAt: null },
    select: {
      id: true,
      authorId: true,
      plainText: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.CommentThreadSelect;

type GoldenCandidateRow = {
  id: string;
  artifactId: string | null;
  metadata: unknown;
  createdAt: Date;
  comments: {
    id: string;
    authorId: string;
    plainText: string | null;
    createdAt: Date;
  }[];
};

const goldenCandidateMetadataSchema = z.object({
  kind: z.literal(TRACE_COMMENT_METADATA_KIND),
  targetType: z.string(),
  commentKind: traceCommentKindSchema,
  anchor: traceTextAnchorSchema,
});

/**
 * Org-scoped `where` for the golden-candidate list (FEA-4171). Restricts to
 * native trace-comment threads whose metadata classification is `parsing_bug`
 * and that still have a live root comment, so a fully-deleted or unclassified
 * thread never counts. Also restricts to `session` targets: the same
 * `SessionTrace` composer is mounted on Branch View, so a branch comment can be
 * flagged `ParsingBug` too, but a branch artifact id is not a source session and
 * would surface as a candidate whose `sessionId` cannot identify the raw session.
 * Optional `sessionId` narrows to one source session.
 */
function buildGoldenCandidateWhere(
  organizationId: string,
  filters: { sessionId?: string }
): Prisma.CommentThreadWhereInput {
  return {
    organizationId,
    source: ThreadSource.Native,
    comments: { some: { deletedAt: null } },
    artifactId: filters.sessionId ? filters.sessionId : { not: null },
    // Prisma disallows repeating the `metadata` key in one object literal, so the
    // discriminator + classification + target JSON-path filters live in an AND
    // array.
    AND: [
      { metadata: { path: ["kind"], equals: TRACE_COMMENT_METADATA_KIND } },
      {
        metadata: {
          path: ["commentKind"],
          equals: TraceCommentKind.ParsingBug,
        },
      },
      {
        metadata: {
          path: ["targetType"],
          equals: TraceCommentTargetType.Session,
        },
      },
    ],
  };
}

async function mapGoldenCandidateRows(
  organizationId: string,
  rows: GoldenCandidateRow[]
): Promise<GoldenDatasetCandidate[]> {
  const authorIds = [
    ...new Set(
      rows.flatMap((row) => row.comments.map((comment) => comment.authorId))
    ),
  ];
  const authorNameById = await resolveAuthorNames(organizationId, authorIds);

  return rows.flatMap((row) => {
    const metadata = parseGoldenCandidateMetadata(row.metadata);
    const rootComment = row.comments[0];
    if (!(metadata && rootComment && row.artifactId)) {
      return [];
    }
    return [
      {
        commentId: rootComment.id,
        threadId: row.id,
        target: {
          type: metadata.targetType as TraceCommentTargetType,
          id: row.artifactId,
        },
        sessionId: row.artifactId,
        anchor: metadata.anchor,
        notedExpectedValue: rootComment.plainText ?? "",
        authorId: rootComment.authorId,
        authorName: authorNameById.get(rootComment.authorId) ?? null,
        createdAt: rootComment.createdAt.toISOString(),
      } satisfies GoldenDatasetCandidate,
    ];
  });
}

async function resolveAuthorNames(
  organizationId: string,
  authorIds: string[]
): Promise<Map<string, string | null>> {
  if (authorIds.length === 0) {
    return new Map();
  }
  const users = await withDb((db) =>
    db.user.findMany({
      where: { organizationId, id: { in: authorIds } },
      select: { id: true, firstName: true, lastName: true, email: true },
    })
  );
  return new Map(
    users.map((user) => [user.id, formatUserFullName(user) || user.email])
  );
}

function parseGoldenCandidateMetadata(value: unknown) {
  const normalized = value === Prisma.JsonNull ? null : value;
  const result = goldenCandidateMetadataSchema.safeParse(normalized);
  return result.success ? result.data : null;
}
