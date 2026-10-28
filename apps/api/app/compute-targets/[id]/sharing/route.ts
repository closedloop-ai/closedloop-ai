import { ComputeTargetSharingEndpointRemoval } from "@repo/api/src/types/endpoint-removal";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { goneResponse } from "@/lib/route-utils";

/**
 * PATCH /compute-targets/:id/sharing
 *
 * Compatibility tombstone (ISS-12617). Sharing a compute target with the
 * organization is retired: the only consumer that dispatched to a teammate's
 * machine was the deleted Loop resolver (#8800). The route was `withAnyAuth`,
 * so a web tab opened before the deploy or an `sk_live_*` integration can
 * still call it; keep the path and its auth shape and answer 410
 * (`apps/api/AGENTS.md`) without writing anything.
 */
export const PATCH = withAnyAuth<never, "/compute-targets/[id]/sharing">(() =>
  Promise.resolve(
    goneResponse(ComputeTargetSharingEndpointRemoval.Message, {
      code: ComputeTargetSharingEndpointRemoval.Code,
    })
  )
);
