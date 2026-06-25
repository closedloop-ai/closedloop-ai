"use client";

import {
  ComputePreference,
  EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY,
} from "@repo/api/src/types/compute-target";
import { ComputePreferenceCard } from "@repo/app/compute/components/compute-preference-card";
import {
  useComputePreference,
  useSetComputePreference,
} from "@repo/app/compute/hooks/use-compute-preference";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useUser } from "@repo/auth/client";
import { CloudIcon, ContainerIcon } from "lucide-react";

export function CloudComputeModeCard() {
  const { user } = useUser();
  const userId = user?.id ?? "";
  const { data, isLoading } = useComputePreference(userId);
  const setPreference = useSetComputePreference(userId);
  const requireExplicitSelection = useFeatureFlagEnabled(
    EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY
  );

  const currentMode =
    requireExplicitSelection && data?.isExplicit !== true
      ? undefined
      : (data?.preferredComputeMode ?? ComputePreference.Cloud);

  function handleChange(value: string): void {
    setPreference.mutate({ mode: value as ComputePreference });
  }

  return (
    <ComputePreferenceCard
      description="Choose where AI agent jobs run. Cloud uses Closedloop infrastructure. Local routes jobs to your registered desktop agent."
      disabled={setPreference.isPending}
      headerIcon={<ContainerIcon className="h-5 w-5" />}
      isLoading={isLoading}
      onValueChange={handleChange}
      options={[
        {
          value: ComputePreference.Cloud,
          label: "Cloud",
          description:
            "Runs in dedicated ECS containers with real-time streaming",
          icon: <CloudIcon className="h-4 w-4 text-info" />,
        },
        {
          value: ComputePreference.Local,
          label: "Local",
          description: "Runs on your registered desktop agent",
          icon: <ContainerIcon className="h-4 w-4" />,
        },
      ]}
      title="Compute Mode"
      value={currentMode}
    />
  );
}
