import {
  NAVIGATION_DESTINATION_LIMIT,
  type NavigationViewModel,
} from "@repo/api/src/types/navigation-view-model";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from "@/lib/route-utils";
import { navigationService } from "../service";

export const DESTINATION_ID_MAX_LENGTH = 128;

export type ParsedDestinationIds =
  | { ok: true; ids: string[] }
  | { ok: false; reason: string };

/**
 * The actor's navigation projection for the destinations the caller's manifest
 * declares (ISS-8377).
 *
 * The caller names the destinations rather than the server holding a second copy
 * of the manifest, which is what keeps route identity owned in one place instead
 * of drifting between the shell and this route.
 */
export const GET = withAnyAuth<NavigationViewModel>(
  async ({ clerkOrgId, clerkUserId, user }, request) => {
    const parsed = parseDestinationIds(
      new URL(request.url).searchParams.getAll("destinations")
    );
    // A malformed query is the CLIENT's error. Returning 500 would also record a
    // route-handler error span, so ordinary bad input would page on the server's
    // own error monitors.
    if (!parsed.ok) {
      return badRequestResponse(parsed.reason);
    }

    try {
      const viewModel = await navigationService.buildNavigationViewModel({
        clerkOrgId: clerkOrgId ?? null,
        clerkUserId,
        destinationIds: parsed.ids,
        organizationId: user.organizationId ?? null,
      });

      return successResponse(viewModel);
    } catch (error) {
      return errorResponse("Failed to build navigation view model", error);
    }
  }
);

/**
 * Trim, drop blanks, and dedupe the REPEATED `destinations` parameters
 * (`?destinations=a&destinations=b`), which is this repo's contract for a new
 * multi-value query param — a comma list is reserved for an existing public
 * contract, and this route has no client yet.
 *
 * Over-limit input is REJECTED rather than truncated. A silent `slice` would
 * drop real ids, and the fold maps an id the projection never mentioned to
 * `capability-error` — so the caller would get a sidebar of inert "Unavailable"
 * rows and no error anywhere saying why. A 400 names the problem to the one
 * party that can fix it.
 */
export function parseDestinationIds(
  raw: readonly string[]
): ParsedDestinationIds {
  const unique = new Set<string>();
  for (const candidate of raw) {
    const id = candidate.trim();
    if (id.length > DESTINATION_ID_MAX_LENGTH) {
      // Repeated params drop the single-string budget the comma list had, so the
      // per-id bound is what still stops one request carrying an unbounded
      // payload past the count limit below.
      return {
        ok: false,
        reason: `each destinations id must be at most ${DESTINATION_ID_MAX_LENGTH} characters`,
      };
    }
    if (id.length > 0) {
      unique.add(id);
    }
  }
  if (unique.size > NAVIGATION_DESTINATION_LIMIT) {
    return {
      ok: false,
      reason: `destinations must name at most ${NAVIGATION_DESTINATION_LIMIT} ids`,
    };
  }
  return { ok: true, ids: Array.from(unique) };
}
