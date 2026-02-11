"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Label } from "@repo/design-system/components/ui/label";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Switch } from "@repo/design-system/components/ui/switch";
import { ContainerIcon, GithubIcon, Loader2Icon } from "lucide-react";
import {
  useComputeMode,
  useSetComputeMode,
} from "@/hooks/queries/use-compute-mode";

export function ComputeModeCard() {
  const { data, isLoading } = useComputeMode();
  const setComputeMode = useSetComputeMode();

  const useLoops = data?.computeMode === "LOOPS";

  const handleToggle = async (checked: boolean) => {
    try {
      await setComputeMode.mutateAsync(checked ? "LOOPS" : "GITHUB_ACTIONS");
      toast.success(
        checked ? "Switched to Container Mode" : "Switched to GitHub Actions"
      );
    } catch {
      toast.error("Failed to update compute mode");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ContainerIcon className="h-5 w-5" />
          Compute Mode
        </CardTitle>
        <CardDescription>
          Choose how AI agent loops are executed. GitHub Actions is the default;
          container mode uses dedicated ECS containers for faster, isolated
          execution.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {useLoops ? (
                <ContainerIcon className="h-5 w-5 text-blue-600" />
              ) : (
                <GithubIcon className="h-5 w-5" />
              )}
              <div>
                <Label className="font-medium" htmlFor="compute-mode">
                  {useLoops ? "Container Mode (Loops)" : "GitHub Actions"}
                </Label>
                <p className="text-muted-foreground text-xs">
                  {useLoops
                    ? "Runs in dedicated ECS containers with real-time streaming"
                    : "Runs via GitHub Actions workflows"}
                </p>
              </div>
            </div>
            <Switch
              checked={useLoops}
              disabled={setComputeMode.isPending}
              id="compute-mode"
              onCheckedChange={handleToggle}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
