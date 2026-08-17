import { z } from "zod";
import type { TraceCommentTarget, TraceTextAnchor } from "./comment.js";

/**
 * Golden-dataset CANDIDATE pipeline (FEA-4171).
 *
 * A candidate is the read-only projection of a trace comment that a human flagged
 * as a parsing/data bug (`TraceCommentKind.ParsingBug`). It bundles everything a
 * human needs to hand-author a `packages/golden-sessions/` oracle entry — the
 * source session, the anchored turn, and the human's noted expected value (the
 * comment body) — WITHOUT writing any oracle file. The pipeline only SURFACES
 * candidates; promotion into the golden dataset is a separate action governed
 * by packages/golden-sessions/AGENTS.md, so none of these types describe or
 * touch an oracle file. This is the enforced boundary: the candidate output is
 * a query result, never a golden-sessions write.
 */
export type GoldenDatasetCandidate = {
  /** The flagging trace comment's id (stable identity of the candidate). */
  commentId: string;
  /** The backing thread id, for deep-linking back to the comment. */
  threadId: string;
  /**
   * Source session/branch this candidate was flagged on. `target.id`/`sessionId`
   * is the cloud artifact id a human uses to locate the raw session.
   */
  target: TraceCommentTarget;
  /** Source session artifact id (echoes `target.id`) for convenience. */
  sessionId: string;
  /**
   * The anchored trace passage — turn, row, and the selected/source text — that
   * the human pointed at when flagging the bug.
   */
  anchor: TraceTextAnchor;
  /**
   * The human's noted expected value: the plain-text body of the flagged comment.
   * This is the "what the collector SHOULD have produced" note a human transcribes
   * into an oracle entry.
   */
  notedExpectedValue: string;
  /** Author of the flagging comment. */
  authorId: string;
  authorName: string | null;
  /** When the bug was flagged (comment creation time), ISO-8601. */
  createdAt: string;
};

/** Default page size for the org-scoped `GET /golden-candidates` list (FEA-4171). */
export const GOLDEN_CANDIDATE_LIST_DEFAULT_LIMIT = 50;
/** Upper bound on a single golden-candidate page (FEA-4171). */
export const GOLDEN_CANDIDATE_LIST_MAX_LIMIT = 100;

/**
 * Paginated response for `GET /golden-candidates` (FEA-4171). `total` is the full
 * org-scoped count of parsing-bug-flagged comments for the applied filters;
 * `nextCursor` is an opaque offset token (null when exhausted), matching the
 * aggregate trace-comment list's offset pagination.
 */
export type GoldenCandidateListResponse = {
  items: GoldenDatasetCandidate[];
  total: number;
  nextCursor: string | null;
};

/** Canonical HTTP collection path for the golden-candidate report. */
export const GOLDEN_CANDIDATES_PATH = "/golden-candidates" as const;

/**
 * Query params for `GET /golden-candidates` (FEA-4171). `sessionId` narrows to a
 * single source session's candidates; pagination is offset-based like the
 * aggregate trace-comment list (`cursor` — the opaque token echoed from a prior
 * response — wins over a raw `offset`).
 */
export const goldenCandidateListQuerySchema = z.object({
  sessionId: z.string().uuid().optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(GOLDEN_CANDIDATE_LIST_MAX_LIMIT)
    .optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  cursor: z.coerce.number().int().nonnegative().optional(),
});

export type GoldenCandidateListQuery = z.infer<
  typeof goldenCandidateListQuerySchema
>;
