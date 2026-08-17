"use client";

import {
  SessionFrustrationErrorState,
  SessionFrustrationLoadingState,
  SessionFrustrationToggleCard,
} from "@repo/app/settings/components/session-frustration-card";
import {
  useFrustrationSetting,
  useSetFrustrationSetting,
} from "@repo/app/settings/hooks/use-frustration-setting";

type SessionFrustrationCardProperties = {
  isAdmin: boolean;
};

/**
 * Data container for the admin-only opt-in to the session-frustration signal
 * (FEA-4022 / PLN-1481). When enabled, the desktop's per-session frustration
 * score is persisted to the cloud and a normalized "Frustration Over Time"
 * trend appears on the Insights dashboard. Off by default — the raw signal is
 * derived from prompt language and error spikes, so an org opts in explicitly.
 * The API enforces the same admin check before persisting.
 *
 * ISS-4668 moved the presentational cards to
 * `@repo/app/settings/components/session-frustration-card`, where each state
 * has a story; this wrapper owns the query and mutation.
 */
export function SessionFrustrationCard({
  isAdmin,
}: Readonly<SessionFrustrationCardProperties>) {
  const settingQuery = useFrustrationSetting();
  const setSetting = useSetFrustrationSetting();

  if (!isAdmin) {
    return null;
  }

  if (settingQuery.error) {
    return (
      <SessionFrustrationErrorState message={settingQuery.error.message} />
    );
  }

  // Hide the switch whenever the persisted value is still unknown — not only
  // the `isLoading` first-fetch, but also the TanStack v5 state where a paused
  // (e.g. offline) fetch leaves `data` absent with `isLoading` false. Rendering
  // a confidently-OFF switch in that window would be a lie on an opted-in
  // install, so we keep showing the loading state until real data arrives.
  if (settingQuery.data === undefined) {
    return <SessionFrustrationLoadingState />;
  }

  return (
    <SessionFrustrationToggleCard
      checked={settingQuery.data.calculateSessionFrustration ?? false}
      hasSaveError={setSetting.isError}
      isSaving={setSetting.isPending}
      onToggle={(checked: boolean) => setSetting.mutate(checked)}
    />
  );
}
