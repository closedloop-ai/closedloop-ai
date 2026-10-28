import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { loopsRemovedResponse } from "@/lib/loops-removed-response";

/**
 * ISS-12435 (PRD-795): Loops are removed. This route is a 410 tombstone
 * (`apps/api/AGENTS.md`) for installed Desktop builds, stale browser bundles
 * and `sk_live_*` integrations that can still call it.
 */
export const GET = withAnyAuth<never, "/settings/api-keys">(() =>
  Promise.resolve(loopsRemovedResponse())
);
