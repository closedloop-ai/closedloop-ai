"use client";

import type { ChecklistItemId } from "@repo/api/src/types/onboarding";
import { useDismissChecklist } from "@repo/app/onboarding/hooks/use-onboarding";
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
import { Link } from "@repo/navigation/link";
import { Check, Circle, ExternalLink, X } from "lucide-react";
import {
  CHECKLIST_ITEM_ATTRIBUTE,
  CHECKLIST_LIST_ATTRIBUTE,
  useOnboardingChecklist,
} from "./use-onboarding-checklist";

export function OnboardingChecklist() {
  const dismissChecklist = useDismissChecklist();
  const { visible, items, completedCount, totalCount } =
    useOnboardingChecklist();

  if (!visible) {
    return null;
  }

  const progressPercent = Math.round((completedCount / totalCount) * 100);

  const handleDismiss = () => {
    dismissChecklist.mutate();
  };

  return (
    <Card className="mx-4 mt-4 shadow-none">
      <CardHeader>
        <CardTitle>Complete Your Setup</CardTitle>
        {/*
          Announced: ticking a step off has no dialog or focus move of its own,
          so the count is the only thing that tells a screen-reader user the
          click worked. Carried over from the prototype (#4824).
        */}
        <CardDescription aria-live="polite">
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

        <div className="space-y-1" {...{ [CHECKLIST_LIST_ATTRIBUTE]: "" }}>
          {items.map((item) => (
            <ChecklistItem
              completed={item.completed}
              description={item.description}
              external={item.external}
              href={item.href}
              itemId={item.id}
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
  readonly external?: boolean;
  readonly itemId: ChecklistItemId;
};

function ChecklistItem({
  label,
  description,
  completed,
  href,
  external,
  itemId,
}: ChecklistItemProps) {
  const content = (
    <div
      className="flex items-start gap-3 rounded-md px-2 py-2 transition-colors hover:bg-muted/50"
      {...{ [CHECKLIST_ITEM_ATTRIBUTE]: itemId }}
    >
      {completed ? (
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      ) : (
        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/40" />
      )}
      <div className="min-w-0">
        <p
          className={`flex items-center gap-1.5 text-sm ${
            completed ? "text-muted-foreground line-through" : "font-medium"
          }`}
        >
          {label}
          {/*
            The off-app row is otherwise byte-identical to the in-app ones, so
            nothing warned the user that this one leaves the app and starts a
            binary download. Same affordance the pack cards and branch panels
            use.
          */}
          {external && !completed && (
            <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
          )}
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
    // An off-app destination cannot go through the navigation Link, which would
    // try to route an absolute URL inside the SPA.
    if (external) {
      return (
        <a href={href} rel="noreferrer" target="_blank">
          {content}
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      );
    }
    return <Link href={href}>{content}</Link>;
  }

  return content;
}
