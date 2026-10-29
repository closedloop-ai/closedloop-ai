"use client";

/**
 * @file getting-started-card-shell.tsx
 * @description The sidebar Getting started module's PRESENTATION, plus the step
 * vocabulary and the actionability filter both of its hosts read.
 *
 * Its own module rather than a set of exports on
 * `guided-getting-started-card.tsx` (ISS-10942). That file is the SERVER-owned
 * card, and a dozen shell suites stub it whole with a one-key `vi.mock`; a
 * second host importing the shell from there is decapitated by every one of
 * them, because the stub satisfies the import and hands back `undefined`.
 */

import { PendingOnboardingStep } from "@repo/api/src/types/onboarding-phase";
import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import {
  CloudCogIcon,
  DownloadIcon,
  UserPlusIcon,
  UserRoundIcon,
} from "lucide-react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { GitHubLogo } from "../../shared/feature-flags/github-logo";

export const GETTING_STARTED_CARD_LABEL = "Getting started";

export const GETTING_STARTED_CARD_CLASS_NAME =
  "flex w-full flex-col gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/55 p-2.5";

/**
 * ISS-10942: the step's own label and icon, centred, as the prototype
 * (`packages/app/shell/v2/components/web-master-preview/components/app-sidebar.tsx`) renders it,
 * not a generic "Continue" that names nothing the reader is about to do.
 */
export const GETTING_STARTED_ACTION_CLASS_NAME =
  "w-full min-w-0 justify-center";

/** One label and glyph per step. Exported so a host that renders this card
 * from its own checklist, and the specs that pin either, read the same words. */
export const GETTING_STARTED_STEP_CONTENT: Record<
  PendingOnboardingStep,
  { icon: ComponentType<SVGProps<SVGSVGElement>>; label: string }
> = {
  [PendingOnboardingStep.ChooseSessionSync]: {
    icon: CloudCogIcon,
    label: "Choose session sync",
  },
  [PendingOnboardingStep.ConnectGitHub]: {
    icon: GitHubLogo,
    label: "Connect GitHub",
  },
  [PendingOnboardingStep.CreateAccount]: {
    icon: UserRoundIcon,
    label: WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.CreateAccount],
  },
  [PendingOnboardingStep.DownloadDesktop]: {
    icon: DownloadIcon,
    label: "Download Desktop",
  },
  [PendingOnboardingStep.InviteTeam]: {
    icon: UserPlusIcon,
    label: "Invite teammates",
  },
};

/**
 * Drops the steps this host cannot actually act on right now. Exported because
 * desktop's guest card derives its checklist from the same canonical step model
 * and has to narrow it the same way (ISS-10942).
 *
 * The sync choice is the only conditional member, and since ISS-11249 the
 * condition is the DESKTOP-LOCAL CONSENT READ rather than a Settings link: the
 * step is answered inside the onboarding modal now, so no external route has to
 * exist for it to be actionable. An unsettled read is still withheld — showing
 * the row before the device's own record has answered would state a choice as
 * outstanding without knowing whether it is.
 */
export function listActionableOnboardingSteps(
  steps: readonly PendingOnboardingStep[],
  syncConsentReadSettled: boolean
): readonly PendingOnboardingStep[] {
  if (syncConsentReadSettled) {
    return steps;
  }
  return steps.filter(
    (step) => step !== PendingOnboardingStep.ChooseSessionSync
  );
}

/**
 * The card's presentation, shared so a host that derives its own checklist —
 * desktop's signed-out guest, whose run is local rather than server-owned —
 * renders the same module rather than a look-alike (ISS-10942).
 */
export function GettingStartedCardShell({
  action,
  className,
  completed,
  total,
}: {
  action: ReactNode;
  className?: string;
  completed: number;
  total: number;
}) {
  return (
    <section
      aria-label={GETTING_STARTED_CARD_LABEL}
      className={cn(GETTING_STARTED_CARD_CLASS_NAME, className)}
      data-guided-getting-started=""
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-sidebar-foreground text-xs">
          {GETTING_STARTED_CARD_LABEL}
        </p>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {completed}/{total}
        </p>
      </div>
      {action}
    </section>
  );
}

/** The card's action button: the pending step's icon and its own label. */
export function GettingStartedStepAction({
  disabled = false,
  onClick,
  step,
}: {
  disabled?: boolean;
  onClick?: () => void;
  step: PendingOnboardingStep;
}) {
  return (
    <Button
      className={GETTING_STARTED_ACTION_CLASS_NAME}
      disabled={disabled}
      onClick={onClick}
      size="sm"
      type="button"
    >
      <GettingStartedStepGlyph step={step} />
      <span className="truncate">
        {GETTING_STARTED_STEP_CONTENT[step].label}
      </span>
    </Button>
  );
}

export function GettingStartedStepGlyph({
  step,
}: {
  step: PendingOnboardingStep;
}) {
  const Icon = GETTING_STARTED_STEP_CONTENT[step].icon;
  return <Icon aria-hidden="true" className="size-4" />;
}
