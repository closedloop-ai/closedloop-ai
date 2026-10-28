import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { machineWriteReceipt } from "@/lib/machine-write-receipt";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  conflictResponse,
  errorResponse,
  parseBody,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import {
  DuplicateNameError,
  type ExactNameTagRow,
  type TagListReadQuery,
  tagService,
} from "./service";
import { createTagValidator, tagListQuerySchema } from "./validators";

/**
 * GET /tags — the organization's tag catalogue.
 *
 * Returns a bare `Tag[]` by default, unchanged and unbounded (ISS-7461). Three
 * live consumers read this body as an array across independent deploy
 * boundaries — `useTags()` in `packages/app`, `fetchOrgTagPage` in `apps/mcp`,
 * and installed pre-PRD-797 Desktop builds' crewd client — so the paged
 * envelope is OPT-IN behind `includeTotal=true`, exactly as `GET /documents` does it (ISS-4576).
 * `includeTotal` selects the response SHAPE and never which read runs: a
 * present `includeTotal=false` still means the unbounded array, not a silently
 * truncated page.
 *
 * Two row shapes travel under the one `Tag[]` contract, on purpose. The
 * `?name=` branch is a single projected row and carries no `createdBy` and no
 * `_count`; every other branch carries `TAG_INCLUDE`. `Tag.createdBy` is
 * optional and `_count` is not part of `Tag`, so both satisfy the type. Only
 * the MCP mutation path sends `?name=`, and it reads id/name/color — but the
 * difference is recorded here so the two cannot drift unnoticed.
 */
export const GET = withAnyAuth<TagsGetResponse, "/tags">(
  async ({ user }, request) => {
    const { params, errorResponse: parseError } = parseQueryParams(
      request,
      tagListQuerySchema
    );
    if (parseError) {
      return parseError;
    }

    const { includeTotal, ...query } = params;
    try {
      if (query.name !== undefined) {
        const tag = await tagService.findByExactName(
          user.organizationId,
          query.name
        );
        const items = tag ? [tag] : [];
        // The envelope is what tells a client its `name` filter was actually
        // applied. A server too old to know the param answers with the whole
        // catalogue as a bare array, and a bare 0-or-1 array is
        // indistinguishable from that — so a client that has to guess ends up
        // re-filtering a match the database already made.
        return successResponse(
          includeTotal ? { items, total: items.length, hasMore: false } : items
        );
      }
      if (includeTotal) {
        return successResponse(
          await tagService.findPageByOrg(user.organizationId, query)
        );
      }
      if (hasNarrowingParams(query)) {
        return successResponse(
          await tagService.findManyByOrg(user.organizationId, query)
        );
      }
      return successResponse(await tagService.findByOrg(user.organizationId));
    } catch (error) {
      return errorResponse("Failed to fetch tags", error);
    }
  }
);

export const POST = withAnyAuth(
  withOperationReceipts<CreatedTag, "/tags">(
    OperationKind.OrganizationWrite,
    async ({ user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          createTagValidator
        );
        if (parseError) {
          return parseError;
        }

        const tag = await tagService.create(
          user.organizationId,
          user.id,
          body,
          receipts.whenRecording((tx) =>
            receipts.record(
              tx,
              machineWriteReceipt(OperationKind.OrganizationWrite, true)
            )
          )
        );
        return successResponse(withOperationReceipt(tag, receipts));
      } catch (error) {
        if (error instanceof DuplicateNameError) {
          return conflictResponse("Tag with this name already exists");
        }
        return errorResponse("Failed to create tag", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);

/**
 * Every shape `GET /tags` can answer with.
 *
 * Spelled as a union of the services' own return types rather than a single
 * declared contract, because the branches genuinely differ: the `?name=` lookup
 * projects one lean row (see the handler docstring), while the list branches
 * carry `TAG_INCLUDE`. Deriving each arm from its producer means a service
 * whose row shape changes fails typecheck here instead of silently widening the
 * response.
 */
type TagsGetResponse =
  | Awaited<ReturnType<typeof tagService.findByOrg>>
  | Awaited<ReturnType<typeof tagService.findPageByOrg>>
  | ExactNameTagRow[]
  | ExactNameTagPage;

/**
 * The `?name=` lookup under `includeTotal=true`.
 *
 * Structurally a `TagListPage` over the lean projected row, and `total`/
 * `hasMore` are constants here (0-or-1, never more) — the envelope is requested
 * for what its PRESENCE proves, not for its counts: it is how a client knows
 * the server understood `name` rather than ignoring it and returning the whole
 * catalogue.
 */
type ExactNameTagPage = {
  items: ExactNameTagRow[];
  total: number;
  hasMore: boolean;
};

type CreatedTag = Awaited<ReturnType<typeof tagService.create>>;

/**
 * True when the caller asked for the bounded, filtered read.
 *
 * `offset` and `search` are tested even though the validator's `offset requires
 * limit` and `search requires limit` refines make either unreachable on its
 * own: whether this route stays bounded must not depend on a guard in another
 * module, and `findManyByOrg` floors its own `take` for the same reason.
 */
function hasNarrowingParams(query: TagListReadQuery): boolean {
  return (
    query.limit !== undefined ||
    query.offset !== undefined ||
    query.search !== undefined
  );
}
