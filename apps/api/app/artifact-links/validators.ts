import {
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/artifact";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { z } from "zod";
import { uuidOrSlug } from "@/lib/identifier-utils";
import { optionalArtifactEditSurface } from "@/lib/single-artifact-edit-surface";
import { jsonObjectValidator } from "@/lib/validators/json";
import { SELF_ARTIFACT_LINK_MESSAGE } from "./link-messages";
import { ARTIFACT_LINK_PAGE_SIZE } from "./resolved-page";

const linkTypeEnum = z.enum(LinkType);
const MAX_PARENT_TARGET_IDS = 100;

export const createArtifactLinkValidator = z
  .object({
    sourceId: uuidOrSlug(),
    targetId: uuidOrSlug(),
    linkType: linkTypeEnum,
    metadata: jsonObjectValidator.nullable().optional(),
  })
  // Catches only the literal spelling; a slug and the UUID it resolves to are
  // different strings here, so the service repeats the check post-resolution.
  .refine((data) => data.sourceId !== data.targetId, {
    message: SELF_ARTIFACT_LINK_MESSAGE,
    path: ["targetId"],
  });

const artifactLinkQueryShape = {
  artifactId: uuidOrSlug(),
  linkType: linkTypeEnum.optional(),
  direction: z.enum(LinkDirection).optional().default(LinkDirection.Both),
  mode: z.enum(LinkQueryMode).optional().default(LinkQueryMode.Direct),
  maxDepth: z.coerce.number().int().min(1).max(50).optional().default(10),
};

/**
 * Only `/artifact-links/resolved` pages. `GET /artifact-links` shares every
 * other param and answers with the whole unbounded match set, so it REJECTS
 * these two rather than letting Zod strip them: a caller that sent
 * `paginated=true&cursor=1000` there would otherwise get a 200 carrying the
 * entire graph as a bare array, read it as page one of an envelope it never
 * received, and page forever or report the first page as the whole answer
 * (#7368 review, whitlockk). A 400 naming the right route is the only answer that
 * cannot be misread.
 */
const PAGINATION_UNSUPPORTED_MESSAGE =
  "paginated and cursor are only supported on /artifact-links/resolved";

export const findArtifactLinksQueryValidator = z.object({
  ...artifactLinkQueryShape,
  paginated: z.undefined({ error: PAGINATION_UNSUPPORTED_MESSAGE }),
  cursor: z.undefined({ error: PAGINATION_UNSUPPORTED_MESSAGE }),
});

export const findResolvedArtifactLinksQueryValidator = z
  .object({
    ...artifactLinkQueryShape,
    // ISS-10102. Opting in swaps the bare-array body for an `ArtifactLinkPage`
    // envelope carrying `nextCursor`. Same string-literal coercion and
    // reject-don't-guess posture as `/documents`' `includeTotal`: anything other
    // than "true"/"false" is a 400, never a silent falsy default.
    paginated: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    // A prior page's `nextCursor`, echoed verbatim. Opaque to callers; it encodes
    // the offset into this query's own deterministic result order. A malformed
    // value is a 400 rather than a silent restart from the first page, which
    // would loop a pager forever.
    //
    // Page-ALIGNED because every cursor this route emits is a whole number of
    // pages (`splitPeekedPage` advances by `ARTIFACT_LINK_PAGE_SIZE`). Accepting
    // an arbitrary offset would make the "opaque cursor" claim false and hand a
    // caller a free `OFFSET` knob on an order this table has no index for
    // (#7368 review, whitlockk); the only values that round-trip are the ones the
    // route itself produced.
    snapshotId: z.uuid().optional(),
    cursor: z.coerce
      .number()
      .int()
      .min(0)
      .refine((value) => value % ARTIFACT_LINK_PAGE_SIZE === 0, {
        error: "cursor must be a value returned by this endpoint",
      })
      .optional(),
  })
  .refine(
    (query) =>
      query.snapshotId === undefined || query.mode === LinkQueryMode.Tree,
    {
      message: "snapshotId is only supported in tree mode",
      path: ["snapshotId"],
    }
  );

/**
 * Query shape for the selected direct-parent projection endpoint. The endpoint
 * accepts artifact UUIDs only because callers already resolved document rows.
 */
export const findArtifactParentsQueryValidator = z.object({
  targetIds: z.preprocess(
    (value) => (typeof value === "string" ? [value] : value),
    z
      .array(z.uuid({ error: "targetIds must contain UUIDs only" }))
      .min(1, "targetIds must contain at least one id")
      .max(
        MAX_PARENT_TARGET_IDS,
        `targetIds must contain at most ${MAX_PARENT_TARGET_IDS} ids`
      )
  ),
  linkType: linkTypeEnum.optional().default(LinkType.Produces),
});

export const batchMoveArtifactsValidator = z.object({
  artifactId: z.uuid(),
  // ISS-12858: `null` files the artifact into no project. Still a required key.
  targetProjectId: z.uuid().nullable(),
  includeDownstream: z.boolean(),
  /**
   * ISS-10995's optimistic guard, OPTIONAL: the bulk Move dialog and the
   * documents batch path send none and must keep writing unguarded. `null` is
   * the real assertion "I believe this artifact is filed into no project", so
   * `.nullable().optional()` and not a bare `.optional()`.
   */
  expectedProjectId: z.uuid().nullable().optional(),
  /**
   * This route is the trusted bulk-move boundary, so an omitted legacy value
   * retains Bulk provenance. An explicit future value still degrades through
   * the permissive parser to omission rather than being mislabeled.
   */
  surface: z.preprocess(
    (value) => (value === undefined ? ArtifactStatusEditSurface.Bulk : value),
    optionalArtifactEditSurface
  ),
});
