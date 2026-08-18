"use client";

/**
 * @file convert-install-sheet.tsx
 * @description The "Install on <target> (convert from <source harness>)"
 * preview/confirm Sheet (FEA-4080), shared across the web and desktop packs
 * surfaces (`@repo/app/packs`).
 *
 * It reads the FEA-4078 capability dry-run (`resolveConversionCapability` — what
 * the conversion WOULD produce, per component kind and source→target harness)
 * and executes it through the FEA-4079 convert engine, which the owning surface
 * injects as the `onConvertInstall` callback (desktop wires
 * `window.desktopApi.db.catalogConvertInstall`; the shared component never
 * touches `window`). Provenance — the harness the component was originally
 * authored for — is shown throughout.
 *
 * Honest states, none color-only (WCAG 1.4.1 — icon shape + words):
 *  - clean       → converts losslessly; install on first confirm.
 *  - partial     → lossy; a warning `Alert` names the dropped fields and the user
 *                  must confirm PAST it before the install runs.
 *  - unsupported → blocked with a reason (no conversion exists for this pair).
 *  - offline     → blocked with a reason (can't convert-install to an offline
 *                  target).
 *  - converting  → in flight; the dismiss surface is sealed so no dismiss path
 *                  contradicts the running install.
 *  - error       → the last attempt failed. Retry stays available for a
 *                  transient/unclassified failure; a PERMANENT failure class
 *                  (invalid request, missing catalog command, invalid/missing
 *                  cwd) blocks the confirm and shows the engine's message.
 *
 * Accessible modal (DS Sheet = Radix Dialog): a focus trap + Escape-to-close come
 * from the primitive; the confirm/cancel controls carry explicit accessible names;
 * the in-flight body is an `aria-live` status region. The state vocabulary reuses
 * FEA-4083 `PackInstallState` treatments and the FEA-4080 summary/phase machine
 * (`../lib/convert-install-view`) rather than re-deriving glyphs or transitions.
 */

import type {
  ConvertInstallOutcome,
  ConvertInstallRequest,
} from "@repo/api/src/types/convert-install";
import type { ConversionCapability } from "@repo/api/src/types/harness-conversion";
import { resolveConversionCapability } from "@repo/api/src/types/harness-conversion";
import type { HarnessName } from "@repo/crewd/model";
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
  ArrowRightIcon,
  BanIcon,
  CheckCircle2Icon,
  DownloadIcon,
  Loader2Icon,
  TriangleAlertIcon,
  WifiOffIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { kindMeta } from "../../agents/lib/component-meta";
import {
  ConvertInstallPhase,
  ConvertInstallSummaryState,
  conversionIdentityKey,
  convertInstallPhaseForOutcome,
  displaySummaryState,
  isBlockedSummaryState,
  isRetryableFailure,
  phaseAfterConfirm,
  requiresLossConfirm,
  resolveConvertInstallSummaryState,
  summaryPackInstallState,
} from "../lib/convert-install-view";
import { PackInstallState } from "../lib/install-state";
import { InstallStateStatus } from "./install-state-status";

/**
 * The single component the Sheet converts and installs. DERIVED from the
 * canonical FEA-4079 {@link ConvertInstallRequest} as everything the engine keys
 * on EXCEPT `cwd` (which the owning surface resolves and forwards when it invokes
 * the engine — the Sheet never handles a working directory). Deriving it with
 * `Omit` rather than hand-mirroring the fields means a new required field added
 * to `ConvertInstallRequest` breaks this seam at compile time instead of silently
 * diverging (wongk review). The owning surface resolves a pack's `Harness` to a
 * concrete crewd `HarnessName` before it reaches here.
 */
export type ConvertInstallTarget = Omit<ConvertInstallRequest, "cwd">;

