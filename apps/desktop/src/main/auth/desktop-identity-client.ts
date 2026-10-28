import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import { z } from "zod";
import {
  fetchSessionJson,
  type SessionFetchOptions,
} from "../util/api-response-utils.js";

/**
 * Fetches the signed-in user's display identity (name, email, organization
 * name and slug) from `GET /desktop/identity` for the desktop renderer.
 * Auth uses the current first-party desktop session token — the same token the
 * renderer attaches elsewhere — not the configured managed API key.
 *
 * Every transport, response, or schema failure returns null so the renderer
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
    // ISS-11465: the organization logo and user avatar the workspace menu
    // renders. Declared HERE and not only on `DesktopIdentity`, because
    // `.passthrough()` carries an undeclared key through untouched — the
    // annotation then says `string` while a number or an object reaches the
    // renderer and goes straight into an `<img src>`. Optional + nullable for
    // version skew, exactly as `organizationSlug` above.
    organizationImageUrl: z.string().nullable().optional(),
    userImageUrl: z.string().nullable().optional(),
  })
  // Pre-existing, and deliberately kept. It is NOT what admits the retired
  // `sessionSyncPolicyEnabled` / `sessionSyncPolicySupported` a server still
  // sends (ISS-11449 dropped both declarations): a bare `z.object` STRIPS unknown
  // keys rather than rejecting, so that body parses either way. What `.passthrough()` changes is
  // that unknown keys ride through untyped instead of being dropped. The contract
  // worth holding is the one it shares with a bare object — an unknown key must
  // never fail the whole parse, because a rejection returns `null` and blanks the
  // Account tab against a healthy server. Do not tighten this to `.strict()`.
  .passthrough();

export function fetchDesktopIdentity(
  options: DesktopIdentityFetchOptions
): Promise<DesktopIdentity | null> {
  return fetchSessionJson(options, "/desktop/identity", desktopIdentitySchema, {
    headers: { Accept: "application/json" },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
}
