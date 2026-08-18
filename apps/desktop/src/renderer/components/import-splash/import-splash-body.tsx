import {
  Alert,
  AlertTitle,
} from "@closedloop-ai/design-system/components/ui/alert";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Progress } from "@closedloop-ai/design-system/components/ui/progress";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { ChevronUpIcon, TriangleAlertIcon } from "lucide-react";
import { formatCount } from "../import-progress-display";
import { ComputeChecklist } from "./compute-checklist";
import { HarnessProgressList } from "./harness-progress-list";
import { ImportPhase, type ImportSplashState } from "./import-splash-state";
import { PhaseStepper } from "./phase-stepper";
import { SyncFootnote } from "./sync-footnote";

// Placeholder rows for the scan phase, before any per-harness total is known:
// the same four-column grid as the import rows so when scan flips to import the
// content just fills in — the columns never shift.
const SCAN_PLACEHOLDER_KEYS = ["a", "b", "c"] as const;

const ScanningActivity = () => (
  <div className="flex flex-col gap-3">
    {SCAN_PLACEHOLDER_KEYS.map((key) => (
      <div
        className="grid grid-cols-[1rem_8rem_1fr_auto] items-center gap-3"
        key={key}
      >
        <span
          aria-hidden="true"
          className="size-1.5 justify-self-center rounded-full bg-muted-foreground/40"
        />
        <Skeleton className="h-3 w-24 rounded" />
        <Skeleton className="h-1.5 w-full rounded-full" />
        <Skeleton className="h-3 w-14 rounded" />
      </div>
    ))}
  </div>
);

// ISS-5281: a run that reached the end has two honest outcomes, and they are not
// the same fact. Everything imported cleanly is a success. Everything imported
// but some source transcripts were quarantined is a PARTIAL success: the flow
// still advances (nothing is blocked), but the caveat rides here with the real
// quarantine count rather than being folded into a failure that claims the run
// stopped.
const ReadyActivity = ({ state }: { state: ImportSplashState }) => {
  if (state.couldNotImportLabel !== null) {
    return (
      <Alert variant="warning">
        <TriangleAlertIcon />
        {/* Title only (review): the headline and detail two lines above already
            carry the reassurance, so a description here would be the fourth
            consecutive line saying a version of "you're fine". The quarantine
            count is the one new fact, so it is the only thing the alert says.
            No transcript count rides with it either: a quarantined transcript
            never parsed, so how many sessions it held is unknowable.
            ISS-6115: the phrase is derived in the state module, because the right
            verb depends on which stage gave up — an import stall read the file
            fine and failed to SAVE it. */}
        <AlertTitle>{state.couldNotImportLabel}</AlertTitle>
      </Alert>
    );
  }
  // A clean finish carries one fact, and "You are all set" / "Your dashboard is
  // ready" sit directly above it — a tinted, bordered, icon-bearing box for the
  // count would be a third victory lap (review). A plain line does it.
  return (
    <p className="text-muted-foreground text-sm">
      {`${formatCount(state.total, "transcript")} imported`}
    </p>
  );
};

// Failure is graceful: what imported is still usable, so the state offers a way
// forward rather than trapping the user on a dead bar. The aggregate stall does
// not tell us WHICH harness wedged (imports overlap and the payload carries no
// per-harness failure), so the copy stays generic rather than blaming a row it
// cannot actually attribute. The collectors keep running in the background, so
// Continue is not a dead end — it dismisses the splash and lets the user work
// with what imported so far.
const FailedActivity = ({
  state,
  onContinue,
}: {
  state: ImportSplashState;
  onContinue: () => void;
}) => (
  <div className="flex flex-col gap-4">
    {/* The alert appears ONLY when it has a second fact to carry — the
        quarantine count (review). On the common branch it held nothing but the
        way-forward sentence, which made the loudest, most assertive element on
        the screen the one saying everything is fine, while the actual problem
        sat above it in plain muted type. That reassurance is not an alert; it
        renders as a plain line beside the control that acts on it, below. */}
    {state.alertTitle === null ? null : (
      <Alert variant="error">
        <TriangleAlertIcon />
        <AlertTitle>{state.alertTitle}</AlertTitle>
      </Alert>
    )}
    {state.perHarness.length > 0 ? (
      <HarnessProgressList harnesses={state.perHarness} />
    ) : null}
    <div className="flex flex-col items-start gap-2">
      {state.alertDetail === null ? null : (
        <p className="text-muted-foreground text-sm">{state.alertDetail}</p>
      )}
      {/* Dismiss the splash and continue with the partial import. */}
      <Button onClick={onContinue} size="sm" type="button">
        Continue to dashboard
      </Button>
    </div>
  </div>
);

const PhaseActivity = ({
  state,
  onContinue,
}: {
  state: ImportSplashState;
  onContinue: () => void;
}) => {
  if (state.phase === ImportPhase.Scanning) {
    return <ScanningActivity />;
  }
  if (state.phase === ImportPhase.Failed) {
    return <FailedActivity onContinue={onContinue} state={state} />;
  }
  if (state.phase === ImportPhase.Ready) {
    return <ReadyActivity state={state} />;
  }
  if (state.phase === ImportPhase.Computing) {
    return <ComputeChecklist state={state} />;
  }
  return <HarnessProgressList harnesses={state.perHarness} />;
};

