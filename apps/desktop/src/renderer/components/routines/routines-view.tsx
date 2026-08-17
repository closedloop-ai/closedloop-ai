/**
 * Desktop Routines view (PRD-566 / FEA-4348; formerly "Scheduled Tasks",
 * FEA-3852/3853/3854 / PRD-553).
 *
 * Mounts the shared `@repo/app/routines` slice (routine list + create/edit modal
 * + run-history drawer with the cascade trail) and adapts
 * `window.desktopApi.scheduledTasks.*` (that IPC channel name is the preserved,
 * version-skew-safe wire contract) into the slice's surface-agnostic
 * {@link RoutinesDataSource}. The shared view owns its own load/empty state and
 * re-fetches on the scheduler's change push, so this wrapper is a thin
 * data-source adapter plus the page chrome.
 *
 * Flag guard: returns null immediately when the `routines` flag is off. This
 * mirrors the desktop gate pattern (`hiddenNavIds` hides the nav entry; this
 * render-time null guard prevents direct hash navigation from landing here when
 * the flag is off, matching AgentsView).
 */

import {
  type RoutinesDataSource,
  RoutinesView as SharedRoutinesView,
} from "@repo/app/routines/components/routines-view";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useMemo } from "react";
import { DESKTOP_ROUTINES_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import { PageShell } from "../layout/page-shell";

export function RoutinesView({
  dataSource,
}: {
  /** Test seam; overrides the `window.desktopApi.scheduledTasks` adapter. */
  dataSource?: RoutinesDataSource;
} = {}) {
  const flagOn = useFeatureFlagEnabled(DESKTOP_ROUTINES_FEATURE_FLAG_KEY);

  // The default source bridges the preload IPC. Memoized so the shared view's
  // load/subscribe effects don't re-run every render on a fresh object identity.
  const desktopSource = useMemo<RoutinesDataSource>(
    () => ({
      list: () => window.desktopApi.scheduledTasks.list(),
      runs: (request) => window.desktopApi.scheduledTasks.runs(request),
      create: (payload) => window.desktopApi.scheduledTasks.create(payload),
      update: (payload) => window.desktopApi.scheduledTasks.update(payload),
      delete: (id) => window.desktopApi.scheduledTasks.delete(id),
      toggle: (id, enabled) =>
        window.desktopApi.scheduledTasks.toggle(id, enabled),
      runNow: (id) => window.desktopApi.scheduledTasks.runNow(id),
      previewSchedule: (request) =>
        window.desktopApi.scheduledTasks.previewSchedule(request),
      onChanged: (callback) =>
        window.desktopApi.scheduledTasks.onChanged(callback),
    }),
    []
  );

  if (!flagOn) {
    return null;
  }

  return (
    <PageShell
      description="Your routines with their next run, last run, and status. Open a routine's history to see each step of a run."
      fullWidth
      title="Routines"
    >
      <SharedRoutinesView dataSource={dataSource ?? desktopSource} />
    </PageShell>
  );
}
