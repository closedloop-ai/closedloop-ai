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
import { cn } from "@repo/design-system/lib/utils";
import { CheckIcon, CircleIcon, XIcon } from "lucide-react";
import {
  type ChecklistItem,
  ChecklistItemId,
  onboardingChecklist,
  type SettingsTarget,
} from "../mock";

// Data attribute the invite spotlight anchors to. Set on the "Invite team
// members" row so the spotlight can measure it.
export const INVITE_ANCHOR = "invite-checklist-item";

// Direct download of the latest universal .dmg. The desktop-latest tag is a
// rolling tag and this asset name is unversioned, so the URL always resolves to
// the newest build.
const DESKTOP_LATEST_DMG_URL =
  "https://github.com/closedloop-ai/symphony-alpha/releases/download/desktop-latest/Closedloop-universal.dmg";

// Live completion, keyed by item id, overriding the mock's baked defaults so a
// step the user actually finishes (connect GitHub, add key, invite) ticks off
// here — the checklist can't contradict the rest of the app.
type ChecklistCompletion = Partial<Record<ChecklistItemId, boolean>>;

type OnboardingChecklistProps = {
  completion: ChecklistCompletion;
  onDismiss: () => void;
  onNavigate: (target: SettingsTarget) => void;
  onDownloadDesktop: () => void;
};

const isItemDone = (item: ChecklistItem, completion: ChecklistCompletion) =>
  completion[item.id] ?? item.completed;

// Presentational replica of the production OnboardingChecklist ("Complete Your
// Setup"). Team and project are done from the wizard; the rest tick off as the
// user completes them. Incomplete rows deep-link into Settings, matching
// production, which wraps each incomplete item in a Link.
export const OnboardingChecklist = ({
  completion,
  onDismiss,
  onNavigate,
  onDownloadDesktop,
}: OnboardingChecklistProps) => {
  const completedCount = onboardingChecklist.filter((item) =>
    isItemDone(item, completion)
  ).length;
  const totalCount = onboardingChecklist.length;
  const progressPercent = Math.round((completedCount / totalCount) * 100);

  return (
    <Card className="mx-4 mt-4 shadow-none">
      <CardHeader>
        <CardTitle>Complete Your Setup</CardTitle>
        {/* aria-live so completing a step (which has no dialog/focus target of
            its own) is announced to screen readers via the progress count. */}
        <CardDescription aria-live="polite">
          {completedCount} of {totalCount} tasks completed
        </CardDescription>
        <CardAction>
          <Button
            className="size-8 text-muted-foreground"
            onClick={onDismiss}
            size="icon"
            variant="ghost"
          >
            <XIcon className="size-4" />
            <span className="sr-only">Dismiss</span>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress value={progressPercent} />
        <div className="space-y-1">
          {onboardingChecklist.map((item) => (
            <ChecklistRow
              completed={isItemDone(item, completion)}
              item={item}
              key={item.id}
              onDownloadDesktop={onDownloadDesktop}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

const ChecklistRow = ({
  item,
  completed,
  onNavigate,
  onDownloadDesktop,
}: {
  item: ChecklistItem;
  completed: boolean;
  onNavigate: (target: SettingsTarget) => void;
  onDownloadDesktop: () => void;
}) => {
  const isInvite = item.id === ChecklistItemId.InviteMembers;
  const anchor = isInvite ? INVITE_ANCHOR : undefined;
  const rowClass =
    "flex w-full items-start gap-3 rounded-md px-2 py-2 text-left transition-colors";

  const body = (
    <>
      {completed ? (
        <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
      ) : (
        <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/40" />
      )}
      <div className="min-w-0">
        <p
          className={
            completed
              ? "text-muted-foreground text-sm line-through"
              : "font-medium text-sm"
          }
        >
          {item.label}
        </p>
        {completed ? null : (
          <p className="truncate text-muted-foreground text-xs">
            {item.description}
          </p>
        )}
      </div>
    </>
  );

  // The whole desktop-download row opens the desktop-latest release page (where
  // the .dmg lives) in a new tab rather than deep-linking into Settings.
  if (!completed && item.id === ChecklistItemId.DownloadDesktop) {
    return (
      <a
        className={cn(rowClass, "hover:bg-muted/50")}
        href={DESKTOP_LATEST_DMG_URL}
        onClick={onDownloadDesktop}
        rel="noreferrer"
        target="_blank"
      >
        {body}
      </a>
    );
  }

  // Incomplete rows with a destination are clickable, like production's Link.
  if (!completed && item.target) {
    const target = item.target;
    return (
      <button
        className={cn(rowClass, "hover:bg-muted/50")}
        data-tour={anchor}
        onClick={() => onNavigate(target)}
        type="button"
      >
        {body}
      </button>
    );
  }

  return (
    <div className={rowClass} data-tour={anchor}>
      {body}
    </div>
  );
};
