"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@closedloop-ai/design-system/components/ui/alert";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Progress } from "@closedloop-ai/design-system/components/ui/progress";
import {
  FilledStatusCircle,
  StatusDash,
  StatusRing,
} from "@closedloop-ai/design-system/components/ui/status-icon-primitives";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PauseIcon,
  PlayIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { SessionPopulationCount } from "../session-population-count";
import { isPausablePhase } from "./startup-readiness-progress";
import { StartupReadinessProgressBar } from "./startup-readiness-progress-bar";
import {
  StartupPauseState,
  type StartupReadinessModel,
  StartupReadinessPhase,
  type StartupReadinessStep,
  StartupReadinessStepState,
} from "./startup-readiness-state";

type StartupReadinessPanelBodyProps = {
  model: StartupReadinessModel;
  expanded: boolean;
  paused: boolean;
  onToggleExpanded: () => void;
  onTogglePause: () => void;
};

/**
 * ISS-4715: the presentational half of the startup readiness panel.
 *
 * `StartupReadinessPanel` is all polling hooks, reveal delays, and the
 * maintenance bridge timer, so mounting it on a canvas would pin the wiring
 * rather than the visuals. This unit renders a already-built
 * {@link StartupReadinessModel} and nothing else, which is what
 * `startup-readiness-panel-body.stories.tsx` drives through the real
 * `buildStartupReadinessModel` derivation — the phases past CheckingHistory need
 * a first launch against a machine with real unimported history (or a wedged
 * cloud sync) to reach on demand.
 */
export function StartupReadinessPanelBody({
  model,
  expanded,
  paused,
  onToggleExpanded,
  onTogglePause,
}: StartupReadinessPanelBodyProps) {
  // One predicate with the progress bar, so the Pause control can never appear
  // over a bar that keeps sweeping (or vanish from one that has frozen).
  const canPause = isPausablePhase(model.phase);

  return (
    <section
      aria-label="Desktop startup readiness"
      className={cn("border-b px-4 py-3", sectionTone(model.phase))}
      data-testid="startup-readiness-panel"
    >
      <div className="mx-auto max-w-screen-2xl">
        <div className="flex min-w-0 items-start gap-3">
          <TerminalStatus phase={model.phase} />
          {/* Scoped to the headline and detail: the checklist, the source-file
              bar and the warning Alert all sit outside it, so a phase change
              re-announces the summary rather than the whole panel, and does not
              collide with the progress bar's own aria-valuetext. */}
          <div aria-live="polite" className="min-w-0 flex-1">
            <h2 className="font-medium text-sm">{model.headline}</h2>
            <p className="mt-0.5 text-muted-foreground text-sm">
              {model.detail}
            </p>
          </div>
          {canPause ? (
            <Button
              aria-label={paused ? "Resume history processing" : undefined}
              onClick={onTogglePause}
              size="sm"
              type="button"
              variant="outline"
            >
              {paused ? <PlayIcon /> : <PauseIcon />}
              {paused ? "Resume" : "Pause"}
            </Button>
          ) : null}
          <Button
            aria-expanded={expanded}
            aria-label={
              expanded ? "Hide startup details" : "Show startup details"
            }
            onClick={onToggleExpanded}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </Button>
        </div>

        {/* Deliberately thinner than the source-file bar below. This bar by
            design claims no amount, so at the panel's full width and the
            default height it outranked the one carrying the real "N of M".
            It freezes only on the ACKNOWLEDGED pause, not on the request: while
            the collector is still finishing the step in flight the work really
            is running, and a frozen bar there would be the same lie in reverse. */}
        <StartupReadinessProgressBar
          className="mt-2 h-1.5"
          paused={model.pauseState === StartupPauseState.Paused}
          phase={model.phase}
        />

        {expanded ? <ReadinessDetails model={model} /> : null}
      </div>
    </section>
  );
}

/**
 * ISS-5115: the in-flight ring is gone, but the two TERMINAL outcomes keep a
 * glyph. Without it Ready and Attention are distinguished only by the hue of
 * one bar, which fails WCAG 1.4.1 (use of colour) and reads as identical in
 * peripheral vision. Shape carries the outcome; the bar carries motion.
 */
