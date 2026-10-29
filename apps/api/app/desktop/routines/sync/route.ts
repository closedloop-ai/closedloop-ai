import { RoutinesEndpointRemoval } from "@repo/api/src/types/endpoint-removal";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { badRequestResponse } from "@/lib/route-utils";

/**
 * PRD-797 FR-6: kept until the minimum supported Desktop no longer sends it
 * (PRD-797 Q-002). Why 400 and not 410: `RoutinesEndpointRemoval`.
 */
export const POST = withAnyAuth<never, "/desktop/routines/sync">(() =>
  Promise.resolve(
    badRequestResponse(RoutinesEndpointRemoval.Message, {
      code: RoutinesEndpointRemoval.Code,
    })
  )
);
