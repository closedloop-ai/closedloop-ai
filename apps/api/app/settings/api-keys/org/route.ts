import { withAuth } from "@/lib/auth/with-auth";
import { loopsRemovedResponse } from "@/lib/loops-removed-response";

/**
 * ISS-12435 (PRD-795): Loops are removed. This route is a 410 tombstone
 * (`apps/api/AGENTS.md`) for installed Desktop builds, stale browser bundles
 * and `sk_live_*` integrations that can still call it.
 */
export const PUT = withAuth<never, "/settings/api-keys/org">(() =>
  Promise.resolve(loopsRemovedResponse())
);

export const DELETE = withAuth<never, "/settings/api-keys/org">(() =>
  Promise.resolve(loopsRemovedResponse())
);
