import { BATCH_MUTATION_ENTITY_LIMIT } from "@repo/api/src/types/batch-mutation-limits";
import {
  TAG_LIST_MAX_LIMIT,
  TAG_LIST_MAX_OFFSET,
  TAG_NAME_MAX_LENGTH,
  TAG_NAME_PATTERN,
  TAG_NAME_RULE_MESSAGE,
  TagColor,
  TagEntityType,
} from "@repo/api/src/types/tag";
import { z } from "zod";
import { optionalSingleArtifactEditSurface } from "@/lib/single-artifact-edit-surface";

const tagColorEnum = z.enum(TagColor);
// `LOOP` is not taggable since Loops were retired (ISS-12435, PRD-795 D1): a
// request naming it is a 400, not a write against a removed relation.
const tagEntityTypeEnum = z.enum([
  TagEntityType.Project,
  TagEntityType.Artifact,
]);

/**
 * Built from the shared constants so the MCP tag tools can state this rule in
 * their input descriptions without re-deriving it. This is the only guarded
 * write path for a tag name — the column itself is unconstrained, so a lookup
 * must not assume every stored name satisfies it.
 */
const tagNameSchema = z
  .string()
  .min(1)
  .max(TAG_NAME_MAX_LENGTH)
  .regex(TAG_NAME_PATTERN, TAG_NAME_RULE_MESSAGE);

export const createTagValidator = z.object({
  name: tagNameSchema,
  color: tagColorEnum.optional(),
});

export const updateTagValidator = z.object({
  name: tagNameSchema.optional(),
  color: tagColorEnum.optional(),
});

export const entityTagValidator = z.object({
  tagId: z.uuid(),
  entityType: tagEntityTypeEnum,
  entityId: z.uuid(),
  surface: optionalSingleArtifactEditSurface,
});

export const batchEntityTagValidator = z.object({
  tagId: z.uuid().overwrite((value) => value.toLowerCase()),
  // Batch apply is artifact-only — the service writes `tagArtifact` rows only.
  entityType: z.literal(TagEntityType.Artifact),
  entityIds: z
    .array(z.uuid().overwrite((value) => value.toLowerCase()))
    .min(1, "At least one entity ID required")
    .max(BATCH_MUTATION_ENTITY_LIMIT),
});

/**
 * Query contract for `GET /tags` (ISS-7461).
 *
 * Modelled on `findDocumentsQueryValidator` (ISS-4576/FEA-4373), including the
 * two guards that make its polarity safe.
 *
 * `limit`/`offset` are optional with NO `.default()`. That is load-bearing:
 * `parseQueryParams` returns post-transform data, so a default would erase the
 * difference between "caller sent nothing" and "caller sent the default", and
 * the unbounded legacy read every existing consumer relies on would become
 * unreachable — silently returning 25 tags to `useTags()` and to crewd.
 *
 * The refines below are the other half. Without them, `?offset=0` alone would
 * select the bounded branch with no bound, i.e. the org-wide read this ticket
 * exists to kill, wearing an envelope that makes it look bounded. The repo's
 * answer to that is REJECT, not silently narrow — the same posture as the
 * `limit` bound itself.
 */
