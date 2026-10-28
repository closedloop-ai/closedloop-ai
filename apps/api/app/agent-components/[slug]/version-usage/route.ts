import "server-only";

import type { AgentComponentVersionUsageResponse } from "@repo/api/src/types/agent-component-version-usage";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import {
  type VersionUsageQueryParams,
  versionUsageQuerySchema,
} from "../../analytics-validators";
import { loadVersionUsageForOrg } from "../../service/detail-version-usage";

/**
 * GET /agent-components/{slug}/version-usage
 *
 * ISS-10467 (drill-down) / ISS-10468 (side-by-side compare): ONE content
 * version's own usage — invocations, sessions, and the token/cost and
 * efficiency aggregates the detail already computes — plus the family usage no
 * version can claim.
 *
 * The `slug` path param is the same detail key the page was opened with
 * (`${kind}::${fingerprint}` or a legacy `${kind}::${name}`), so the drill-down
 * always answers for the family the user is looking at.
 *
 * `version` is repeated, one per content version (`ComponentVersion.hash`).
 * A request naming more than the contract's cap is a 400 that names the cap.
 *
 * This endpoint NEVER restates the family totals: the client already holds them
 * on the detail payload, and a second producer of the page's headline number
 * could disagree with the first.
 *
 * Auth: any authenticated org member (withAnyAuth), matching the detail read it
 * drills into. Returns 404 for a slug this org has no live component for.
 */
export const GET = withAnyAuth<
  AgentComponentVersionUsageResponse,
  "/agent-components/[slug]/version-usage"
>(
  async ({ user }, request, params) => {
    // Next's route matcher already decoded the captured segment; decoding again
    // corrupts a slug containing a literal `%` — the same contract the sibling
    // detail and token-trend routes carry.
    const { slug } = await params;
    const { params: query, errorResponse: parseError } = parseQueryParams(
      request,
      versionUsageQuerySchema
    );
    if (parseError) {
      return parseError;
    }
    const { version } = query as VersionUsageQueryParams;

    try {
      const result = await loadVersionUsageForOrg(
        user.organizationId,
        slug,
        version
      );
      if (!result) {
        return notFoundResponse("AgentComponent");
      }
      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to fetch component version usage", error);
    }
  },
  { requiredScopes: ["read"] }
);
