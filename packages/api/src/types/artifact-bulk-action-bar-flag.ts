/**
 * The flag key gating the artifact bulk action rail on the project
 * all-artifacts surface (ISS-9329, under the ISS-4779 closed-by-default UI
 * policy). Default OFF: with it closed the project selection bar renders
 * exactly the controls it renders today.
 *
 * Read at ONE site — `DocumentsSelectionBar` — which picks between two whole
 * bar shapes rather than threading a boolean into each control, so a rollout
 * cannot leave half the bar on the rail and half on the old chrome.
 *
 * The surface is `apps/app`-only: the project route lives under
 * `apps/app/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]`
 * and the desktop renderer mounts no path that reaches it. One PostHog key is
 * still the whole gate — there is no desktop registry entry to add alongside
 * it, since `DesktopFeatureFlagProvider` resolves the signed-in account's
 * PostHog assignment and nothing else.
 */
export const ARTIFACT_BULK_ACTION_BAR_FLAG_KEY =
  "artifact-bulk-action-bar" as const;
