"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@repo/design-system/components/ui/sheet";
import {
  BanIcon,
  CheckCircle2Icon,
  DownloadIcon,
  Loader2Icon,
  TriangleAlertIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  activeStepFor,
  confirmLabel,
  InstallPhase,
  isBlocked as isBlockedFor,
  phaseAfterConfirm,
  phaseAfterConvert,
  STEPS,
  type Step,
} from "../lib/install-phase";
import {
  blockingCapabilityCount,
  Convertibility,
  carriedFieldCount,
  HARNESS_LABEL,
  type SourceComponent,
  supportedCount,
  targetHarnessFor,
  unsupportedCount,
} from "../mock";
import { HarnessArrow, KindBadge } from "./convert-meta";
import { FieldBreakdown } from "./field-breakdown";

// A compact step flow. The current step carries aria-current="step"; completed
// steps read "done" to assistive tech via the label, not color alone.
const StepFlow = ({ active }: { active: Step }) => {
  const activeIndex = STEPS.indexOf(active);
  return (
    <ol
      aria-label="Convert and install progress"
      className="flex items-center gap-2 text-sm"
    >
      {STEPS.map((step, index) => {
        const isActive = index === activeIndex;
        const isDone = index < activeIndex;
        return (
          <li
            aria-current={isActive ? "step" : undefined}
            className="flex items-center gap-2"
            key={step}
          >
            <span
              className={
                isActive
                  ? "font-medium text-foreground"
                  : "text-muted-foreground"
              }
            >
              {step}
              {isDone ? <span className="sr-only"> (done)</span> : null}
            </span>
            {index < STEPS.length - 1 ? (
              <span aria-hidden="true" className="text-muted-foreground/60">
                /
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
};

// Source provenance: where the component came from, always visible so the user
// never loses track of what they are converting from.
const SourceProvenance = ({ source }: { source: SourceComponent }) => (
  <section aria-label="Source component" className="space-y-2">
    <div className="flex items-center gap-2">
      <KindBadge kind={source.kind} />
      <span className="font-medium text-sm">{source.name}</span>
    </div>
    <p className="text-muted-foreground text-sm leading-relaxed">
      Originally a {HARNESS_LABEL[source.sourceHarness]} {source.kind} from{" "}
      {source.publisher}.
    </p>
  </section>
);

// The convertibility banner above the breakdown. Clean and partial are both
// installable (partial carries a dropped-field warning); blocked is not.
const ConvertibilitySummary = ({ source }: { source: SourceComponent }) => {
  const target = HARNESS_LABEL[targetHarnessFor(source)];
  if (source.convertibility === Convertibility.Blocked) {
    const blockers = blockingCapabilityCount(source);
    return (
      <Alert variant="error">
        <BanIcon />
        <AlertTitle>Can't convert to {target}</AlertTitle>
        <AlertDescription>
          {blockers} required{" "}
          {blockers === 1 ? "capability has" : "capabilities have"} no
          equivalent on {target}, so this component can't run there. Install is
          blocked.
        </AlertDescription>
      </Alert>
    );
  }
  if (source.convertibility === Convertibility.Partial) {
    return (
      <Alert variant="warning">
        <TriangleAlertIcon />
        <AlertTitle>Lossy conversion</AlertTitle>
        <AlertDescription>
          {carriedFieldCount(source)} of {source.mappings.length} fields carry
          over. {unsupportedCount(source)} will be dropped and won't work on{" "}
          {target}. Review below before installing.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="success">
      <CheckCircle2Icon />
      <AlertTitle>Converts cleanly</AlertTitle>
      <AlertDescription>
        All {supportedCount(source)} fields map onto {target} with no changes.
      </AlertDescription>
    </Alert>
  );
};

const ConvertingBody = ({ target }: { target: string }) => (
  <div
    aria-live="polite"
    className="flex flex-col items-center gap-3 py-16 text-center"
    role="status"
  >
    <Loader2Icon
      aria-hidden="true"
      className="size-6 animate-spin text-muted-foreground"
    />
    <p className="font-medium text-sm">Converting and installing on {target}</p>
    <p className="text-muted-foreground text-sm">Applying the field mapping.</p>
  </div>
);

const InstalledBody = ({
  source,
  target,
}: {
  source: SourceComponent;
  target: string;
}) => {
  const droppedFields = source.mappings
    .filter((m) => m.targetField === null)
    .map((m) => m.sourceField);
  return (
    <div
      aria-live="polite"
      className="flex flex-col items-center gap-3 py-12 text-center"
      role="status"
    >
      <CheckCircle2Icon aria-hidden="true" className="size-6 text-success" />
      <p className="font-medium text-sm">Installed on {target}</p>
      <p className="max-w-xs text-muted-foreground text-sm leading-relaxed">
        {source.name} converted from {HARNESS_LABEL[source.sourceHarness]} and
        is ready to use.
      </p>
      {droppedFields.length > 0 ? (
        <div className="w-full max-w-xs space-y-1.5 text-left">
          <p className="text-muted-foreground text-xs">
            Dropped in the conversion:
          </p>
          <ul className="space-y-1">
            {droppedFields.map((field) => (
              <li
                className="text-muted-foreground text-sm leading-relaxed"
                key={field}
              >
                {field}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
};

// The resting preview: provenance, one banner, and the field breakdown. On a
// prior install failure the failure alert *replaces* the convertibility banner
// rather than stacking a second alert on top of it — the failure is now the one
// "read this first", and it carries its own glyph so it never looks like the
// amber "converts with changes" warning.
const PreviewBody = ({
  source,
  showError,
}: {
  source: SourceComponent;
  showError: boolean;
}) => (
  <div className="space-y-5">
    <SourceProvenance source={source} />
    {showError ? (
      <Alert variant="error">
        <XCircleIcon />
        <AlertTitle>Install failed</AlertTitle>
        <AlertDescription>
          The conversion completed but writing to your{" "}
          {HARNESS_LABEL[targetHarnessFor(source)]} config didn't finish.
          Nothing was installed. Try again.
        </AlertDescription>
      </Alert>
    ) : (
      <ConvertibilitySummary source={source} />
    )}
    <section aria-label="Field-by-field conversion" className="space-y-3">
      <h3 className="font-medium text-sm">Field-by-field</h3>
      <FieldBreakdown mappings={source.mappings} />
    </section>
  </div>
);

// The sheet body for a single selected source. It owns the install phase and
// its own timer. Mounted keyed by source id, so a new selection remounts fresh
// in Preview — no reset effect, and no stale Installed/Error paint from the
// previously-selected component on the first frame.
const ConvertSheetBody = ({
  source,
  onOpenChange,
}: {
  source: SourceComponent;
  onOpenChange: (open: boolean) => void;
}) => {
  const [phase, setPhase] = useState<InstallPhase>(InstallPhase.Preview);

  // While converting, resolve to the component's mocked outcome after a short
  // beat. Cleared on unmount or if the phase changes so a canceled convert
  // never lands late.
  useEffect(() => {
    if (phase !== InstallPhase.Converting) {
      return;
    }
    const timer = setTimeout(() => {
      setPhase(phaseAfterConvert(source));
    }, 1400);
    return () => clearTimeout(timer);
  }, [phase, source]);

  const target = HARNESS_LABEL[targetHarnessFor(source)];
  const isBlocked = isBlockedFor(source);
  const isConverting = phase === InstallPhase.Converting;

  // Mid-convert the whole dismiss surface is sealed: the Cancel button is
  // disabled, the built-in X is hidden, and Escape / overlay-click are
  // prevented — so no dismiss path contradicts another while the install runs.
  const preventDismissWhileConverting = (event: Event) => {
    if (isConverting) {
      event.preventDefault();
    }
  };

  return (
    <SheetContent
      className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
      hideClose={isConverting}
      onEscapeKeyDown={preventDismissWhileConverting}
      onInteractOutside={preventDismissWhileConverting}
    >
      <SheetHeader className="gap-3 border-border border-b p-5">
        <StepFlow active={activeStepFor(phase)} />
        <div className="space-y-1.5">
          <SheetTitle>
            {isBlocked ? `Can't install on ${target}` : `Install on ${target}`}
          </SheetTitle>
          <SheetDescription asChild>
            <div>
              <HarnessArrow
                from={HARNESS_LABEL[source.sourceHarness]}
                to={target}
              />
            </div>
          </SheetDescription>
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {isConverting ? <ConvertingBody target={target} /> : null}
        {phase === InstallPhase.Installed ? (
          <InstalledBody source={source} target={target} />
        ) : null}
        {phase === InstallPhase.Preview || phase === InstallPhase.Error ? (
          <PreviewBody
            showError={phase === InstallPhase.Error}
            source={source}
          />
        ) : null}
      </div>

      <SheetFooter className="flex-row justify-end gap-2 border-border border-t p-5">
        {phase === InstallPhase.Installed ? (
          <Button onClick={() => onOpenChange(false)} type="button">
            Done
          </Button>
        ) : (
          <>
            <Button
              disabled={isConverting}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              className="gap-1.5"
              disabled={isBlocked || isConverting}
              onClick={() => setPhase(phaseAfterConfirm(phase, source))}
              type="button"
            >
              {isConverting ? (
                <Loader2Icon
                  aria-hidden="true"
                  className="size-4 animate-spin"
                />
              ) : (
                <DownloadIcon aria-hidden="true" className="size-4" />
              )}
              {confirmLabel(phase, isBlocked)}
            </Button>
          </>
        )}
      </SheetFooter>
    </SheetContent>
  );
};

type ConvertSheetProps = {
  source: SourceComponent | null;
  onOpenChange: (open: boolean) => void;
};

// Outer wrapper: the Sheet stays mounted so Radix can play the close animation
// on dismiss. The body is keyed by source id so each selection gets a fresh
// state machine and never inherits the prior source's phase.
export const ConvertSheet = ({ source, onOpenChange }: ConvertSheetProps) => (
  <Sheet onOpenChange={onOpenChange} open={source !== null}>
    {source ? (
      <ConvertSheetBody
        key={source.id}
        onOpenChange={onOpenChange}
        source={source}
      />
    ) : null}
  </Sheet>
);
