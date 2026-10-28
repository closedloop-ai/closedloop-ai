import "server-only";

import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { handleBootstrapClaim } from "./service";

/**
 * Desktop-facing route for exchanging a validated onboarding attempt for a
 * desktop-managed API key.
 */
function handlePost(request: Request) {
  return handleBootstrapClaim(request);
}

export const POST = withRequestCompleted(handlePost);
