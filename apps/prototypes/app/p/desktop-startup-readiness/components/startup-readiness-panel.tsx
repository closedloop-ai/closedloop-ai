"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Progress,
  ProgressTone,
} from "@repo/design-system/components/ui/progress";
import {
  FilledStatusCircle,
  StatusDash,
  StatusRing,
} from "@repo/design-system/components/ui/status-icon-primitives";
import { cn } from "@repo/design-system/lib/utils";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CloudIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  type ReadinessStep,
  type StartupFixture,
  StartupStage,
  StepState,
} from "../mock";

type StartupReadinessPanelProps = {
  fixture: StartupFixture;
};

export function StartupReadinessPanel({ fixture }: StartupReadinessPanelProps) {
  const [expanded, setExpanded] = useState(
    fixture.stage !== StartupStage.Ready
  );

  useEffect(() => {
    setExpanded(fixture.stage !== StartupStage.Ready);
  }, [fixture.stage]);

  // The resting state, and the one a user is in nearly all the time: no strip
  // above the app header at all. The shipped panel unmounts in its Hidden phase.
  if (fixture.stage === StartupStage.Hidden) {
    return null;
  }

  return (
    <section
      aria-label="Desktop startup readiness"
      className={cn("border-b px-4 py-3", sectionToneByStage[fixture.stage])}
    >
      <div className="mx-auto max-w-screen-2xl">
        <div className="flex min-w-0 items-start gap-3">
          <TerminalStatus stage={fixture.stage} />
          {/* Scoped to the headline and detail: the checklist, the source-file
              bar and the warning Alert all sit outside it, so a stage change
              re-announces the summary rather than the whole panel, and does not
              collide with the progress bar's own aria-valuetext. */}
          <div aria-live="polite" className="min-w-0 flex-1">
            <h2 className="font-medium text-sm">{fixture.headline}</h2>
            <p className="mt-0.5 text-muted-foreground text-sm">
              {fixture.detail}
            </p>
          </div>
          <Button
            aria-expanded={expanded}
            aria-label={
              expanded ? "Hide startup details" : "Show startup details"
            }
            onClick={() => setExpanded((current) => !current)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </Button>
        </div>

        <StartupProgressBar fixture={fixture} />

        {expanded ? (
          <div className="mt-4">
            <ol className="grid gap-3 md:grid-cols-3">
              {fixture.steps.map((step) => (
                <ReadinessStepItem key={step.id} step={step} />
              ))}
            </ol>

            {fixture.sourceFileProgress ? (
              <SourceFileProgress fixture={fixture} />
            ) : null}

            {fixture.cloudPendingCount === undefined ? null : (
              <CloudFreshness pendingCount={fixture.cloudPendingCount} />
            )}

            {fixture.warning ? (
              <ReadinessWarning warning={fixture.warning} />
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * ISS-5115: one global bar replaces the top loading ring, which duplicated the
 * Checking state and competed with the checklist below it.
 *
 * Honesty rule: startup has no single true percentage. Source-file counts cover
 * one stage of three and the stages are not equal-length, so the bar is
 * INDETERMINATE (`value={null}`, no `aria-valuenow`) everywhere except Ready,
 * where 100 is a fact. Needs-attention pauses the sweep rather than animating,
 * because a travelling bar would imply progress that has stopped. The real
 * source-file numbers keep their own labelled bar in the details below.
 */
function StartupProgressBar({ fixture }: { fixture: StartupFixture }) {
  const stageBar = progressBarByStage[fixture.stage];
  // A paused fixture freezes whichever working stage it is in, so the frozen
  // track can be reviewed next to the sweeping one rather than only ever being
  // reachable through needs-attention.
  const bar = fixture.paused
    ? { ...stageBar, paused: true, valueText: "History processing is paused" }
    : stageBar;
  return (
    <Progress
      // The stage rides in the accessible NAME, not `aria-valuetext`: ARIA only
      // defines valuetext alongside an `aria-valuenow` an indeterminate bar
      // cannot supply, so AT handling of a valuetext-only bar is unspecified.
      aria-label={`Desktop startup progress: ${bar.valueText}`}
      className="mt-2 h-1.5"
      paused={bar.paused}
      tone={bar.tone}
      value={bar.value}
    />
  );
}

/**
 * ISS-5115: the in-flight ring is gone, but the two TERMINAL outcomes keep a
 * glyph. Without it Ready and Attention are distinguished only by the hue of
 * one bar, which fails WCAG 1.4.1 (use of colour) and reads as identical in
 * peripheral vision. Shape carries the outcome; the bar carries motion.
 */
function TerminalStatus({ stage }: { stage: StartupStage }) {
  if (stage === StartupStage.Ready) {
    return (
      <FilledStatusCircle
        fill="var(--success)"
        glyph="check"
        label="Startup complete"
        size={20}
      />
    );
  }
  if (stage === StartupStage.NeedsAttention) {
    return (
      <FilledStatusCircle
        fill="var(--warning)"
        glyph="exclamation"
        label="Startup needs attention"
        size={20}
      />
    );
  }
  return null;
}

function ReadinessStepItem({ step }: { step: ReadinessStep }) {
  return (
    <li className="grid grid-cols-[1rem_1fr] gap-x-2">
      <span className="pt-0.5">
        <StepStatus step={step} />
      </span>
      <span>
        <span
          className={cn(
            "block font-medium text-xs",
            step.state === StepState.Pending && "text-muted-foreground"
          )}
        >
          {step.label}
        </span>
        <span className="mt-0.5 block text-muted-foreground text-xs leading-relaxed">
          {step.description}
        </span>
      </span>
    </li>
  );
}

function StepStatus({ step }: { step: ReadinessStep }) {
  if (step.state === StepState.Complete) {
    return (
      <FilledStatusCircle
        fill="var(--success)"
        glyph="check"
        label={`${step.label} complete`}
      />
    );
  }
  if (step.state === StepState.Error) {
    return (
      <FilledStatusCircle
        fill="var(--warning)"
        glyph="exclamation"
        label={`${step.label} needs attention`}
      />
    );
  }
  if (step.state === StepState.Active) {
    // Design review, ISS-5115: the global bar owns motion now. A thinking ring
    // here was a second animation doing the same job in the same strip, so the
    // active step is a plain primary dot and the sweep is the only movement.
    return (
      <StatusRing
        color="var(--primary)"
        label={`${step.label} in progress`}
        percentage={step.percentage ?? 0}
        trackColor="var(--primary)"
      />
    );
  }
  return <StatusDash label={`${step.label} pending`} />;
}

function SourceFileProgress({ fixture }: { fixture: StartupFixture }) {
  const progress = fixture.sourceFileProgress;
  if (!progress) {
    return null;
  }
  const percentage = (progress.processed / progress.total) * 100;
  return (
    <div className="mt-4 max-w-xl rounded-md bg-background/80 p-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">Claude Code history files</span>
        <span className="text-muted-foreground tabular-nums">
          {progress.processed} of {progress.total}
        </span>
      </div>
      <Progress
        aria-label={`${progress.processed} of ${progress.total} Claude Code history files processed`}
        className="h-1.5"
        value={percentage}
      />
      <p className="mt-2 text-muted-foreground text-xs">
        This count tracks source files, not sessions. Newly discovered files can
        increase the total.
      </p>
    </div>
  );
}

/**
 * Design review, ISS-5115: this carried "Try again" and "Review access", both
 * fully styled and hover-lit, and the shipped warning Alert has no buttons at
 * all. A control a builder has to guess the behavior of is worse than no
 * control, so the reference now matches the build. Source recovery is a real
 * capability the desktop panel does not have yet — it needs a main-process
 * retry for a failed history source — and is tracked separately rather than
 * mocked here.
 */
function ReadinessWarning({ warning }: { warning: string }) {
  return (
    <Alert className="mt-4 max-w-2xl" variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>One source needs attention</AlertTitle>
      <AlertDescription>{warning}</AlertDescription>
    </Alert>
  );
}

/**
 * Design review, ISS-5115: Syncing used to land on the same spinner as the two
 * stages before it, so the only thing that changed was the headline. The build
 * already had a labelled cloud line in the expanded details; this brings it into
 * the reference.
 */
function CloudFreshness({ pendingCount }: { pendingCount: number }) {
  return (
    <div className="mt-3 flex items-center gap-2 text-xs">
      <CloudIcon className="size-icon-sm text-muted-foreground" />
      <span className="text-muted-foreground">
        {pendingCount.toLocaleString()} historical sessions waiting for cloud
        sync
      </span>
    </div>
  );
}

type ProgressBarPresentation = {
  /** `null` is Radix's indeterminate contract: no `aria-valuenow` is emitted. */
  value: number | null;
  paused: boolean;
  valueText: string;
  /** Semantic tone handed to the shared `Progress`, never a child selector. */
  tone: ProgressTone;
};

const WORKING_BAR = {
  value: null,
  paused: false,
  tone: ProgressTone.Default,
} as const;

/**
 * Exhaustive by stage so a new startup stage cannot silently inherit another
 * stage's progress claim.
 */
const progressBarByStage: Record<StartupStage, ProgressBarPresentation> = {
  [StartupStage.OpeningStore]: {
    ...WORKING_BAR,
    valueText: "Opening the local store",
  },
  [StartupStage.LoadingSaved]: {
    ...WORKING_BAR,
    valueText: "Loading saved sessions",
  },
  [StartupStage.CheckingHistory]: {
    ...WORKING_BAR,
    valueText: "Checking local history",
  },
  [StartupStage.ProcessingHistory]: {
    ...WORKING_BAR,
    valueText: "Processing local history",
  },
  [StartupStage.PreparingViews]: {
    ...WORKING_BAR,
    valueText: "Preparing session views",
  },
  [StartupStage.SyncingCloud]: {
    ...WORKING_BAR,
    valueText: "Syncing cloud history",
  },
  [StartupStage.NeedsAttention]: {
    value: null,
    paused: true,
    valueText: "Startup needs attention",
    // Warning-toned, and the primitive renders a paused indeterminate bar as a
    // static hatch: held at an unknown amount, not a full amber fill claiming
    // work that is not advancing.
    tone: ProgressTone.Warning,
  },
  [StartupStage.Ready]: {
    value: 100,
    paused: false,
    valueText: "Startup complete",
    tone: ProgressTone.Success,
  },
  // The panel is unmounted here, so this bar is never rendered. It still needs
  // an honest entry rather than one borrowed from a stage that claims progress.
  [StartupStage.Hidden]: {
    ...WORKING_BAR,
    valueText: "Startup status unavailable",
  },
};

const sectionToneByStage: Record<StartupStage, string> = {
  [StartupStage.OpeningStore]: "bg-muted/30",
  [StartupStage.LoadingSaved]: "bg-muted/30",
  [StartupStage.CheckingHistory]: "bg-muted/30",
  [StartupStage.ProcessingHistory]: "bg-muted/30",
  [StartupStage.PreparingViews]: "bg-muted/30",
  [StartupStage.SyncingCloud]: "bg-muted/30",
  [StartupStage.NeedsAttention]: "bg-warning/5",
  // Ready carries no wash: the success glyph and the full success-toned bar
  // already say it, and a green band across the top of the app for the moment
  // before the panel dismisses reads as celebration rather than as status.
  [StartupStage.Ready]: "bg-muted/30",
  [StartupStage.Hidden]: "bg-muted/30",
};
