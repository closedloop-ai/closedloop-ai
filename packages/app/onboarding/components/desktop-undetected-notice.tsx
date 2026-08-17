"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { Loader2Icon, MonitorIcon, RefreshCwIcon } from "lucide-react";

/**
 * Where the user is in an explicit re-check, which is not the same question as
 * whether detection is currently probing.
 */
export const DesktopRecheckPhase = {
  Idle: "idle",
  Checking: "checking",
  StillAbsent: "still-absent",
} as const;
export type DesktopRecheckPhase =
  (typeof DesktopRecheckPhase)[keyof typeof DesktopRecheckPhase];

/**
 * The rendered half of the ISS-5247 not-detected surface: everything the user
 * sees, driven entirely by props.
 *
 * Four states, deliberately kept distinct: still sweeping, checking right now,
 * gave up, and checked-again-and-still-nothing. Only the last two are answers,
 * and only they carry the terminal copy and the control -- offering "Check
 * again" while the poll loop is mid-run would both contradict the spinner and
 * reset the budget out from under it. A stopped probe must never render as a
 * proven negative it did not establish, which is why `detectionExhausted` is a
 * separate input from `phase` rather than inferred from it.
 *
 * The whole notice sits in one persistent live region so a screen-reader user
 * hears the state change instead of watching a silent swap.
 *
 * This lives in `packages/app` rather than beside its container in `apps/app`
 * for the reason the repo guidelines give: Storybook scans the per-feature
 * `components` directories under `packages/app` and nothing under `apps/app`,
 * and a prop-driven state matrix this easy to regress silently earns isolated
 * coverage. The container that owns the phase
 * state machine, the minimum-feedback timer, and the browser-only detection
 * store stays in `apps/app`, so nothing untestable came along with it.
 */
export function DesktopUndetectedNotice({
  detectionExhausted,
  latestVersion,
  onRecheck,
  phase,
  runningVersion,
}: {
  readonly detectionExhausted: boolean;
  readonly latestVersion: string | null;
  readonly onRecheck: () => void;
  readonly phase: DesktopRecheckPhase;
  readonly runningVersion: string | null;
}) {
  return (
    <div aria-live="polite" className="mt-4">
      <DesktopUndetectedBody
        detectionExhausted={detectionExhausted}
        latestVersion={latestVersion}
        onRecheck={onRecheck}
        phase={phase}
      />
      {runningVersion ? (
        <span className="sr-only">{runningVersion}</span>
      ) : null}
    </div>
  );
}

function DesktopUndetectedBody({
  detectionExhausted,
  latestVersion,
  onRecheck,
  phase,
}: {
  readonly detectionExhausted: boolean;
  readonly latestVersion: string | null;
  readonly onRecheck: () => void;
  readonly phase: DesktopRecheckPhase;
}) {
  if (phase === DesktopRecheckPhase.Checking || detectionExhausted) {
    return (
      <DesktopUndetectedAlert
        latestVersion={latestVersion}
        onRecheck={onRecheck}
        phase={phase}
      />
    );
  }

  return <DesktopDetectionProgress message={describeStillWatching(phase)} />;
}

/**
 * Passive "we are still looking" strip, shaped like the sibling status states
 * above it: icon, one sentence, no action.
 */
function DesktopDetectionProgress({ message }: { readonly message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-muted-foreground text-sm">
      <Loader2Icon className="h-4 w-4 animate-spin" />
      <span>{message}</span>
    </div>
  );
}

/**
 * Terminal not-detected state. This one carries an action, so it uses the
 * status-plus-action pattern the desktop-setup sections already have in
 * `DownloadAction` (an `Alert` with the control inside `AlertDescription`)
 * rather than hanging a button off a passive muted strip.
 */
function DesktopUndetectedAlert({
  latestVersion,
  onRecheck,
  phase,
}: {
  readonly latestVersion: string | null;
  readonly onRecheck: () => void;
  readonly phase: DesktopRecheckPhase;
}) {
  const checking = phase === DesktopRecheckPhase.Checking;

  return (
    <Alert>
      <MonitorIcon />
      <AlertDescription>
        <span>{describeUndetected(phase, latestVersion)}</span>
        <Button
          className="w-full"
          disabled={checking}
          onClick={onRecheck}
          size="sm"
          type="button"
          variant="outline"
        >
          {checking ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <RefreshCwIcon />
          )}
          {checking ? "Checking…" : "Check again"}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Copy for the terminal state.
 *
 * The detection result leads in every branch. A release lookup succeeds
 * independently of detection, so keying the honest sentence off `latestVersion`
 * would hide it in the branch almost nobody lands on and leave the re-check
 * sitting beside a sentence about the installer, with nothing on screen for it
 * to refer back to.
 */
function describeUndetected(
  phase: DesktopRecheckPhase,
  latestVersion: string | null
): string {
  if (phase === DesktopRecheckPhase.Checking) {
    return "Checking for Closedloop Desktop…";
  }

  const lead =
    phase === DesktopRecheckPhase.StillAbsent
      ? "Still not detected."
      : "Closedloop Desktop was not detected.";
  const version = latestVersion
    ? ` Version ${latestVersion} is available and automated setup will install it for you.`
    : "";

  return `${lead}${version} Install or open Closedloop Desktop, then check again.`;
}

/** Copy for the non-terminal state, which is still a probe in progress. */
function describeStillWatching(phase: DesktopRecheckPhase): string {
  if (phase === DesktopRecheckPhase.StillAbsent) {
    return "Still not detected. Watching for Closedloop Desktop…";
  }

  return "Looking for Closedloop Desktop…";
}
