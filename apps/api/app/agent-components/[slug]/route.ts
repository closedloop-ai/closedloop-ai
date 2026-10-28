import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { agentComponentsService } from "../service";

export const GET = withAnyAuth<
  AgentComponentDetail,
  "/agent-components/[slug]"
>(
  async ({ user }, _, params) => {
    try {
      // Next's route matcher already `decodeURIComponent`s every captured
      // segment, so `slug` arrives decoded. Decoding again corrupts a slug
      // containing a literal `%` (`skill::a%20b` -> `skill::a b`) or throws.
      const { slug } = await params;
      const detail = await agentComponentsService.getDetailForOrg(
        user.organizationId,
        slug,
        { userId: user.id, clerkUserId: user.clerkId }
      );
      if (!detail) {
        return notFoundResponse("AgentComponent");
      }
      return successResponse(detail);
    } catch (error) {
      return errorResponse("Failed to fetch agent component", error);
    }
  },
  { requiredScopes: ["read"] }
);
