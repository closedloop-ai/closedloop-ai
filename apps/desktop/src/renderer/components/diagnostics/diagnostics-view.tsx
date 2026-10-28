import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { DIAGNOSTICS_COMPLETE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { DiagnosticsLegacyBody } from "./diagnostics-legacy-body";
import { DiagnosticsSurfaceHost } from "./diagnostics-surface-host";

/**
 * ISS-10004 — the desktop Diagnostics route's ONE flag read.
 *
 * The whole file is the gate and the choice between two siblings; neither
 * sibling knows the flag exists. `App.tsx` keeps importing `DiagnosticsView`, so
 * the hash route, the lazy chunk and the nav entry are untouched — `#/diagnostics`
 * lands here exactly as it did, which is what keeps the deep link preserved
 * rather than re-established.
 *
 * Default OFF, per the closed-by-default policy: an unresolved assignment reads
 * `false` and the reader gets the composition that shipped yesterday.
 */
export function DiagnosticsView({
  isActive = true,
}: Readonly<{ isActive?: boolean }>) {
  const completeSurfaceEnabled = useFeatureFlagEnabled(
    DIAGNOSTICS_COMPLETE_SURFACE_FEATURE_FLAG_KEY
  );

  return completeSurfaceEnabled ? (
    <DiagnosticsSurfaceHost isActive={isActive} />
  ) : (
    <DiagnosticsLegacyBody isActive={isActive} />
  );
}
