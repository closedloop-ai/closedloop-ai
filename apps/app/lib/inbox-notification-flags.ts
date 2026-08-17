/**
 * Frontend-only PostHog feature-flag keys for the Inbox surface.
 *
 * Kept in `apps/app` rather than `packages/app/shared/lib/feature-flags.ts`
 * because the Inbox is an `apps/app` surface only. `apps/desktop` has no
 * notification inbox (its `InboxIcon` nav entry is the unrelated gateway
 * "Requests" page), so nothing outside this app reads the key.
 */

/**
 * ISS-5010: gates the actor-led inbox notification rows: the assigning or
 * mentioning person's avatar and name, with the row's headline leading on them
 * instead of the identical "You were assigned to artifact" preamble that every
 * assignment row otherwise shares.
 *
 * Defaults OFF per the closed-by-default UI policy (ISS-4779). No desktop Labs
 * counterpart exists because the surface has no desktop analogue.
 */
export const INBOX_NOTIFICATION_ACTOR_FEATURE_FLAG_KEY =
  "inbox-notification-actor" as const;
