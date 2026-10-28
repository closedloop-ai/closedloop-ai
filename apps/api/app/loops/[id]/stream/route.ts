import { withAuth } from "@/lib/auth/with-auth";
import { loopsRemovedResponse } from "@/lib/loops-removed-response";

/**
 * ISS-12435 (PRD-795): Loops are removed. This route is a 410 tombstone
 * (`apps/api/AGENTS.md`) for installed Desktop builds, stale browser bundles
 * and `sk_live_*` integrations that can still call it. It keeps the Clerk-only
 * auth it had before (PLN-2182 v3).
 */
export const GET = withAuth<never, "/loops/[id]/stream">(() =>
  Promise.resolve(loopsRemovedResponse())
);
