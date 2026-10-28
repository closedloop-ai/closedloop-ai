/**
 * The PostHog key gating the Desktop update-and-restart command.
 *
 * Shared rather than app-local because BOTH halves of the same gate read it and
 * they must agree: `apps/app` hides the Update-and-restart button behind it, and
 * `apps/api` admits or 403s the command behind it (classified as a GRANT in
 * `apps/api/lib/feature-flags/server-feature-flags.ts`). It lived as two
 * independent string literals until ISS-7778, so a rename on either side would
 * have left the button visible against a route that refuses it, or hidden
 * against a route that still allows it — with nothing failing to say so.
 */
export const ELECTRON_REMOTE_UPDATE_FLAG_KEY =
  "electron-remote-update" as const;
