import type { DesktopIdentity } from "@repo/api/src/types/desktop-identity";
import { z } from "zod";
import {
  fetchSessionJson,
  type SessionFetchOptions,
} from "./api-response-utils.js";

/**
 * Fetches the signed-in user's display identity (name, email, organization
 * name) from `GET /desktop/identity` for the desktop Settings → Account tab.
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
