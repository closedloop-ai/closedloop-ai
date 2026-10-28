/**
 * ISS-10005 — the desktop Help route's flag reads, and nothing else.
 *
 * ISS-9731 — the DESTINATION gate moved to the shell. Whether Help is reachable
 * on this build is decided at the route, from the gate the shared navigation
 * contract declares for this surface, so a closed gate answers with the shared
 * `LabsPageUnavailable` panel rather than mounting this view to render `null`.
 * The capability is unchanged; only what a withheld route SHOWS is.
 *
 * `help-complete-surface` is the one flag this file still reads, and it only
 * picks WHICH body renders, default OFF, so an unresolved assignment gives the
 * reader yesterday's composition. Neither sibling knows it exists, and
 * `App.tsx` still imports `HelpView`, so the route, lazy chunk, nav entry and
 * deep link are unchanged.
 */
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { HELP_COMPLETE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { HelpLegacyBody } from "./help-legacy-body";
import { HelpSurfaceHost } from "./help-surface-host";

export function HelpView() {
  const completeSurfaceEnabled = useFeatureFlagEnabled(
    HELP_COMPLETE_SURFACE_FEATURE_FLAG_KEY
  );

  return completeSurfaceEnabled ? <HelpSurfaceHost /> : <HelpLegacyBody />;
}
