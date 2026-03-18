"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Progress } from "@repo/design-system/components/ui/progress";
import { Check, Circle, X } from "lucide-react";
import Link from "next/link";
import {
  useDismissChecklist,
  useOnboardingStatus,
} from "@/hooks/queries/use-onboarding";

export function OnboardingChecklist() {
  const { data: status } = useOnboardingStatus();
  const dismissChecklist = useDismissChecklist();

  // Don't render if wizard not completed, checklist dismissed, or still loading
  if (!status?.wizardCompleted || status.checklistDismissed) {
    return null;
  }

  const completedCount = status.checklist.filter(
    (item) => item.completed
  ).length;
  const totalCount = status.checklist.length;
  const progressPercent = Math.round((completedCount / totalCount) * 100);

  // Don't render if all items are completed
  if (completedCount === totalCount) {
    return null;
  }

  const handleDismiss = () => {
    dismissChecklist.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Complete Your Setup</CardTitle>
        <CardDescription>
          {completedCount} of {totalCount} tasks completed
        </CardDescription>
        <CardAction>
          <Button
            className="h-8 w-8 text-muted-foreground"
            onClick={handleDismiss}
            size="icon"
            variant="ghost"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Dismiss</span>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress value={progressPercent} />

        <div className="space-y-1">
          {status.checklist.map((item) => (
            <ChecklistItem
              completed={item.completed}
              description={item.description}
              href={item.href}
              key={item.id}
              label={item.label}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

type ChecklistItemProps = {
  readonly label: string;
  readonly description: string;
  readonly completed: boolean;
  readonly href?: string;
};

function ChecklistItem({
  label,
  description,
  completed,
  href,
}: ChecklistItemProps) {
  const content = (
    <div className="flex items-start gap-3 rounded-md px-2 py-2 transition-colors hover:bg-muted/50">
      {completed ? (
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
      ) : (
        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/40" />
      )}
      <div className="min-w-0">
        <p
          className={`text-sm ${
            completed ? "text-muted-foreground line-through" : "font-medium"
          }`}
        >
          {label}
        </p>
        {!completed && (
          <p className="truncate text-muted-foreground text-xs">
            {description}
          </p>
        )}
      </div>
    </div>
  );

  if (href && !completed) {
    return <Link href={href}>{content}</Link>;
  }

  return content;
}
