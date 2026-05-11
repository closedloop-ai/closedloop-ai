"use client";

import {
  ComputePreference,
  EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY,
} from "@repo/api/src/types/compute-target";
import { useUser } from "@repo/auth/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Label } from "@repo/design-system/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import { CloudIcon, ContainerIcon, Loader2Icon } from "lucide-react";
import {
  useComputePreference,
  useSetComputePreference,
} from "@/hooks/queries/use-compute-preference";
import { useFeatureFlagEnabled } from "@/hooks/use-feature-flag-enabled";

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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ContainerIcon className="h-5 w-5" />
          Compute Mode
        </CardTitle>
        <CardDescription>
          Choose where AI agent jobs run. Cloud uses ClosedLoop infrastructure.
          Local routes jobs to your registered desktop agent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <RadioGroup
            className="gap-3"
            disabled={setPreference.isPending}
            onValueChange={handleChange}
            value={currentMode ?? ""}
          >
            <div className="flex items-center gap-3">
              <RadioGroupItem
                id="compute-cloud"
                value={ComputePreference.Cloud}
              />
              <Label
                className="flex cursor-pointer items-center gap-2"
                htmlFor="compute-cloud"
              >
                <CloudIcon className="h-4 w-4 text-blue-600" />
                <div>
                  <span className="font-medium">Cloud</span>
                  <p className="text-muted-foreground text-xs">
                    Runs in dedicated ECS containers with real-time streaming
                  </p>
                </div>
              </Label>
            </div>
            <div className="flex items-center gap-3">
              <RadioGroupItem
                id="compute-local"
                value={ComputePreference.Local}
              />
              <Label
                className="flex cursor-pointer items-center gap-2"
                htmlFor="compute-local"
              >
                <ContainerIcon className="h-4 w-4" />
                <div>
                  <span className="font-medium">Local</span>
                  <p className="text-muted-foreground text-xs">
                    Runs on your registered desktop agent
                  </p>
                </div>
              </Label>
            </div>
          </RadioGroup>
        )}
      </CardContent>
    </Card>
  );
}
