import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { evaluateServerFeatureFlagForOrganization } from "@/lib/feature-flags/server-feature-flag-evaluation";
import { DOCUMENT_UNIFIED_COMMENTS_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";

/**
 * PLN-2187 T-2.6: whether an organization's document comments are written to
 * Postgres. `document-unified-comments` is read for the org's PostHog group
 * alone, so the answer never differs between its members. The first `true`
 * is latched on the organization row and wins over every later lookup: an
 * unanswered lookup reads false, and must not send a switched org back to
 * Liveblocks (tamsinb, #8828). The latch goes with the flag when C19 retires
 * the server Liveblocks path (ISS-11216).
 */
export async function resolveAndLatchDocumentCommentsSwitch(
  organizationId: string
): Promise<boolean> {
  const organization = await withDb((db) =>
    db.organization.findUnique({
      where: { id: organizationId },
      select: { clerkId: true, documentCommentsSwitchedAt: true },
    })
  );
  if (!organization) {
    return false;
  }
  if (organization.documentCommentsSwitchedAt) {
    return true;
  }
  const enabled = await evaluateServerFeatureFlagForOrganization(
    DOCUMENT_UNIFIED_COMMENTS_SERVER_FLAG,
    organization.clerkId
  );
  if (enabled !== true) {
    return false;
  }
  const latched = await withDb((db) =>
    db.organization.updateMany({
      where: { id: organizationId, documentCommentsSwitchedAt: null },
      data: { documentCommentsSwitchedAt: new Date() },
    })
  );
  // The latch is one-way, so the write that sets it is the record of when an
  // org switched; a racing lookup that finds it set logs nothing.
  if (latched.count === 1) {
    log.info(DOCUMENT_COMMENTS_SWITCH_LATCHED_EVENT, {
      event: DOCUMENT_COMMENTS_SWITCH_LATCHED_EVENT,
      organizationId,
      flagKey: DOCUMENT_UNIFIED_COMMENTS_SERVER_FLAG.key,
    });
  }
  return true;
}

/** Logged once per org, by the lookup whose write latched its switch. */
export const DOCUMENT_COMMENTS_SWITCH_LATCHED_EVENT =
  "comments.document_switch_latched";

/**
 * Whether the org's switch is already latched, read from the organization row
 * alone: no flag evaluation and no write, so a reader that must not latch
 * (the Liveblocks webhook) cannot switch an org. The latch is set only by
 * `resolveAndLatchDocumentCommentsSwitch`.
 */
export async function isDocumentCommentsSwitchLatched(
  organizationId: string
): Promise<boolean> {
  const organization = await withDb((db) =>
    db.organization.findUnique({
      where: { id: organizationId },
      select: { documentCommentsSwitchedAt: true },
    })
  );
  return Boolean(organization?.documentCommentsSwitchedAt);
}
