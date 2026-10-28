/**
 * @file The boundary validator for a `desktop:record-sync-consent` reply
 * (ISS-8346).
 *
 * Its own module and not part of `sync-consent-committed-level.ts`, which
 * exports a message constant a client surface imports: root `AGENTS.md` forbids
 * making a bundle-sensitive consumer pull Zod in for a string.
 *
 * The reply crosses the preload bridge, so the call site's type constrains
 * nothing about what actually lands. Awaiting it and testing it for `null` is
 * not enough — `{}` and `{ level: "bogus" }` both survive that test, and the
 * caller then advances the wizard reporting a choice as committed while
 * publishing an `organizationId` of `undefined` through a field its own type
 * declares as `string | null`.
 */

import { z } from "zod";

/**
 * A reply this build accepts as PROOF that main committed something.
 *
 * `level` is a bare string here and is narrowed afterwards by
 * `committedSyncConsentLevel`, for the same reason the ETA boundary keeps its
 * `kind` open: a newer main naming a level this build has not heard of has
 * still written to disk, and rejecting it here would report a successful write
 * as a failure and offer the user a retry they do not need.
 *
 * `organizationId` is what carries the weight. It is not optional — main sets
 * it from the authenticated session on every real commit, so a reply without it
 * is a husk from a broken or older bridge rather than a commit record, and it
 * is the one field a caller cannot recover from the request it already holds.
 */
const replySchema = z.looseObject({
  level: z.string(),
  organizationId: z.string().nullable(),
});

/** The two halves of a committed answer, as this boundary can vouch for them. */
export type CommittedSyncConsentReply = {
  level: string;
  organizationId: string | null;
};

/** The reply as a commit record, or `null` when it does not prove a write. */
export function committedSyncConsentReply(
  reply: unknown
): CommittedSyncConsentReply | null {
  const parsed = replySchema.safeParse(reply);
  if (!parsed.success) {
    return null;
  }
  return {
    level: parsed.data.level,
    organizationId: parsed.data.organizationId,
  };
}
