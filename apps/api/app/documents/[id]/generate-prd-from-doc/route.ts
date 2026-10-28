import type { Document } from "@repo/api/src/types/document";
import { GeneratePrdEndpointRemoval } from "@repo/api/src/types/endpoint-removal";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { goneResponse } from "@/lib/route-utils";

/**
 * Compatibility tombstone for the removed doc→PRD seeding route (ISS-8943).
 *
 * This route was `withAnyAuth`, so an `sk_live_*` integration — not just the
 * web bundle — could reach it, and no such client redeploys with us. Keep the
 * path and its auth shape, answer 410 (`apps/api/AGENTS.md`), and seed nothing.
 */
export const POST = withAnyAuth<
  Document,
  "/documents/[id]/generate-prd-from-doc"
>(
  () =>
    Promise.resolve(
      goneResponse(GeneratePrdEndpointRemoval.Message, {
        code: GeneratePrdEndpointRemoval.Code,
      })
    ),
  { requiredScopes: ["write"] }
);
