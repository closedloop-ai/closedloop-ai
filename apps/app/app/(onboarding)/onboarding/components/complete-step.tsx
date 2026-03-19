"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Check, Loader2, PartyPopper } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCompleteWizard } from "@/hooks/queries/use-onboarding";

type CompleteStepProps = {
  readonly createdTeamName: string | null;
  readonly createdProjectName: string | null;
  readonly createdTeamId: string | null;
  readonly createdProjectId: string | null;
  readonly onComplete?: () => void;
};

export function CompleteStep({
  createdTeamName,
  createdProjectName,
  createdTeamId,
  createdProjectId,
  onComplete,
}: CompleteStepProps) {
  const router = useRouter();
  const completeWizard = useCompleteWizard();

  const handleFinish = async () => {
    await completeWizard.mutateAsync({
      createdTeamId: createdTeamId ?? undefined,
      createdProjectId: createdProjectId ?? undefined,
    });
    onComplete?.();
    router.push("/my-tasks");
  };

  return (
    <div className="flex flex-col items-center gap-6 py-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
        <PartyPopper className="h-8 w-8 text-primary" />
      </div>

      <div className="space-y-2">
        <h2 className="font-bold text-2xl">You&apos;re all set!</h2>
        <p className="text-muted-foreground">
          Your workspace is ready. Here&apos;s what we set up:
        </p>
      </div>

      <div className="w-full max-w-xs space-y-2">
        {createdTeamName && (
          <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-left text-sm">
            <Check className="h-4 w-4 shrink-0 text-green-500" />
            <span>
              Team: <span className="font-medium">{createdTeamName}</span>
            </span>
          </div>
        )}
        {createdProjectName && (
          <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-left text-sm">
            <Check className="h-4 w-4 shrink-0 text-green-500" />
            <span>
              Project: <span className="font-medium">{createdProjectName}</span>
            </span>
          </div>
        )}
      </div>

      <Button
        disabled={completeWizard.isPending}
        onClick={handleFinish}
        size="lg"
      >
        {completeWizard.isPending && (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        )}
        Go to My Tasks
      </Button>
    </div>
  );
}
