"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { CornerDownRight } from "lucide-react";
import { useState } from "react";
import { ConnectStep, connectSteps, footerLabels } from "../mock";
import { AuthTransitionPanel } from "./auth-transition-panel";
import { ClosedloopMark } from "./brand-icons";
import { DeviceConsentPanel } from "./device-consent-panel";
import { SignInCard } from "./sign-in-card";

/**
 * GitHub's own authorize page. Not ours to draw, and drawing it would be worse
 * than useless — a builder could mistake a mock for a spec of a page we do not
 * control.
 *
 * So it composes the same panel every other waiting stop uses (that is the
 * whole thesis; hand-rolling a lookalike here contradicted it) and then frames
 * it as a stand-in. The dashed frame is the entire point: without it, the one
 * stop we do NOT own renders exactly as designed as the ones we do, which is
 * how a builder ends up treating it as a spec.
 */
const GitHubHopPlaceholder = () => (
  <div className="rounded-xl border border-border border-dashed p-6">
    <p className="mb-4 text-center text-muted-foreground text-xs uppercase tracking-wider">
      Not our page
    </p>
    <AuthTransitionPanel
      description="This stop is the whole point of the deep link: it is what the user should see first after pressing a button that said &ldquo;Connect to GitHub&rdquo;."
      showGitHubMark
      title="GitHub's authorize screen"
    />
  </div>
);

const StepPanel = ({ step }: { step: ConnectStep }) => {
  if (step === ConnectStep.SignIn) {
    return <SignInCard />;
  }
  if (step === ConnectStep.Redirecting) {
    return (
      <AuthTransitionPanel busy showGitHubMark title="Taking you to GitHub" />
    );
  }
  // The stop a user is actually stuck on, and the only one that needs a way
  // out. `action` is the recovery affordance the panel exists to carry.
  if (step === ConnectStep.Failure) {
    return (
      <AuthTransitionPanel
        action={
          <Button className="w-full" size="lg">
            Continue to sign in
          </Button>
        }
        description="Your desktop app is still waiting. Sign in and pick GitHub to finish connecting."
        showGitHubMark
        title="We couldn't open GitHub"
      />
    );
  }
  if (step === ConnectStep.GitHub) {
    return <GitHubHopPlaceholder />;
  }
  if (step === ConnectStep.Callback) {
    return (
      <AuthTransitionPanel busy showGitHubMark title="Finishing sign-in" />
    );
  }
  if (step === ConnectStep.Consent) {
    return <DeviceConsentPanel />;
  }
  // No spinner: once the loopback fires this is terminal. A spinner alongside
  // "You can close this tab" says we are still working and that we are done, in
  // the same breath.
  return (
    <AuthTransitionPanel
      description="You can close this tab."
      title="Returning to desktop"
    />
  );
};

const StepRail = ({
  active,
  onSelect,
}: {
  active: ConnectStep;
  onSelect: (step: ConnectStep) => void;
}) => {
  let happyPathIndex = 0;

  return (
    <nav aria-label="Connect flow steps" className="flex flex-col gap-1">
      {connectSteps.map((step) => {
        if (!step.branch) {
          happyPathIndex += 1;
        }
        const position = step.branch ? null : happyPathIndex;

        // Selected reads as raised, not as done. `variant="secondary"` is a
        // green tint in this theme (--secondary sits at hue 146), and green on
        // a step rail reads as "completed" — which is a state this rail does
        // not track and must not imply.
        return (
          <Button
            aria-current={step.id === active ? "step" : undefined}
            className={
              step.id === active
                ? "h-auto justify-start gap-3 bg-background px-3 py-2 text-left shadow-sm hover:bg-background"
                : "h-auto justify-start gap-3 px-3 py-2 text-left"
            }
            key={step.id}
            onClick={() => onSelect(step.id)}
            variant="ghost"
          >
            {position === null ? (
              <CornerDownRight
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            ) : (
              <span className="text-muted-foreground text-xs tabular-nums">
                {position}
              </span>
            )}
            <span className="flex flex-col gap-0.5">
              <span className="font-medium text-sm">{step.label}</span>
              <span className="text-muted-foreground text-xs">
                {step.ours ? step.source : `${step.source} — not ours`}
              </span>
            </span>
          </Button>
        );
      })}
    </nav>
  );
};

/**
 * The signed-out desktop connect flow, end to end (PLN-1526 gap 3).
 *
 * It was built as three routes and reviewed one screen at a time, which is how
 * the same "hold on, we're moving you" moment ended up with three spellings.
 * Walking the sequence is the only way to see that, so this prototype walks it.
 *
 * The call it settles: one waiting treatment, used at every waiting stop —
 * including the failure stops, which are where a user is actually stuck and so
 * are the ones most worth agreeing on. The consent step is the only stop that
 * asks for something, so it keeps a different shape, but the same column, the
 * same heading scale, and the same full-width primary, so it reads as the same
 * product rather than a Card that wandered in from the settings pages.
 *
 * What the rail does NOT show is the 400ms reveal hold that every waiting panel
 * ships with. On a healthy hop the user sees nothing at all and these screens
 * never render — which is the point of the hold, and worth remembering when
 * weighing how much polish any single waiting stop deserves. It is omitted here
 * because a reference that renders empty for 400ms on every stop switch is a
 * worse review tool, not because the flow lacks it.
 */
export const ConnectSequence = () => {
  const [step, setStep] = useState<ConnectStep>(ConnectStep.Redirecting);

  return (
    <main className="relative grid min-h-svh grid-cols-1 bg-background lg:grid-cols-2">
      <div className="relative flex flex-col px-8 py-8">
        <div className="flex items-center gap-2">
          <ClosedloopMark className="size-7" />
          <span className="font-semibold text-lg tracking-tight">
            Closedloop.ai
          </span>
        </div>

        <div className="flex flex-1 items-center justify-center py-12">
          <div className="w-full max-w-sm">
            <StepPanel step={step} />
          </div>
        </div>

        {/* Plain text, not buttons: these have no destination yet, and a
            control that looks clickable and does nothing is exactly what this
            sandbox is for catching. */}
        <div className="flex items-center justify-center gap-4 text-muted-foreground text-sm">
          {footerLabels.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      </div>

      {/* Prototype chrome, not a shipped surface: the right half is the product
          panel in production. Here it carries the step rail so the sequence can
          be walked, which is the thing being reviewed.

          Production hides this half below lg because it is decorative there. It
          stays visible here at every width, because hiding it would hide the
          only control this prototype has. */}
      <div className="p-3">
        <div className="flex h-full w-full flex-col gap-6 overflow-y-auto rounded-2xl bg-muted/40 p-6 lg:p-8">
          <div className="flex flex-col gap-1.5">
            <h2 className="font-semibold text-lg tracking-tight">
              Signed-out desktop connect
            </h2>
            <p className="text-muted-foreground text-sm">
              Where a "Connect to GitHub" click lands when the browser has no
              Closedloop session. Numbered stops are the happy path; indented
              ones are branches off it. Pick a stop to see it.
            </p>
          </div>
          <StepRail active={step} onSelect={setStep} />
        </div>
      </div>
    </main>
  );
};
