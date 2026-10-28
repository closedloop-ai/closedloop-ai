import "server-only";

import { log } from "@repo/observability/log";

/**
 * @file clerk-timestamp-gap-log.ts
 * @description The one place a Members read reports that Clerk handed it a
 * timestamp with no representable instant behind it (ISS-9083).
 *
 * `clerkEpochToIso` answers such a value with `null` so one bad row cannot take
 * the page down with it. That is the right answer for the caller and the wrong
 * one for us on its own — a field silently reading "unknown" for every member
 * would look exactly like a provider that changed its payload. So the gap is
 * reported here, from the service, which is the layer that knows WHICH
 * organization was read and which provider rows were affected.
 */

/** Structured event name for the timestamp-gap monitor (root `AGENTS.md`). */
const CLERK_TIMESTAMP_GAP_EVENT =
  "organization_clerk_timestamp_unrepresentable";

/**
 * Provider rows named in one line. A page can carry
 * `ORGANIZATION_MEMBERS_PAGE_LIMIT_MAX` rows and any authenticated member can
 * request one, so an uncapped id list is an amplification vector: the count is
 * always exact, the naming is bounded.
 */
const MAX_NAMED_ROWS = 10;

/** Which Members read the gap was found in. */
export const ClerkTimestampResource = {
  Memberships: "organization_memberships",
  Invitations: "organization_invitations",
} as const;

export type ClerkTimestampResource =
  (typeof ClerkTimestampResource)[keyof typeof ClerkTimestampResource];

/**
 * Report a page's unrepresentable timestamps — ONCE for the page, never once
 * per row, and not at all when the page was clean.
 */
export function logClerkTimestampGaps(params: {
  clerkOrgId: string;
  resource: ClerkTimestampResource;
  affectedRowIds: readonly string[];
}): void {
  if (params.affectedRowIds.length === 0) {
    return;
  }

  // Server runtime, so this routes to the existing structured-log monitor
  // rather than being coerced away silently (root `AGENTS.md`).
  log.warn(CLERK_TIMESTAMP_GAP_EVENT, {
    clerkOrgId: params.clerkOrgId,
    resource: params.resource,
    affectedRows: params.affectedRowIds.length,
    rowIds: params.affectedRowIds.slice(0, MAX_NAMED_ROWS),
    rowIdsTruncated: params.affectedRowIds.length > MAX_NAMED_ROWS,
  });
}
