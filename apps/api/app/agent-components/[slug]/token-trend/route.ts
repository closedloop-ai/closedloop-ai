import "server-only";

import type { TokenTrendResponse } from "@repo/api/src/types/agent-component-analytics";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { analyticsService } from "../../analytics-service";
import {
  type TokenTrendQueryParams,
  tokenTrendQuerySchema,
} from "../../analytics-validators";

/**
 * GET /agent-components/{slug}/token-trend
 *
 * Per-(component, model) token/cost/latency/truncation time series.
 *
 * The `slug` path param is the org-level identity slug of the component:
 *   `${componentKind}::${normalizedKey}` (URL-encoded on the wire).
 *
 * Optional query params:
 *   `userId` — scope to a specific user for the personal optimization view.
 *   `since`  — ISO date string; earliest session to include (inclusive).
 *   `until`  — ISO date string; latest session to include (inclusive).
 *   `cursor` — a prior response's `nextCursor`; resumes after the session that
 *              page ended on (ISS-9851). A token this endpoint did not mint is
 *              a 400.
 *
 * Auth: any authenticated org member (withAnyAuth, org-visible — not admin-only).
 *
 * Returns 404 when the slug format is invalid (not `kind::key`).
 * Returns an empty points array when the slug is valid but has no usage data.
 */
export const GET = withAnyAuth<
  TokenTrendResponse,
  "/agent-components/[slug]/token-trend"
>(
  async ({ user }, request, params) => {
    // Next's route matcher already `decodeURIComponent`s every captured
    // segment, so `slug` arrives decoded. Decoding again corrupts a slug
    // containing a literal `%` (`skill::a%20b` -> `skill::a b`) or throws
    // `URIError` — here outside the try/catch, so it never became a response.
    const { slug } = await params;

    const { params: query, errorResponse: parseError } = parseQueryParams(
      request,
      tokenTrendQuerySchema
    );
    if (parseError) {
      return parseError;
    }
    const { userId, since, until, cursor } = query as TokenTrendQueryParams;

    try {
      const result = await analyticsService.fetchTokenTrend(
        user.organizationId,
        slug,
        { userId, since, until, cursor }
      );

      if (result === null) {
        return notFoundResponse("AgentComponent");
      }

      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to fetch token trend", error);
    }
  },
  { requiredScopes: ["read"] }
);
