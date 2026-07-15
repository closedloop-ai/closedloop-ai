import type { PromoteResponse } from "@repo/api/src/types/distribution";
import { z } from "zod";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { promoteAgentComponent } from "./service";

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const promoteSchema = z.object({
  agentComponentId: z.string().uuid(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  targetKind: z.string().optional(),
  sortOrder: z.number().int().optional(),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /agent-components/promote
 *
 * Admin-only best-of-breed promotion: takes a discovered `AgentComponent`
 * (identified by its cloud UUID) and promotes it to a `CatalogItem` +
 * `Distribution` targeting ALL compute targets in the org.
 *
 * - Creates `CatalogItem` (source=org_custom, scope=org) + an initial
 *   `CatalogItemVersion` snapshotting the discovered component so the item is
 *   installable (not an empty payload).
 * - Creates `Distribution` (mode=auto_install, targetingType=all).
 * - Returns `{ catalogItemId, distributionId }`.
 *
 * Authentication: `withAnyAuth`.
 * Authorization: `isOrgAdmin` (Clerk org admin or owner role).
 */
export const POST = withAnyAuth<PromoteResponse, "/agent-components/promote">(
  async ({ user, clerkOrgId, clerkUserId }, request) => {
    const admin = await isOrgAdmin(clerkOrgId, clerkUserId);
    if (!admin) {
      return forbiddenResponse();
    }

    const { body, errorResponse: parseErr } = await parseBody(
      request,
      promoteSchema
    );
    if (parseErr) {
      return parseErr;
    }

    try {
      const result = await promoteAgentComponent({
        organizationId: user.organizationId,
        userId: user.id,
        agentComponentId: body.agentComponentId,
        name: body.name,
        description: body.description,
        targetKind: body.targetKind,
        sortOrder: body.sortOrder,
      });

      if (!result.ok) {
        if (result.reason === "not_promotable") {
          // Observable-only kinds (built-in Tool/Config) are inventory signals,
          // not distributable components (FEA-3048).
          return badRequestResponse(
            `A "${result.kind}" component is observable-only and cannot be promoted.`
          );
        }
        return notFoundResponse("AgentComponent");
      }

      return successResponse(result.response);
    } catch (error) {
      return errorResponse("Failed to promote agent component", error);
    }
  },
  { requiredScopes: ["write"] }
);