type ConvertInstallSheetProps = {
  /** The component to convert-install, or null to keep the Sheet closed. */
  readonly target: ConvertInstallTarget | null;
  /**
   * Whether the install target device is reachable. `false` blocks the convert
   * with the honest "offline" reason (a convert that WOULD succeed still can't
   * run against an unreachable target). Defaults to online.
   */
  readonly targetOffline?: boolean;
  /** Close request from any dismiss path (Cancel / Escape / overlay / Done). */
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Execute the convert + install through the FEA-4079 engine. Injected by the
   * surface (desktop: `window.desktopApi.db.catalogConvertInstall`) so this
   * shared component stays surface-agnostic. Resolves to the honest
   * {@link ConvertInstallOutcome}; a thrown/rejected call is treated as a
   * retryable error.
   */
  readonly onConvertInstall: (
    target: ConvertInstallTarget
  ) => Promise<ConvertInstallOutcome>;
  /** Display label for a {@link HarnessName} (e.g. "Claude"). */
  readonly harnessLabel: (harness: HarnessName) => string;
};

// "Codex -> Claude" harness direction as plain text, so the conversion
// direction is legible without color (matches the convert prototype).
const HarnessArrow = ({ from, to }: { from: string; to: string }) => (
  <span className="inline-flex items-center gap-1.5 font-medium text-sm">
    {from}
    <ArrowRightIcon
      aria-label="converts to"
      className="size-3.5 text-muted-foreground"
    />
    {to}
  </span>
);

// Source provenance: where the component came from, always visible so the user
// never loses track of what they are converting from.
const SourceProvenance = ({
  target,
  sourceHarnessLabel,
  currentHarnessLabel,
}: {
  target: ConvertInstallTarget;
  sourceHarnessLabel: string;
  currentHarnessLabel: string;
}) => {
  // When the component has already been converted once, its CURRENT format
  // differs from its origin — name both so the provenance stays honest across
  // repeated conversions (FEA-4028). A never-converted component's format IS its
  // origin, so we don't restate it (that would just echo the direction arrow).
  const reconverted = currentHarnessLabel !== sourceHarnessLabel;
  // Human-readable component kind ("MCP tool", "Memory & config", "Agent") from
  // the canonical KIND_META map — never the raw enum. The indefinite article
  // agrees with the harness label that follows it ("a Claude …", "an OpenCode …").
  const kindLabel = kindMeta(target.kind).label.toLowerCase();
  const article = startsWithVowelSound(sourceHarnessLabel) ? "an" : "a";
  return (
    <section aria-label="Source component" className="space-y-1.5">
      <span className="font-medium text-sm">{target.name}</span>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Originally {article} {sourceHarnessLabel} {kindLabel}
        {reconverted ? `, currently in ${currentHarnessLabel} format` : ""}.
      </p>
    </section>
  );
};

