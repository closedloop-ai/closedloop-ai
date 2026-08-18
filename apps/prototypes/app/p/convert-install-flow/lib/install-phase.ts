// The install-phase state machine for the Convert & Install sheet, extracted as
// pure functions so the transitions — confirm, resolve to installed/error,
// retry, the blocked guard, and the stepper mapping — are unit-testable without
// a DOM. The sheet component (convert-sheet.tsx) drives these; the sandbox test
// suite is node-only, so the logic that matters lives here rather than inside
// the render.

import { Convertibility, InstallOutcome, type SourceComponent } from "../mock";

// The install phase, driven by the confirm button. Preview is the resting
// state; converting is the in-flight dry-run-to-install; installed and error
// are terminal (error is retryable back into converting).
export const InstallPhase = {
  Preview: "preview",
  Converting: "converting",
  Installed: "installed",
  Error: "error",
} as const;

export type InstallPhase = (typeof InstallPhase)[keyof typeof InstallPhase];

// The flow steps shown in the header stepper. Discover is behind us by the time
// the sheet is open (the user picked a component to reach here); Preview and
// Install are the two steps inside the sheet.
export const STEPS = ["Discover", "Preview", "Install"] as const;
export type Step = (typeof STEPS)[number];

export const isBlocked = (source: SourceComponent): boolean =>
  source.convertibility === Convertibility.Blocked;

// Confirm is a no-op when install is blocked or already running; otherwise it
// starts the convert. Reused so the button's disabled state and the transition
// can never disagree.
export const phaseAfterConfirm = (
  phase: InstallPhase,
  source: SourceComponent
): InstallPhase => {
  if (isBlocked(source) || phase === InstallPhase.Converting) {
    return phase;
  }
  return InstallPhase.Converting;
};

// How the in-flight convert resolves, from the component's mocked outcome.
export const phaseAfterConvert = (source: SourceComponent): InstallPhase =>
  source.installOutcome === InstallOutcome.Error
    ? InstallPhase.Error
    : InstallPhase.Installed;

// Converting and Installed both live in the Install step; only the resting and
// error preview sit on Preview. Keeps the stepper honest while the install runs
// instead of leaving Preview active through the in-flight phase.
export const activeStepFor = (phase: InstallPhase): Step =>
  phase === InstallPhase.Converting || phase === InstallPhase.Installed
    ? "Install"
    : "Preview";

export const confirmLabel = (phase: InstallPhase, blocked: boolean): string => {
  if (blocked) {
    return "Can't install";
  }
  if (phase === InstallPhase.Converting) {
    return "Installing";
  }
  if (phase === InstallPhase.Error) {
    return "Try again";
  }
  return "Convert and install";
};
