"use client";

/**
 * @file ISS-12363: the Web setup gate — download Desktop, then choose a sync
 * policy — as the two places that show it draw it: the first user's sync step
 * in the blocking modal, and the Getting started card everyone after them
 * resumes it from.
 *
 * Presentational only. The host resolves the steps with `resolveSetupGate`
 * (`../lib/first-user-setup-gate.ts`) and hands the result in, so the modal and
 * the card cannot disagree about which step is done.
 *
 * Every string this module did not inherit from an approved source is a
 * REQUIRED `copy` prop rather than a literal here: none of it has a product
 * ruling yet, so the shared package carries no wording of its own and cannot
 * ship unapproved copy by accident. The step LABELS are not part of it — they
 * are the completion card's existing, shipped labels.
 */

import { PendingOnboardingStep } from "@repo/api/src/types/onboarding-phase";
import { cn } from "@repo/design-system/lib/utils";
import { CheckIcon } from "lucide-react";
import type {
  SetupGate,
  SetupGateStep,
  SetupGateStepState,
} from "../lib/first-user-setup-gate";
import {
  GETTING_STARTED_STEP_CONTENT,
  GettingStartedStepGlyph,
} from "./getting-started-card-shell";

/** The words the step list needs that no approved source supplies yet. */
export type SetupGateStepListCopy = {
  /** Accessible name for the list. */
  listLabel: string;
  /**
   * Spoken status per row. The check glyph and the muted tint are the visual
   * signal; these words carry the same state to a screen reader, so the state
   * is never conveyed by colour or icon alone (WCAG 1.4.1).
   */
  stepComplete: string;
  stepIncomplete: string;
};

/** The sync step's acknowledgement and explanation. */
export type SyncPolicyGateNoticeCopy = {
  /** Says the download happened; shown only once it has. */
  downloaded: string;
  /** Why sessions can be on Desktop but not yet on the web. */
  explanation: string;
};

/** The label a gate step carries everywhere — the completion card's own. */
export function setupGateStepLabel(step: SetupGateStep): string {
  return GETTING_STARTED_STEP_CONTENT[step].label;
}

/**
 * The gate's rows with their done state. `completedOnly` is for a host whose
 * own action already names the open step — the Getting started card's button —
 * so the open step is not said twice; with nothing done yet it renders nothing.
 */
export function SetupGateStepList({
  className,
  completedOnly = false,
  copy,
  gate,
}: {
  className?: string;
  completedOnly?: boolean;
  copy: SetupGateStepListCopy;
  gate: SetupGate;
}) {
  const steps = completedOnly
    ? gate.steps.filter((state) => state.complete)
    : gate.steps;
  if (steps.length === 0) {
    return null;
  }
  return (
    <ol
      aria-label={copy.listLabel}
      className={cn("flex flex-col gap-1.5", className)}
      data-slot="setup-gate-steps"
    >
      {steps.map((state) => (
        <SetupGateStepRow
          copy={copy}
          current={state.step === gate.nextStep}
          key={state.step}
          state={state}
        />
      ))}
    </ol>
  );
}

function SetupGateStepRow({
  copy,
  current,
  state,
}: {
  copy: SetupGateStepListCopy;
  current: boolean;
  state: SetupGateStepState;
}) {
  return (
    <li
      aria-current={current ? "step" : undefined}
      className={cn(
        "flex items-center gap-2 text-xs",
        current ? "font-medium text-foreground" : "text-muted-foreground"
      )}
      data-complete={state.complete || undefined}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex shrink-0 [&>svg]:size-3.5",
          state.complete && "text-success",
          current && "text-primary"
        )}
      >
        {state.complete ? (
          <CheckIcon />
        ) : (
          <GettingStartedStepGlyph step={state.step} />
        )}
      </span>
      <span className="min-w-0 truncate">{setupGateStepLabel(state.step)}</span>
      <span className="sr-only">
        {state.complete ? copy.stepComplete : copy.stepIncomplete}
      </span>
    </li>
  );
}

/**
 * Shown above the sync-policy picker while the modal holds a first user. It
 * says the download happened, so the reader sees the gate moved, and explains
 * the one thing that otherwise looks broken: sessions visible in Desktop that
 * the web app does not show yet. Kept to two lines so the picker stays in view.
 */
export function SyncPolicyGateNotice({
  copy,
  gate,
}: {
  copy: SyncPolicyGateNoticeCopy;
  gate: SetupGate;
}) {
  const downloaded = gate.steps.some(
    (state) =>
      state.step === PendingOnboardingStep.DownloadDesktop && state.complete
  );
  return (
    <div
      className="mt-4 flex flex-col gap-1.5 text-sm"
      data-slot="sync-policy-gate-notice"
    >
      {downloaded ? (
        <p className="flex items-center gap-2 font-medium text-foreground">
          <CheckIcon aria-hidden="true" className="size-4 text-success" />
          {copy.downloaded}
        </p>
      ) : null}
      <p className="text-muted-foreground leading-relaxed">
        {copy.explanation}
      </p>
    </div>
  );
}
