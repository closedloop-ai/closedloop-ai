import "server-only";

import { handleBootstrapClaim } from "./service";

/**
 * Desktop-facing route for exchanging a validated onboarding attempt for a
 * desktop-managed API key.
 */
export function POST(request: Request) {
  return handleBootstrapClaim(request);
}