// The convertibility banner shown above the field breakdown before confirm.
// Clean and partial are both installable (partial carries a dropped-field
// warning that must be confirmed past); unsupported and offline are blocked.
const SummaryBanner = ({
  summaryState,
  capability,
  target,
}: {
  summaryState: ConvertInstallSummaryState;
  capability: ConversionCapability;
  target: string;
}) => {
  if (summaryState === ConvertInstallSummaryState.Offline) {
    return (
      <Alert variant="error">
        <WifiOffIcon />
        <AlertTitle>{target} is offline</AlertTitle>
        <AlertDescription>
          That target is unreachable right now, so it can't be converted and
          installed on. Install is blocked until it comes back online.
        </AlertDescription>
      </Alert>
    );
  }
  if (summaryState === ConvertInstallSummaryState.Unsupported) {
    return (
      <Alert variant="error">
        <BanIcon />
        <AlertTitle>Can't convert to {target}</AlertTitle>
        <AlertDescription>
          No conversion exists for this component on {target}, so it can't run
          there. Install is blocked.
        </AlertDescription>
      </Alert>
    );
  }
  if (summaryState === ConvertInstallSummaryState.Partial) {
    const dropped = capability.droppedFields.length;
    return (
      <Alert variant="warning">
        <TriangleAlertIcon />
        <AlertTitle>Lossy conversion</AlertTitle>
        <AlertDescription>
          {dropped} {dropped === 1 ? "field" : "fields"} can't be represented on{" "}
          {target} and will be dropped. Review below, then confirm to install
          anyway.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="success">
      <CheckCircle2Icon />
      <AlertTitle>Converts cleanly</AlertTitle>
      <AlertDescription>
        Everything maps onto {target} with no changes.
      </AlertDescription>
    </Alert>
  );
};

// The list of source-format fields the target format can't carry, shown so the
// "what's lost" is explicit before the user confirms a partial install.
const DroppedFields = ({ fields }: { fields: readonly string[] }) => {
  if (fields.length === 0) {
    return null;
  }
  return (
    <section aria-label="Fields dropped in conversion" className="space-y-2">
      <h3 className="font-medium text-sm">Dropped in the conversion</h3>
      <ul className="space-y-1">
        {fields.map((field) => (
          <li
            className="flex items-center gap-2 text-muted-foreground text-sm"
            key={field}
          >
            <TriangleAlertIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-warning-foreground"
            />
            <span>{field}</span>
          </li>
        ))}
      </ul>
    </section>
  );
};

// The failure Alert shown when a prior convert/install attempt failed. It reports
// the engine's actionable, detail-free `message` when the outcome carried one,
// and tells the truth about retryability: a PERMANENT failure (invalid request,
// missing catalog command, invalid/missing working directory) can never succeed
// on retry, so the copy says the install is blocked rather than inviting a retry
// that would fail again (wongk review). A transient/unclassified failure keeps
// the "Try again" invitation.
const FailureAlert = ({
  targetLabel,
  message,
  permanent,
}: {
  targetLabel: string;
  message?: string;
  permanent: boolean;
}) => (
  <Alert variant="error">
    {permanent ? <BanIcon /> : <XCircleIcon />}
    <AlertTitle>
      {permanent ? `Can't install on ${targetLabel}` : "Install failed"}
    </AlertTitle>
    <AlertDescription>
      {message
        ? message
        : `The convert or install didn't finish on ${targetLabel}. Nothing was left half-installed.`}{" "}
      {permanent
        ? "This request can't succeed, so install is blocked."
        : "Try again."}
    </AlertDescription>
  </Alert>
);

// The resting preview: provenance, one banner, and (for a partial convert) the
// dropped-field list. On a prior failure the failure alert REPLACES the summary
// banner rather than stacking — the failure is now the "read this first".
const PreviewBody = ({
  target,
  summaryState,
  capability,
  targetLabel,
  sourceHarnessLabel,
  currentHarnessLabel,
  showError,
  failureOutcome,
  failurePermanent,
}: {
  target: ConvertInstallTarget;
  summaryState: ConvertInstallSummaryState;
  capability: ConversionCapability;
  targetLabel: string;
  sourceHarnessLabel: string;
  currentHarnessLabel: string;
  showError: boolean;
  failureOutcome: ConvertInstallOutcome | null;
  failurePermanent: boolean;
}) => (
  <div className="space-y-5">
    <SourceProvenance
      currentHarnessLabel={currentHarnessLabel}
      sourceHarnessLabel={sourceHarnessLabel}
      target={target}
    />
    {showError ? (
      <FailureAlert
        message={failureOutcome?.message}
        permanent={failurePermanent}
        targetLabel={targetLabel}
      />
    ) : (
      <SummaryBanner
        capability={capability}
        summaryState={summaryState}
        target={targetLabel}
      />
    )}
    {summaryState === ConvertInstallSummaryState.Partial ? (
      <DroppedFields fields={capability.droppedFields} />
    ) : null}
  </div>
);

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

const DoneBody = ({
  target,
  targetLabel,
  currentHarnessLabel,
  outcome,
}: {
  target: ConvertInstallTarget;
  targetLabel: string;
  currentHarnessLabel: string;
  outcome: ConvertInstallOutcome;
}) => {
  const dropped = outcome.droppedFields;
  return (
    <div
      aria-live="polite"
      className="flex flex-col items-center gap-3 py-12 text-center"
      role="status"
    >
      <CheckCircle2Icon aria-hidden="true" className="size-6 text-success" />
      <p className="font-medium text-sm">
        {dropped.length > 0
          ? `Installed on ${targetLabel} with changes`
          : `Installed on ${targetLabel}`}
      </p>
      <p className="max-w-xs text-muted-foreground text-sm leading-relaxed">
        {target.name} converted from {currentHarnessLabel} and is ready to use.
      </p>
      {dropped.length > 0 ? (
        <div className="w-full max-w-xs space-y-1.5 text-left">
          <p className="text-muted-foreground text-xs">
            Dropped in the conversion:
          </p>
          <ul className="space-y-1">
            {dropped.map((field) => (
              <li className="text-muted-foreground text-sm" key={field}>
                {field}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
};

const confirmLabel = (params: {
  phase: ConvertInstallPhase;
  summaryState: ConvertInstallSummaryState;
  retryable: boolean;
}): string => {
  if (isBlockedSummaryState(params.summaryState)) {
    return "Can't install";
  }
  if (params.phase === ConvertInstallPhase.Converting) {
    return "Installing";
  }
  if (params.phase === ConvertInstallPhase.Error) {
    // A permanent failure can't succeed on retry, so the confirm reads as
    // blocked rather than inviting a retry that would fail again (wongk review).
    return params.retryable ? "Try again" : "Can't install";
  }
  return requiresLossConfirm(params.summaryState)
    ? "Convert and install anyway"
    : "Convert and install";
};

// The sheet body for a single selected target. It owns the install phase and
// the resolved outcome. Mounted keyed by the full conversion identity (see
// `conversionIdentityKey`) so a new selection OR a harness-target switch on the
// same pack remounts fresh in Preview — no reset effect, and no stale Done/Error
// paint from the previous conversion on the first frame.
const ConvertInstallSheetBody = ({
  target,
  targetOffline,
  onOpenChange,
  onConvertInstall,
  harnessLabel,
}: {
  target: ConvertInstallTarget;
  targetOffline: boolean;
  onOpenChange: (open: boolean) => void;
  onConvertInstall: (
    target: ConvertInstallTarget
  ) => Promise<ConvertInstallOutcome>;
  harnessLabel: (harness: HarnessName) => string;
}) => {
  const [phase, setPhase] = useState<ConvertInstallPhase>(
    ConvertInstallPhase.Preview
  );
  const [outcome, setOutcome] = useState<ConvertInstallOutcome | null>(null);

  const capability = resolveConversionCapability(
    target.kind,
    target.currentHarness,
    target.targetHarness
  );
  const summaryState = resolveConvertInstallSummaryState({
    capability,
    targetOffline,
  });
  const targetLabel = harnessLabel(target.targetHarness);
  const sourceHarnessLabel = harnessLabel(
    target.sourceHarness ?? target.currentHarness
  );
  const currentHarnessLabel = harnessLabel(target.currentHarness);
  const isBlocked = isBlockedSummaryState(summaryState);
  const isConverting = phase === ConvertInstallPhase.Converting;
  const isError = phase === ConvertInstallPhase.Error;
  // The outcome contract carries a `failureClass` distinguishing a retryable
  // (transient / unclassified) failure from a permanent one the same request can
  // never satisfy. Retry stays enabled only for the former; a permanent failure
  // (invalid request, missing catalog command, invalid/missing cwd) blocks the
  // confirm rather than offering a retry that would immediately fail again. A
  // rejected engine call leaves no outcome (undefined class) and degrades to
  // retryable so older producers stay safe (wongk review).
  const retryable = isRetryableFailure(outcome?.failureClass);
  const errorPermanent = isError && !retryable;
  // The single canonical status token the header shows, in the FEA-4083
  // vocabulary shared with every other packs surface. It tracks the live phase
  // (converting / error) on top of the pre-execution verdict, and is hidden once
  // installed (the Done body carries its own success treatment).
  const displayState = displaySummaryState({ summaryState, phase });
  const confirmButtonLabel = confirmLabel({ phase, summaryState, retryable });

  const handleConfirm = useCallback(async () => {
    const next = phaseAfterConfirm({ phase, summaryState });
    if (next !== ConvertInstallPhase.Converting) {
      return;
    }
    setPhase(ConvertInstallPhase.Converting);
    try {
      const result = await onConvertInstall(target);
      setOutcome(result);
      setPhase(convertInstallPhaseForOutcome(result.state));
    } catch {
      // A rejected engine call degrades to the retryable error phase rather
      // than an unhandled rejection — the boundary must never crash the UI.
      setOutcome(null);
      setPhase(ConvertInstallPhase.Error);
    }
  }, [onConvertInstall, phase, summaryState, target]);

  // Mid-convert the whole dismiss surface is sealed: Cancel is disabled, the
  // built-in X is hidden, and Escape / overlay-click are prevented — so no
  // dismiss path contradicts another while the install runs.
  const preventDismissWhileConverting = (event: Event) => {
    if (isConverting) {
      event.preventDefault();
    }
  };

  const isDone = phase === ConvertInstallPhase.Done;

  return (
    <SheetContent
      className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
      hideClose={isConverting}
      onEscapeKeyDown={preventDismissWhileConverting}
      onInteractOutside={preventDismissWhileConverting}
    >
      <SheetHeader className="gap-3 border-border border-b p-5">
        <div className="flex items-start justify-between gap-3">
          <SheetTitle>
            {isBlocked || errorPermanent
              ? `Can't install on ${targetLabel}`
              : `Install on ${targetLabel}`}
          </SheetTitle>
          {isDone ? null : (
            <InstallStateStatus
              className="shrink-0"
              state={
                errorPermanent
                  ? PackInstallState.Unsupported
                  : summaryPackInstallState(displayState)
              }
            />
          )}
        </div>
        <SheetDescription asChild>
          <div>
            {/* The conversion runs from the component's CURRENT format, not its
                original provenance: a Claude-authored component already in Codex
                format converts Codex → target, so the arrow names the current
                harness (wongk review). Provenance stays visible in the body. */}
            <HarnessArrow from={currentHarnessLabel} to={targetLabel} />
          </div>
        </SheetDescription>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {isConverting ? <ConvertingBody target={targetLabel} /> : null}
        {isDone && outcome ? (
          <DoneBody
            currentHarnessLabel={currentHarnessLabel}
            outcome={outcome}
            target={target}
            targetLabel={targetLabel}
          />
        ) : null}
        {phase === ConvertInstallPhase.Preview ||
        phase === ConvertInstallPhase.Error ? (
          <PreviewBody
            capability={capability}
            currentHarnessLabel={currentHarnessLabel}
            failureOutcome={outcome}
            failurePermanent={errorPermanent}
            showError={isError}
            sourceHarnessLabel={sourceHarnessLabel}
            summaryState={summaryState}
            target={target}
            targetLabel={targetLabel}
          />
        ) : null}
      </div>

      <SheetFooter className="flex-row justify-end gap-2 border-border border-t p-5">
        {isDone ? (
          <Button onClick={() => onOpenChange(false)} type="button">
            Done
          </Button>
        ) : (
          <>
            <Button
              aria-label="Cancel convert and install"
              disabled={isConverting}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              aria-label={confirmButtonLabel}
              className="gap-1.5"
              disabled={isBlocked || isConverting || errorPermanent}
              onClick={handleConfirm}
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
              {confirmButtonLabel}
            </Button>
          </>
        )}
      </SheetFooter>
    </SheetContent>
  );
};

/**
 * Outer wrapper: the Sheet stays mounted so Radix can play the close animation
 * on dismiss. The body is keyed by the full CONVERSION IDENTITY (packId + source
 * + current + target harness), so switching any conversion axis while the Sheet
 * stays mounted remounts a fresh state machine — a stale in-flight result from
 * the previous conversion can never paint Done against a new target (wongk
 * review). Keying by `packId` alone let that stale completion survive an axis
 * switch.
 */
export const ConvertInstallSheet = ({
  target,
  targetOffline = false,
  onOpenChange,
  onConvertInstall,
  harnessLabel,
}: ConvertInstallSheetProps) => (
  <Sheet onOpenChange={onOpenChange} open={target !== null}>
    {target ? (
      <ConvertInstallSheetBody
        harnessLabel={harnessLabel}
        key={conversionIdentityKey(target)}
        onConvertInstall={onConvertInstall}
        onOpenChange={onOpenChange}
        target={target}
        targetOffline={targetOffline}
      />
    ) : null}
  </Sheet>
);

// Leading vowel-sound letters, for choosing "a" vs "an" before a harness label
// ("a Claude …" / "an OpenCode …"). A coarse first-letter test is enough for the
// harness names in play; it isn't a general English article resolver.
const VOWEL_SOUND_START = /^[aeiou]/i;

function startsWithVowelSound(word: string): boolean {
  return VOWEL_SOUND_START.test(word);
}