type ImportSplashBodyProps = {
  state: ImportSplashState;
  railPaused: boolean;
  onTogglePause: () => void;
  onContinue: () => void;
  /** ISS-5258: collapse this panel to the compact row. */
  onCollapse: () => void;
  /** The panel's own id, referenced by the disclosure control it controls. */
  panelId: string;
};

/**
 * The splash's expanded body: the overall progress rail (with the off-main-thread
 * shimmer inherited from the banner), the Scan → Import → Compute → Ready
 * stepper, and the phase-specific activity. Rendered inside the collapsing
 * banner section, so it carries no chrome of its own.
 */
export function ImportSplashBody({
  state,
  railPaused,
  onTogglePause,
  onContinue,
  onCollapse,
  panelId,
}: ImportSplashBodyProps) {
  const showPause = state.phase === ImportPhase.Importing;
  // The overall numeric count only reads honestly once a real total exists and
  // the import is still doing count-bearing work — not during the scan (no total
  // yet), the Ready celebration, or the partial-failure state.
  const showCount =
    state.phase === ImportPhase.Importing ||
    state.phase === ImportPhase.Computing;
  // ISS-5348 (review): NOT `showCount`. In Computing the detail line four lines
  // above already reads "Your dashboard is ready to use now" — the same
  // reassurance, said better and with the thing the user actually wants to know.
  // Repeating it in the footer is not emphasis, it is noise, and it crowds out
  // the sync line that phase's footer slot exists to carry. Import still needs
  // it: there the detail names harnesses and nothing else says the app is free.
  const showBackgroundNote = state.phase === ImportPhase.Importing;
  return (
    <div className="flex flex-col gap-5 px-6 py-5" id={panelId}>
      <div className="flex items-start justify-between gap-4">
        {/* The live region carries only the phase headline + detail (a handful
            of announcements) — the churning session count lives on the progress
            rail's aria-valuenow, not in a live region. */}
        <div
          aria-atomic="true"
          aria-live="polite"
          className="flex min-w-0 flex-col gap-0.5"
          role="status"
        >
          <h2 className="font-medium text-base text-foreground tracking-tight">
            {state.headline}
          </h2>
          <p className="truncate text-muted-foreground text-sm">
            {state.detail}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {showPause ? (
            <Button
              aria-label={state.paused ? "Resume import" : "Pause import"}
              onClick={onTogglePause}
              size="sm"
              type="button"
              variant="outline"
            >
              {state.paused ? "Resume" : "Pause"}
            </Button>
          ) : null}
          {/* A LABELED button, not a bare chevron. In Scanning, Computing,
              Ready and Failed this is the only control in the cluster, so an
              icon-only ghost would float there with nothing beside it to give
              it context — and getting the splash out of the way is the whole
              point of ISS-5258, so that affordance must not be the quietest
              thing on the panel. The collapsed row keeps the chevron: there
              the row itself is the affordance. */}
          <Button
            aria-controls={panelId}
            aria-expanded={true}
            aria-label="Hide import details"
            data-import-splash-toggle=""
            onClick={onCollapse}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ChevronUpIcon aria-hidden="true" />
            Hide
          </Button>
        </div>
      </div>

      {state.phase === ImportPhase.Failed ? null : (
        <div className="flex flex-col gap-2">
          <ProgressRail pct={state.overallPct} railPaused={railPaused} />
          {showCount ? (
            <div className="flex items-center justify-between text-muted-foreground text-xs tabular-nums">
              <span>{Math.round(state.overallPct)}%</span>
              <span
                className={cn(
                  state.phase === ImportPhase.Importing
                    ? "text-foreground"
                    : "text-muted-foreground"
                )}
              >
                {state.processed.toLocaleString()} /{" "}
                {state.total.toLocaleString()} transcripts
              </span>
            </div>
          ) : null}
        </div>
      )}

      <PhaseStepper activeStep={state.activeStep} failed={state.failed} />

      <PhaseActivity onContinue={onContinue} state={state} />

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-border/60 border-t pt-4">
        <SyncFootnote state={state.syncFootnote} />
        {showBackgroundNote ? (
          <span className="text-muted-foreground text-xs">
            Runs in the background
          </span>
        ) : null}
      </div>
    </div>
  );
}

// The overall rail: an explicitly-valued determinate fill plus a continuous
// off-main-thread sheen swept on top (dropped while the import is paused). CSS
// animations run on the compositor, so the rail keeps visibly moving even while
// the main thread is blocked and the count is frozen — "loading", not "hung".
// The value is announced (aria-valuenow) so a screen reader tracks overall
// progress. ISS-5115: this was a hand-rolled `role="progressbar"` div that
// reimplemented the shared `Progress` geometry and had already drifted from it
// (sheen w-1/4 vs w-1/3, primary/40 vs primary/60, 1.8s vs 1.6s, and a
// `[data-ob-motion]` reduced-motion kill-switch where the primitive uses
// `motion-safe:`). It is now the primitive, with the sheen behind its `sweep`
// prop. The per-harness bars announce their own value too — the shared
// `Progress` had been dropping `value` before it reached Radix, so they were
// named progressbars with nothing to report. Their `N / M` text still carries
// the readable truth; neither sits inside a live region, so a value change is
// read on navigation rather than announced on every tick.
function ProgressRail({
  pct,
  railPaused,
}: {
  pct: number;
  railPaused: boolean;
}) {
  return (
    <Progress
      aria-label="Overall import progress"
      paused={railPaused}
      sweep
      value={Math.round(pct)}
    />
  );
}