const tagListQueryFields = z
  .object({
    limit: z.coerce.number().int().min(1).max(TAG_LIST_MAX_LIMIT).optional(),
    offset: z.coerce.number().int().min(0).max(TAG_LIST_MAX_OFFSET).optional(),
    /**
     * Case-insensitive substring match on the tag name. Requires `limit` (see
     * the refine below).
     */
    search: z.string().trim().min(1).optional(),
    /**
     * Exact, case-insensitive name lookup — the mutation tools' resolution
     * path. Deliberately NOT `.trim()`ed and NOT held to `TAG_NAME_PATTERN`:
     * the column is unconstrained, so a legacy or directly-written row can hold
     * a name outside the create-time rule or with significant leading /
     * trailing space, and `(organization_id, lower(name))` treats `" DSP "` and
     * `"DSP"` as DIFFERENT tags. Normalising here would resolve one to the
     * other and apply the wrong tag.
     */
    name: z.string().min(1).optional(),
    /**
     * Opt into the `TagListPage` envelope instead of the bare array. Same
     * reject-don't-guess coercion as the documents route: anything other than
     * "true"/"false" is a 400, not a silent falsy default.
     *
     * This selects the RESPONSE SHAPE only — never which read runs. A present
     * `includeTotal=false` must still mean "the legacy unbounded array", not a
     * silently truncated page.
     */
    includeTotal: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    /**
     * Accepted and then IGNORED. Installed pre-PRD-797 Desktop builds' crewd
     * client sends `GET /tags?projectId=<slug>` and gets a 200 because this route
     * previously read no query params at all; there has never been a
     * project-scoped tag predicate behind it. Declared here so the schema can
     * be `.strict()` — which is what makes a typo like `?limt=5` a 400 instead
     * of a silent fall-through to the unbounded read — without turning a
     * working client's no-op param into an error.
     *
     * No `.min(1)`, no slug validation, on purpose: crewd interpolates its slug
     * with no guard, so a blank value must stay a no-op rather than become a
     * 400 (the same reasoning the ISS-4942 `owner` alias records).
     */
    projectId: z.string().optional(),
  })
  .strict()
  .refine((query) => query.offset === undefined || query.limit !== undefined, {
    message: "offset requires limit",
    path: ["offset"],
  })
  // `search` is a NEW param, so it carries none of the bare array's
  // compatibility debt — no deployed client can already be sending it. Left
  // unbounded it would be the ticket's own defect wearing a filter: `?search=x`
  // alone reaches `findManyByOrg` with no `take` and an unindexed
  // `name contains` predicate, which is a full org scan PLUS a per-row match,
  // strictly more work than the plain `findByOrg` it looks narrower than.
  //
  // Rejected rather than silently defaulted to `TAG_LIST_DEFAULT_LIMIT`: a
  // silent bound hands back a truncated set that the caller cannot tell from a
  // complete one, which is the same "looks bounded, is not" failure the
  // `offset` refine above exists to prevent, inverted. `list-tags` already
  // resolves its own default limit before it sends the request, so no in-repo
  // caller can hit this.
  .refine((query) => query.search === undefined || query.limit !== undefined, {
    message: "search requires limit",
    path: ["search"],
  })
  // `includeTotal=true` without a bound materializes the FULL matching set and
  // adds a `count()` over the same predicate — the exact unbounded workload the
  // paged path exists to avoid. A `name` lookup satisfies the bound too: the
  // `(organization_id, lower(name))` unique index makes it 0-or-1 rows by
  // construction, so there is no unbounded read to prevent.
  .refine(
    (query) =>
      !query.includeTotal ||
      query.limit !== undefined ||
      query.name !== undefined,
    {
      message: "includeTotal requires limit or name",
      path: ["includeTotal"],
    }
  )
  // `name` is an exact single-row lookup, so every paging and filtering
  // dimension is meaningless beside it. Rejecting the combination beats
  // declaring a precedence rule: a dropped `name` would hand back an arbitrary
  // page of unrelated tags under a lookup the caller believes was exact.
  //
  // `includeTotal` is deliberately NOT in that set. It selects the response
  // SHAPE, and pairing it with `name` is what lets a client tell a server that
  // honoured `name` from one too old to know the param: an old server ignores
  // both and answers with the whole catalogue as a bare array, so the envelope
  // is a reliable "your filter was applied" signal. Without it the client has
  // to infer that from the response shape, and a bare 0-or-1 array is
  // indistinguishable from an unfiltered one — which made `tag-artifact`
  // re-filter a server match locally and fail on any name where PostgreSQL's
  // `lower()` and JavaScript's `toLowerCase()` disagree.
  .refine(
    (query) =>
      query.name === undefined ||
      (query.limit === undefined &&
        query.offset === undefined &&
        query.search === undefined),
    {
      message: "name cannot be combined with limit, offset, or search",
      path: ["name"],
    }
  );

/**
 * Drop the compatibility-only `projectId` at the boundary so no downstream
 * predicate can read a filter this route does not implement.
 *
 * `.strict()` and the refines are applied to the object ABOVE this transform:
 * a transformed schema is a `ZodEffects` and no longer exposes either.
 */
export const tagListQuerySchema = tagListQueryFields.transform(
  ({ projectId: _ignoredCompatibilityParam, ...query }) => query
);

export type TagListQuery = z.infer<typeof tagListQuerySchema>;

/**
 * The query params `GET /tags` accepts, as the single source of truth for the
 * `openapi.json` drift guard.
 *
 * Exported from the validator rather than read back out of the spec: a guard
 * that derives its expectation from the document it is checking goes green on
 * exactly the drift it exists to catch (the bug
 * `openapi-agent-sessions-params.test.ts` records). Derived from the schema
 * rather than hand-listed for the same reason one level down — a param added to
 * the schema and forgotten in both places would leave a hand-written list and
 * the spec agreeing with each other. Same idiom as
 * `AGENT_SESSION_LIST_QUERY_PARAM_NAMES`.
 */
export const TAG_LIST_QUERY_PARAM_NAMES = Object.keys(tagListQueryFields.shape);
