import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import { z } from "zod";
import {
  fetchSessionJson,
  type SessionFetchOptions,
} from "../util/api-response-utils.js";

/**
 * Fetches the signed-in user's display identity (name, email, organization
 * name and slug) from `GET /desktop/identity` for the desktop Settings → Account tab.
 * Auth uses the current first-party desktop session token — the same token the
 * renderer attaches elsewhere — not the configured managed API key.
 *
 * Every transport, response, or schema failure returns null so the Account tab
 * falls back to the ids it already holds instead of trusting malformed data.
 */
export type DesktopIdentityFetchOptions = SessionFetchOptions;

const REQUEST_TIMEOUT_MS = 10_000;

const desktopIdentitySchema = z
  .object({
    userId: z.string(),
    organizationId: z.string(),
    email: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    organizationName: z.string().nullable(),
    // ISS-4898: the org slug the web app's artifact routes are scoped by, used
    // by the renderer to open a linked artifact in the browser. Optional for
    // version skew: an old server omits it and the pills stay inert. Nullable
    // too, so a server that ever does send an explicit null is not a whole-
    // payload rejection.
    organizationSlug: z.string().nullable().optional(),
    // FEA-4169: server-owned org sync policy (the OUTER gate above per-device
    // consent). Optional for version skew: an old server omits it, and the
    // desktop treats "absent" as "no policy → keep current device-consent
    // behavior". A new server always sends an explicit boolean.
    sessionSyncPolicyEnabled: z.boolean().optional(),
    // ISS-4705: versioned capability marker. A current server that understands
    // the org-sync policy always sends `true`; an old server omits it. The store
    // uses it to tell an old server (marker absent → skew degrade) apart from a
    // buggy current server that dropped only `sessionSyncPolicyEnabled` (marker
    // present → fail closed) — presence of the policy field alone cannot.
    sessionSyncPolicySupported: z.boolean().optional(),
  })
  .passthrough();

export function fetchDesktopIdentity(
  options: DesktopIdentityFetchOptions
): Promise<DesktopIdentity | null> {
  return fetchSessionJson(options, "/desktop/identity", desktopIdentitySchema, {
    headers: { Accept: "application/json" },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
}
