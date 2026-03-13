import "server-only";

import { isTrustedOrigin } from "@/lib/trusted-origins";

/**
 * Local gateway exchanges are allowed for the same browser origins we already
 * trust for app traffic. Examples:
 * - http://localhost:3000
 * - https://app-stage.preview.closedloop-stage.ai
 * - https://app-stage-git-my-branch-closed-loop.vercel.app
 */
export function isLocalGatewayOriginAllowed(origin: string): boolean {
  return isTrustedOrigin(origin);
}
