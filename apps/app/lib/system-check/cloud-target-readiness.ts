"use client";

import { ComputePreference } from "@repo/api/src/types/compute-target";
import { z } from "zod";

/**
 * PostHog flag gating the Cloud branch of the pre-loop system check.
 * Default off: with the flag off the Cloud branch keeps its historical
 * behaviour of dispatching without a pre-flight check.
 */
export const CLOUD_TARGET_VALIDATION_FEATURE_FLAG_KEY =
  "cloud-compute-target-validation";

/**
 * Whether a Cloud compute target can actually run the requested command.
 *
 * `Unknown` means the gate could not determine readiness (the readiness lookup
 * failed, or the API answered a shape this client does not recognise). It is a
 * deliberate third state rather than a failure: a version-skewed or briefly
 * unreachable API must not block a command the server may well accept.
 */
export const CloudTargetReadiness = {
  Ready: "ready",
  MissingApiKey: "missing_api_key",
  Unknown: "unknown",
} as const;
export type CloudTargetReadiness =
  (typeof CloudTargetReadiness)[keyof typeof CloudTargetReadiness];

/** Stable reason strings reported to analytics when the Cloud gate blocks. */
export const CloudTargetUnavailableReason = {
  MissingApiKey: "cloud_missing_anthropic_api_key",
} as const;
export type CloudTargetUnavailableReason =
  (typeof CloudTargetUnavailableReason)[keyof typeof CloudTargetUnavailableReason];

/**
 * Reported when the gate could not determine readiness and therefore let the
 * command through. It is NOT a block — it is emitted so a systemic failure of
 * the readiness lookup is visible instead of silently disabling the gate for
 * everyone. Filter the analytics funnel on this reason to tell "the check
 * passed" apart from "the check never ran".
 */
export const CLOUD_READINESS_UNKNOWN_REASON = "cloud_readiness_unknown";

/**
 * Toast copy split the way every other blocked-gate toast in the pre-loop
 * provider is: a short title plus a description. A single paragraph in the
 * title slot made one class of event (`blocked_unavailable` +
 * `SystemCheckUnavailable`) read as two different things depending on which
 * branch blocked you.
 */
export type CloudTargetUnavailableCopy = {
  title: string;
  description: string;
};

/**
 * Canonical user-facing copy for each blocking Cloud readiness reason.
 *
 * Deliberately paired with `MISSING_ANTHROPIC_API_KEY_MESSAGE` in
 * `apps/api/lib/loops/loop-dispatch-utils.ts`, which reports the same condition
 * on the server side of the app/api boundary. Change one, change the other.
 *
 * The two say the same thing but not the same words, on purpose. The server
 * message is a bare 400 body with no affordance attached, so it has to carry
 * the wayfinding itself ("Add one in Settings, under Integrations"). This toast
 * ships an action button that performs exactly that navigation, so repeating
 * the route in the description would say it twice and leave the description
 * with nothing of its own to add; it carries the reason and the alternative
 * instead.
 *
 * The key lives on the Settings **Integrations** tab (the `Anthropic API Key`
 * card, right under `Local compute targets`), NOT on the `API Keys` tab — that
 * one holds Closedloop platform `sk_live_` keys. Naming the wrong tab sent a
 * blocked user to a screen with no Anthropic field on it, so the action's
 * destination — not the prose — is now the thing that must stay correct.
 */
export const CloudTargetUnavailableMessage: Record<
  CloudTargetUnavailableReason,
  CloudTargetUnavailableCopy
> = {
  [CloudTargetUnavailableReason.MissingApiKey]: {
    title: "Cloud runs need an Anthropic API key",
    description:
      "No key is set for you or your org, so the command didn't start. You can also switch to a local compute target.",
  },
};

/**
 * Label on the toast's action button. Names the fix rather than the
 * destination: "Open settings" described the mechanism and left the user to
 * work out what they were meant to do once they arrived.
 *
 * Lives beside the rest of the toast copy so the button, the title, and the
 * description are read and changed as one piece of writing.
 */
export const CLOUD_TARGET_UNAVAILABLE_ACTION_LABEL = "Add API key";

/**
 * How long the Cloud block stays on screen, in milliseconds.
 *
 * Sonner's 4s default is sized for an acknowledgement, not for this: the toast
 * is the ONLY place a user finds out why nothing happened, and it asks them to
 * read a title and a two-clause description and then decide whether to press a
 * button. Title plus description is roughly thirty words — about eight seconds
 * of reading before any of the deciding starts — so 4s can expire before the
 * user has finished the sentence explaining the thing that just failed.
 *
 * Long, but still self-dismissing: a toast that never leaves becomes its own
 * problem, and the same message is available from the server's 400 if the user
 * simply tries again.
 */
export const CLOUD_TARGET_UNAVAILABLE_TOAST_DURATION_MS = 12_000;

/**
 * Presence half of `GET /settings/api-keys`. Intentionally non-strict and
 * narrowed to the two booleans this gate depends on, so additive fields from a
 * newer API do not make the whole payload unparseable.
 */
const cloudApiKeyPresenceSchema = z.object({
  org: z.object({ isSet: z.boolean() }),
  user: z.object({ isSet: z.boolean() }),
});

/**
 * Decides whether a Cloud target is usable from the org/user API-key presence
 * the API reports.
 *
 * This mirrors the server's own precondition: the loop orchestrator resolves a
 * user key first and falls back to the org key, so a Cloud launch succeeds
 * exactly when at least one of the two is set. Anything we cannot parse
 * degrades to `Unknown` rather than a guess in either direction.
 */
export function evaluateCloudTargetReadiness(
  payload: unknown
): CloudTargetReadiness {
  const parsed = cloudApiKeyPresenceSchema.safeParse(payload);
  if (!parsed.success) {
    return CloudTargetReadiness.Unknown;
  }
  return parsed.data.user.isSet || parsed.data.org.isSet
    ? CloudTargetReadiness.Ready
    : CloudTargetReadiness.MissingApiKey;
}

/**
 * Maps a readiness verdict to the reason a Cloud attempt must be blocked, or
 * `null` when the attempt may proceed. `Unknown` proceeds on purpose: the gate
 * only blocks on positive evidence that the launch would fail.
 */
export function getCloudTargetBlockingReason(
  readiness: CloudTargetReadiness
): CloudTargetUnavailableReason | null {
  return readiness === CloudTargetReadiness.MissingApiKey
    ? CloudTargetUnavailableReason.MissingApiKey
    : null;
}

/**
 * Whether an attempt that resolved no local compute target did so because the
 * user actually selected Cloud.
 *
 * This distinction matters: the gate's no-local-target branch is also reached
 * by a **Local**-preference user whose desktop app is simply offline (the
 * effective-selection helper yields no target when nothing is online). Showing
 * that user "Cloud runs need an Anthropic API key" would blame the wrong thing
 * and hide the accurate "no online compute targets" answer the server already
 * gives — the exact wrong-blame failure this ticket set out to remove.
 */
export function isCloudComputeSelection({
  requestedComputeTargetId,
  preferredComputeMode,
}: {
  requestedComputeTargetId: string | null | undefined;
  preferredComputeMode: string | undefined;
}): boolean {
  if (requestedComputeTargetId === null) {
    return true;
  }
  if (requestedComputeTargetId !== undefined) {
    return false;
  }
  return preferredComputeMode === ComputePreference.Cloud;
}
