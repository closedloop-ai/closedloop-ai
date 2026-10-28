import type { AgentComponentFrequency } from "@repo/api/src/types/agent-component";
import { z } from "zod";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { decodeDetailRouteKey } from "../../content-hash-identity";
import { readComponentFrequency } from "../../service/component-frequency";

const querySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).default(30),
});

export const GET = withAnyAuth<
  AgentComponentFrequency,
  "/agent-components/[slug]/frequency"
>(
  async ({ user }, request, params) => {
    const parsed = parseQueryParams(request, querySchema);
    if (parsed.errorResponse) {
      return parsed.errorResponse;
    }
    const { slug } = await params;
    if (!decodeDetailRouteKey(slug)) {
      return notFoundResponse("AgentComponent");
    }
    try {
      return successResponse(
        await readComponentFrequency(
          user.organizationId,
          slug,
          parsed.params.windowDays
        )
      );
    } catch (error) {
      return errorResponse("Failed to fetch agent component", error);
    }
  },
  { requiredScopes: ["read"] }
);