function TerminalStatus({ phase }: { phase: StartupReadinessPhase }) {
  if (phase === StartupReadinessPhase.Ready) {
    return (
      <FilledStatusCircle
        fill="var(--success)"
        glyph="check"
        label="Startup complete"
        size={20}
      />
    );
  }
  if (phase === StartupReadinessPhase.NeedsAttention) {
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

function ReadinessDetails({ model }: { model: StartupReadinessModel }) {
  return (
    <div className="mt-4">
      <ol className="grid gap-3 md:grid-cols-3">
        {model.steps.map((step) => (
          <ReadinessStepItem
            key={step.id}
            // ISS-6241: only the step the counts describe, and only while it is
            // the live one. A finished step's count is noise and a pending step
            // has measured nothing; `maintenanceProgress` is already null unless
            // the panel is on this step.
            progress={step.id === "views" ? model.maintenanceProgress : null}
            step={step}
          />
        ))}
      </ol>
      {model.sourceFileProgress ? (
        <SourceFileProgress progress={model.sourceFileProgress} />
      ) : null}
      {model.cloudPendingCount !== null || model.cloudWarning !== null ? (
        <CloudFreshness model={model} />
      ) : null}
      {model.phase === StartupReadinessPhase.NeedsAttention ? (
        <Alert className="mt-4 max-w-2xl" variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>One startup source needs attention</AlertTitle>
          <AlertDescription>
            {model.cloudWarning ?? model.detail}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function ReadinessStepItem({
  step,
  progress,
}: {
  step: StartupReadinessStep;
  progress: StartupReadinessModel["maintenanceProgress"];
}) {
  const count =
    step.state === StartupReadinessStepState.Active ? progress : null;
  return (
    <li className="grid grid-cols-[1rem_1fr] gap-x-2">
      <span className="pt-0.5">
        <StepStatus step={step} />
      </span>
      <span>
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              "font-medium text-xs",
              step.state === StartupReadinessStepState.Pending &&
                "text-muted-foreground"
            )}
          >
            {step.label}
          </span>
          {count ? (
            <SessionPopulationCount
              processed={count.processed}
              total={count.total}
            />
          ) : null}
        </span>
        <span className="mt-0.5 block text-muted-foreground text-xs leading-relaxed">
          {step.description}
        </span>
      </span>
    </li>
  );
}

function StepStatus({ step }: { step: StartupReadinessStep }) {
  if (step.state === StartupReadinessStepState.Complete) {
    return (
      <FilledStatusCircle
        fill="var(--success)"
        glyph="check"
        label={`${step.label} complete`}
      />
    );
  }
  if (step.state === StartupReadinessStepState.Warning) {
    return (
      <FilledStatusCircle
        fill="var(--warning)"
        glyph="exclamation"
        label={`${step.label} needs attention`}
      />
    );
  }
  if (step.state === StartupReadinessStepState.Active) {
    // Design review, ISS-5115: the global bar owns motion now. A thinking ring
    // here was a second animation doing the same job in the same strip — during
    // Processing there were three progress indicators stacked and two of them
    // animated. The active step is a plain primary dot; the sweep is the only
    // movement left.
    return (
      <StatusRing
        color="var(--primary)"
        label={`${step.label} in progress`}
        percentage={0}
        trackColor="var(--primary)"
      />
    );
  }
  return <StatusDash label={`${step.label} pending`} />;
}

function SourceFileProgress({
  progress,
}: {
  progress: NonNullable<StartupReadinessModel["sourceFileProgress"]>;
}) {
  return (
    <div className="mt-4 max-w-xl rounded-md bg-background/80 p-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">Agent history source files</span>
        <span className="text-muted-foreground tabular-nums">
          {progress.processed.toLocaleString()} of{" "}
          {progress.total.toLocaleString()}
        </span>
      </div>
      <Progress
        aria-label={`${progress.processed} of ${progress.total} agent history source files processed`}
        className="h-1.5"
        value={progress.percentage}
      />
      <p className="mt-2 text-muted-foreground text-xs">
        This count tracks source files, not sessions. Newly discovered files can
        increase the total.
      </p>
    </div>
  );
}

function CloudFreshness({ model }: { model: StartupReadinessModel }) {
  const warning = model.cloudWarning !== null;
  const label = getCloudFreshnessLabel(model);
  return (
    <div className="mt-3 flex items-center gap-2 text-xs">
      <CloudFreshnessStatus model={model} />
      <span className={warning ? "text-warning" : "text-muted-foreground"}>
        {label}
      </span>
    </div>
  );
}

function CloudFreshnessStatus({ model }: { model: StartupReadinessModel }) {
  if (model.cloudWarning !== null) {
    return (
      <FilledStatusCircle
        fill="var(--warning)"
        glyph="exclamation"
        label="Cloud sync needs attention"
      />
    );
  }
  if (model.cloudVerified) {
    return (
      <FilledStatusCircle
        fill="var(--success)"
        glyph="check"
        label="Cloud history up to date"
      />
    );
  }
  return (
    <StatusRing
      color="var(--primary)"
      label="Cloud history syncing"
      percentage={0}
      thinking
    />
  );
}

/**
 * ISS-5115: with the top status ring gone, the section wash is what carries the
 * one terminal state that asks the user to do something, so Attention gets a
 * tone of its own.
 *
 * Ready deliberately does not. Design review: Ready already carries the success
 * glyph, a full success-toned bar, an all-green checklist and the headline, and
 * a full-width green band flashing across the top of the app for the moment
 * before the panel dismisses reads as celebration rather than as status. Say it
 * once - the glyph and the bar are enough.
 */
function sectionTone(phase: StartupReadinessPhase): string {
  if (phase === StartupReadinessPhase.NeedsAttention) {
    return "bg-warning/5";
  }
  return "bg-muted/30";
}

function getCloudFreshnessLabel(model: StartupReadinessModel): string {
  if (model.cloudWarning !== null) {
    return "Cloud sync needs attention";
  }
  if (model.cloudVerified) {
    return "Cloud history is up to date";
  }
  if (model.cloudPendingCount === 0) {
    return "Checking cloud freshness";
  }
  return `${model.cloudPendingCount?.toLocaleString()} historical sessions waiting for cloud sync`;
}
