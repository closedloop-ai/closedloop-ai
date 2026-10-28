import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { loopsRemovedResponse } from "@/lib/loops-removed-response";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";

/**
 * ISS-12435 (PRD-795): Loops are removed. This route is a 410 tombstone
 * (`apps/api/AGENTS.md`) for installed Desktop builds, stale browser bundles
 * and `sk_live_*` integrations that can still call it.
 */
export const GET = withAnyAuth<never, "/loops/[id]/events">(() =>
  Promise.resolve(loopsRemovedResponse())
);

export const POST = withRequestCompleted(() => loopsRemovedResponse());
