import {
  REFERENCE_RESOLVE_MAX_IDS,
  REFERENCE_SEARCH_DEFAULT_LIMIT,
  REFERENCE_SEARCH_MAX_LIMIT,
} from "@repo/api/src/types/custom-field";
import { z } from "zod";
import { isArtifactId } from "./reference-targets";
import {
  MAX_REFERENCE_TARGET_SOURCES,
  referenceTargetSourceEnum,
} from "./validators";

/** Longest query the typeahead forwards; past this it is not a typeahead. */
const MAX_SEARCH_QUERY_LENGTH = 256;

const artifactIdSchema = z
  .string()
  .refine(isArtifactId, "must be an artifact id");

/**
 * `sources` arrives as one string or a repeated param, because
 * `parseQueryParams` collapses a single-valued key to a bare string. Both
 * spellings normalize to an array so the service sees one shape.
 *
 * Capped with the create/update validators' own bound, not a second copy of the
 * number: `referenceSourceScope` builds one query `OR` branch per entry, so
 * `sources=ISSUE` repeated hundreds of times would compile hundreds of
 * redundant disjuncts for a set that only has four legal members.
 */
const sourcesSchema = z
  .union([
    referenceTargetSourceEnum,
    z.array(referenceTargetSourceEnum).max(MAX_REFERENCE_TARGET_SOURCES),
  ])
  .transform((value) => (Array.isArray(value) ? value : [value]))
  .optional();

/**
 * The `:id` path segment of the search route.
 *
 * Parsed before the service runs because `custom_fields.id` is a Postgres
 * `uuid` column: a malformed value like `not-a-uuid` reaches the driver, which
 * RAISES rather than returning no row, so the field lookup's own "does not
 * exist" branch never gets to answer and the route can only report a caller
 * mistake as a 500.
 */
export const referenceFieldIdValidator = z.uuid();

/**
 * `.strict()` is deliberate. Zod's default is to STRIP an unknown key, so
 * `?limt=5` or `?source=ISSUE` would drop the caller's intent on the floor and
 * run a wider search under the defaults — a typo silently changing which
 * candidates come back. These four params are the whole set the route
 * implements, and the endpoint is new in ISS-7212 with no shipped client, so
 * there is no older caller sending a fifth key for this to start rejecting.
 */
export const referenceTargetSearchValidator = z
  .object({
    query: z.string().max(MAX_SEARCH_QUERY_LENGTH).optional(),
    sources: sourcesSchema,
    // Coerced because every query-string value arrives as a string. `limit=abc`
    // coerces to NaN, which Zod's number check rejects, so it 400s at the boundary
    // instead of reaching Prisma's `take` as NaN.
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(REFERENCE_SEARCH_MAX_LIMIT)
      .default(REFERENCE_SEARCH_DEFAULT_LIMIT),
    excludeEntityId: artifactIdSchema.optional(),
  })
  .strict();

/**
 * An empty `targetIds` is accepted, not rejected: a page whose reference cells
 * are all blank legitimately asks to resolve nothing, and answering that with a
 * 400 would make the caller special-case its own empty state.
 */
export const referenceTargetResolveValidator = z.object({
  targetIds: z.array(artifactIdSchema).max(REFERENCE_RESOLVE_MAX_IDS),
});
