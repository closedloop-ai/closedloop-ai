import "server-only";

import type { DesktopManagedKeyProvisionResponse } from "@/app/desktop/contract";
import { withDesktopSessionAuth } from "@/lib/auth/with-desktop-session-auth";
import { handleManagedKeyProvision } from "./service";

/**
 * POST /desktop/managed-key/provision (PRD-532 §5.5, PR-K / M8)
 *
 * Session-authenticated provisioning of the DESKTOP_MANAGED relay `sk_live_*`
 * key bound to the device PoP public key. Requires a first-party desktop
 * session (`withDesktopSessionAuth`) — never an API key or Clerk session — so a
 * managed key can only be minted for a device that holds a live session and can
 * prove possession of its bound private key via the PoP signature. Org/user come
 * from the verified session; see the service for the full binding/PoP contract.
 */
export const POST = withDesktopSessionAuth<
  DesktopManagedKeyProvisionResponse,
  "/desktop/managed-key/provision"
>((authContext, request) => handleManagedKeyProvision(authContext, request));
