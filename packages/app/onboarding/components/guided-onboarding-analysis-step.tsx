"use client";

import { ONBOARDING_SOURCE_RATIO_UNAVAILABLE_FLAG_KEY } from "@repo/api/src/types/onboarding-source-ratio-unavailable-flag";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  Progress,
  ProgressTone,
} from "@repo/design-system/components/ui/progress";
import {
  CheckIcon,
  CircleIcon,
  CircleSlashIcon,
  SearchIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useFeatureFlagEnabledOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import {
  formatBytes,
  formatNumber,
  KPI_NO_VALUE,
} from "../../shared/lib/format-utils";
import {
  getSourceProgressPercent,
  type OnboardingAnalysisEstimate,
  OnboardingAnalysisEstimateStatus,
  type OnboardingAnalysisProgress,
  OnboardingAnalysisProgressStatus,
  OnboardingProgressOperand,
  type OnboardingSessionDiscovery,
  type OnboardingSessionSource,
  type OnboardingSourceDetection,
} from "./guided-onboarding-data";
import {
  GuidedOnboardingBackButton,
  GuidedOnboardingStepLayout,
} from "./guided-onboarding-step-layout";
import type { GuidedOnboardingPhaseSource } from "./guided-onboarding-types";

export function GuidedOnboardingAnalysisStep({
  analysisStarted,
  brand,
  discovery,
  onBack,
  onContinue,
  progress,
}: {
  /**
   * Whether the analyzer has reported enough to leave this step — the SAME
   * boolean the machine's `canContinueFromDiscovery` guard reads, so an enabled
   * Continue can never be refused by the transition it fires.
   */
  analysisStarted: boolean;
  brand: ReactNode;
  discovery: OnboardingSessionDiscovery;
  onBack?: () => void;
  onContinue: () => void;
  progress: OnboardingAnalysisProgress;
}) {
  const percent = measuredPercent(progress);
  const ready = percent !== null && percent >= 100;
  const withheld = withheldOperand(progress);

  return (
    <GuidedOnboardingStepLayout
      body={
        <>
          <div className="mt-8">
            <Progress
              aria-label="Overall import progress"
              className="h-2.5"
              // A withheld percentage HOLDS rather than travels. The hatch still
              // says "amount unknown", which is true; the sweeping sheen over it
              // says "work is advancing", which is a claim nobody measured — and
              // on a store that cannot be reconciled it would never stop.
              paused={withheld !== null}
              sweep={!(ready || withheld !== null)}
              tone={
                percent === null ? ProgressTone.Neutral : ProgressTone.Default
              }
              value={percent ?? undefined}
            />
            {/*
              ISS-10584: NOT a live region. The percentage now advances with the
              import instead of sitting frozen, so announcing every change would
              queue a fresh utterance every couple of seconds for the length of a
              multi-minute import. The number is still in the accessibility tree
              — the `Progress` above is a `progressbar` carrying `aria-valuenow`
              and its own label — so this caption restates a value a reader can
              already reach on demand, and dropping the announcement removes the
              repetition rather than the statement.
            */}
            <div className="mt-2 flex justify-between font-medium text-muted-foreground text-xs tabular-nums">
              <span>{getProgressLabel(percent, withheld)}</span>
              <span>{getSessionsFoundLabel(discovery)}</span>
            </div>
          </div>
          <div className="mt-8 rounded-xl border bg-muted/20 p-5">
            <SourceList discovery={discovery} />
          </div>
        </>
      }
      brand={brand}
      description={getAnalysisDescription(discovery, ready)}
      eyebrow="Session discovery"
      footer={
        <>
          <GuidedOnboardingBackButton onBack={onBack} />
          <Button
            className="w-full sm:w-56"
            disabled={!analysisStarted}
            onClick={onContinue}
            size="lg"
            type="button"
          >
            Continue
          </Button>
        </>
      }
      title={getAnalysisTitle(discovery, ready)}
    />
  );
}

function SourceList({ discovery }: { discovery: OnboardingSessionDiscovery }) {
  if (discovery.status === "unknown" || discovery.sources.length === 0) {
    return (
      <EmptyState
        description="Each tool appears here with its own counts once the scan reports them."
        icon={SearchIcon}
        size="compact"
        title="No session sources reported yet"
      />
    );
  }

  return (
    <div className="space-y-5">
      {discovery.sources.map((source) => (
        <SourceProgress key={source.label} source={source} />
      ))}
    </div>
  );
}

/**
 * One source row. The bar states exactly what is known about that source:
 * a measured ratio is determinate; a detected source whose analyzed count is
 * still unread sweeps, because work is under way and its amount is not yet
 * known; a detected source whose RATIO was withheld holds instead, because that
 * read has settled and no quotient is coming — whether the count went with it or
 * the row still states 2,443 against 940 — and the row says so rather than
 * sweeping on forever; a source the host PROVED is not on the machine shows an
 * empty resting track — an indeterminate sweep there would animate work on a
 * tool that is not there. Unmeasured bars take the neutral tone, per the design
 * system's own rule for a value the caller could not measure.
 *
 * HOLDING THE BAR WAS NOT ENOUGH ON ITS OWN (ISS-10961). Held and sweeping are
 * the same hatch in the same tone, separated only by the travelling sheen — an
 * animation `prefers-reduced-motion` removes outright, over a texture, under one
 * accessible name shared by both. So a withheld row read as a scan that had
 * stalled, and a screen reader never had the distinction at all. Behind
 * {@link ONBOARDING_SOURCE_RATIO_UNAVAILABLE_FLAG_KEY} the row therefore SAYS
 * which of the two it is, in words, in its status text and in its bar's name;
 * see {@link explainedSourcePresentation}.
 */
function SourceProgress({ source }: { source: OnboardingSessionSource }) {
  // ISS-10961's one read site. The flag picks between two WHOLE row
  // presentations, so neither derivation below is handed a boolean and the two
  // cannot settle at different moments.
  const explainUnavailableRatio = useFeatureFlagEnabledOptional(
    ONBOARDING_SOURCE_RATIO_UNAVAILABLE_FLAG_KEY
  );
  const { detection, label } = source;
  const percent = getSourceProgressPercent(detection);
  const detected = detection.status === "detected";
  const complete = percent !== null && percent >= 100;
  const withheld = isAnalyzedWithheld(detection);
  // Every bar with no percentage takes the neutral tone, whether its read is
  // still in flight or its quotient was withheld. Which of the two it is only
  // decides whether the bar sweeps.
  const unmeasured = detected && percent === null;
  const presentation = explainUnavailableRatio
    ? explainedSourcePresentation(detection, label, complete)
    : shippedSourcePresentation(detection, label, complete);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 sm:grid-cols-[120px_1fr_auto] sm:gap-4">
      <div className="flex items-center gap-2 font-medium text-sm">
        {presentation.icon}
        {label}
      </div>
      <Progress
        aria-label={presentation.barName}
        className="order-3 col-span-2 h-1.5 sm:order-none sm:col-span-1"
        paused={withheld}
        sweep={detected && !complete && !withheld}
        tone={sourceTone(complete, unmeasured, detected)}
        value={sourceBarValue(percent, detected)}
      />
      <span className={presentation.statusClassName}>
        {presentation.statusLabel}
      </span>
    </div>
  );
}

function sourceTone(
  complete: boolean,
  unmeasured: boolean,
  detected: boolean
): ProgressTone {
  if (complete) {
    return ProgressTone.Success;
  }
  if (unmeasured || !detected) {
    return ProgressTone.Neutral;
  }
  return ProgressTone.Default;
}

/** Indeterminate only for a detected source still being measured. */
function sourceBarValue(
  percent: number | null,
  detected: boolean
): number | undefined {
  if (!detected) {
    return 0;
  }
  return percent ?? undefined;
}

/** The measured percentage, or `null` when there is none to state. */
function measuredPercent(progress: OnboardingAnalysisProgress): number | null {
  return progress.status === OnboardingAnalysisProgressStatus.Measured
    ? progress.percent
    : null;
}

function getSourceStatusLabel(detection: OnboardingSourceDetection): string {
  if (detection.status === "detected") {
    const found = `${formatNumber(detection.found)} found`;
    if (detection.analyzed !== null) {
      return `${found} · ${formatNumber(detection.analyzed)} analyzed`;
    }
    // The analyzed half is dropped rather than shown as zero: a store that has
    // not been read has analyzed an unknown number, not none. A store that was
    // read and could not be reconciled says so instead, because that row is
    // finished waiting and silence there reads as "still counting".
    return isAnalyzedWithheld(detection)
      ? `${found} · ${ANALYZED_UNAVAILABLE_LABEL}`
      : found;
  }
  return "Not detected";
}

function getSessionsFoundLabel(discovery: OnboardingSessionDiscovery): string {
  if (discovery.status === "unknown" || discovery.sessionsFound === null) {
    return "Session count unavailable";
  }
  return `${formatNumber(discovery.sessionsFound)} sessions found`;
}

/** Copy for a scan that has not reported its counts or its size yet (ISS-8678). */
const AWAITING_SCAN_DESCRIPTION =
  "Session counts, sizes, and the time estimate will appear here once the scan reports them. You can start using Closedloop in the meantime.";

/** Copy for an import that finished before the scan reported a count (ISS-8678). */
const FINISHED_WITHOUT_COUNT_DESCRIPTION =
  "The import finished. Session counts and sources will appear here once the scan reports them.";

/**
 * The step's description. The approved design has ONE sentence for a running
 * scan, and it names a size, a count and a duration. The two data-bearing
 * clauses render only once the host has supplied their values (ISS-8678); until
 * then the step uses the awaiting-scan copy that shipped with the seam rather
 * than a sentence written for the gap. The duration clause is the one that can
 * lag the other two by a few seconds, because the estimate needs throughput
 * samples the sweep does not, so it joins the sentence when it lands.
 */
function getAnalysisDescription(
  discovery: OnboardingSessionDiscovery,
  ready: boolean
): string {
  if (discovery.status === "unknown") {
    return ready
      ? FINISHED_WITHOUT_COUNT_DESCRIPTION
      : AWAITING_SCAN_DESCRIPTION;
  }
  const { logBytes, sessionsFound } = discovery;
  if (ready) {
    return sessionsFound === null
      ? FINISHED_WITHOUT_COUNT_DESCRIPTION
      : `All ${formatNumber(sessionsFound)} local sessions have been analyzed and your dashboard is up to date.`;
  }
  if (logBytes === null || sessionsFound === null) {
    return AWAITING_SCAN_DESCRIPTION;
  }
  const found = `We found ${formatBytes(logBytes)} of logs across ${formatNumber(sessionsFound)} local sessions.`;
  const estimate = getEstimateSentence(discovery.estimate);
  const background =
    "You can start using Closedloop while we continue analyzing your logs in the background.";
  return estimate === ""
    ? `${found} ${background}`
    : `${found} ${estimate} ${background}`;
}

/**
 * The time remaining, when there is one. `calculating` is the few seconds
 * before the first throughput samples land; `unavailable` and `complete` carry
 * no duration at all. None of them is a number, so none of them renders one.
 */
function getEstimateSentence(estimate: OnboardingAnalysisEstimate): string {
  if (estimate.status !== OnboardingAnalysisEstimateStatus.Measured) {
    return "";
  }
  return `Full analysis is estimated to take ${formatEstimatedMinutes(estimate.remainingMinutes)}.`;
}

/**
 * Sentence-voice minutes. Deliberately not `formatMinutesSpan`, whose "37m"
 * shorthand belongs in a dense metadata row rather than mid-sentence; the
 * pluralization matches the invite step's existing "email"/"emails" handling.
 */
function formatEstimatedMinutes(minutes: number): string {
  // Floored at 1, not 0. A sub-30s estimate rounds to zero, and "estimated to
  // take 0 minutes" is a completion claim — the exact fabrication the estimate
  // union refuses to make one branch away, arriving through the formatter.
  const whole = Math.max(1, Math.round(minutes));
  return `${formatNumber(whole)} ${whole === 1 ? "minute" : "minutes"}`;
}

/**
 * The step's heading. "Session analysis complete." is a claim about sessions,
 * so it needs the scan to have reported — `progress` alone is the import, and
 * at a measured 100% with an unknown scan the heading was announcing a
 * completed analysis of sessions nobody had counted (ISS-8678). An unknown scan
 * reuses the wording the source list already shows for the same state.
 */
function getAnalysisTitle(
  discovery: OnboardingSessionDiscovery,
  ready: boolean
): string {
  if (discovery.status === "unknown") {
    return "No sessions reported yet.";
  }
  return ready ? "Session analysis complete." : "Session analysis started.";
}

/**
 * What a detected row says in place of its analyzed count, and what the headline
 * says in place of its percentage.
 *
 * ONE string for both, so the row and the summary cannot describe the same
 * shortfall in two different words.
 */
export const ANALYZED_UNAVAILABLE_LABEL = "Analyzed count unavailable";

/**
 * The shortfall the screen may NAME, or `null` when there is a number instead.
 *
 * Keyed off the fold's own operand rather than off `percent === null`, which
 * cannot tell "we looked and cannot state this" from "nobody has reported yet".
 */
const PROGRESS_OPERAND_LABEL: Record<OnboardingProgressOperand, string> = {
  [OnboardingProgressOperand.AnalyzedSessions]: ANALYZED_UNAVAILABLE_LABEL,
};

function withheldOperand(
  progress: OnboardingAnalysisProgress
): OnboardingProgressOperand | null {
  return progress.status === OnboardingAnalysisProgressStatus.Unavailable
    ? progress.missing
    : null;
}

/**
 * The caption under the overall bar.
 *
 * A withheld percentage NAMES the operand that is missing rather than rendering
 * the same em-dash an unreported one does. Root `AGENTS.md`: suppressing a value
 * silently is forbidden — the reader has to be able to tell a slot that was
 * withheld from one that has not filled in yet.
 */
function getProgressLabel(
  percent: number | null,
  withheld: OnboardingProgressOperand | null
): string {
  if (percent !== null) {
    return `${percent}%`;
  }
  return withheld === null ? KPI_NO_VALUE : PROGRESS_OPERAND_LABEL[withheld];
}

/**
 * Whether this row's analyzed→found RATIO was withheld rather than merely
 * unread.
 *
 * Deliberately NOT gated on `analyzed === null`. Two different shortfalls set
 * the flag and only one of them takes the count with it: a corrupt read leaves
 * nothing to state, while a store that has outlived its transcripts still
 * states 2,443 and withholds only the quotient (ISS-10582). Requiring a null
 * count here let that second row fall back to `percent === null` and sweep for
 * the life of the screen, claiming active work beside a number it had already
 * finished measuring.
 */
function isAnalyzedWithheld(detection: OnboardingSourceDetection): boolean {
  return detection.status === "detected" && detection.analyzedWithheld === true;
}

export function selectAnalysisStepProps(
  source: GuidedOnboardingPhaseSource
): ComponentProps<typeof GuidedOnboardingAnalysisStep> {
  return {
    analysisStarted: source.analysisStarted,
    brand: source.brand,
    discovery: source.discovery,
    onBack: source.onBack,
    onContinue: source.onContinue ?? source.onComplete,
    progress: source.progress,
  };
}

/**
 * What a detected row says in place of its PERCENTAGE, when both of its counts
 * are real reads and only the quotient between them cannot be formed.
 *
 * Deliberately NOT {@link ANALYZED_UNAVAILABLE_LABEL}: that one stands in for a
 * missing analyzed COUNT, and on this row the count is present and stated a few
 * characters to its left. "Analyzed count unavailable" beside "72 analyzed"
 * would contradict the number next to it. Two different shortfalls, two
 * sentences.
 */
export const RATIO_UNAVAILABLE_LABEL = "Percentage unavailable";

/** What one source row renders, derived once so its four parts agree. */
type SourceRowPresentation = {
  readonly barName: string | undefined;
  readonly icon: ReactNode;
  readonly statusClassName: string;
  readonly statusLabel: string;
};

/** The status column exactly as it shipped: a MINIMUM width, right-aligned. */
export const SHIPPED_STATUS_CLASS =
  "text-right text-muted-foreground text-xs tabular-nums sm:min-w-36";

/**
 * The status column once a row may carry a third clause.
 *
 * Two geometry problems arrive with that clause and both are fixed here rather
 * than on the withheld row alone, because both are about how the rows line up
 * WITH EACH OTHER. Below `sm` the status takes a row of its own, the way the bar
 * already does: the mobile grid lets this `auto` track grow past the container
 * while the label track shrinks below its own min-content, so at 360 — the
 * width this wizard's own body class calls its worst case — a three-clause
 * string painted straight through "Claude Code" and clipped the glyph off the
 * left edge. At `sm` and up the track is a FIXED width instead of a minimum, so
 * every bar in the list ends at the same x: a minimum let the longest status
 * steal width from its own bar, which handed the one row whose whole message is
 * "there is no measurement here" the shortest track on screen, and a short
 * track reads as little progress. The bar contradicting the sentence beside it
 * is the defect this change exists to remove, not one to reintroduce.
 */
export const EXPLAINED_STATUS_CLASS =
  "order-2 col-span-2 text-muted-foreground text-xs tabular-nums sm:order-none sm:col-span-1 sm:w-48 sm:text-right";

/** The row's leading glyph for every state but a withheld ratio. */
function SourceGlyph({
  complete,
  detected,
}: {
  complete: boolean;
  detected: boolean;
}) {
  if (complete) {
    return <CheckIcon className="size-4 text-success" />;
  }
  if (detected) {
    return <CircleIcon className="size-3 fill-primary text-primary" />;
  }
  return <CircleIcon className="size-3 text-muted-foreground" />;
}

/** The row exactly as ISS-10582 shipped it, and the closed default here. */
function shippedSourcePresentation(
  detection: OnboardingSourceDetection,
  label: string,
  complete: boolean
): SourceRowPresentation {
  const detected = detection.status === "detected";
  return {
    barName: detected ? `${label} import progress` : undefined,
    icon: <SourceGlyph complete={complete} detected={detected} />,
    statusClassName: SHIPPED_STATUS_CLASS,
    statusLabel: getSourceStatusLabel(detection),
  };
}

/**
 * The same row, with the withheld state SAID rather than merely held
 * (ISS-10961).
 *
 * Only the withheld row changes what it SAYS; every other state defers to the
 * shipped presentation for its glyph, its bar name and its status text. The one
 * thing turning the key on does change list-wide is the status track's
 * GEOMETRY — every row takes {@link EXPLAINED_STATUS_CLASS}, deliberately,
 * because alignment is a property of the list and not of one row; a list with no
 * withheld row in it therefore still gets the widened, fixed-width track. See
 * that constant for why a per-row minimum could not work.
 *
 * The withheld row gives up nothing it had: both counts still render,
 * the bar is still the honest indeterminate hatch — there is no percentage to
 * fill it with — and what is added is the reason, in three places a reader can
 * actually reach. The glyph is the `CircleSlashIcon` the cascade steps already
 * use for a step that settled with nothing to report, rather than a new mark.
 */
function explainedSourcePresentation(
  detection: OnboardingSourceDetection,
  label: string,
  complete: boolean
): SourceRowPresentation {
  if (isAnalyzedWithheld(detection)) {
    return {
      // Not "import progress". A withheld read is not a progress reading, and
      // naming it one is what made the held bar and a sweeping one announce
      // identically. The shortfall comes from the same helper the status text
      // reads, so the bar cannot name one the row's own words never mention.
      barName: `${label} ${withheldShortfall(detection).toLowerCase()}`,
      icon: <CircleSlashIcon className="size-4 text-muted-foreground" />,
      statusClassName: EXPLAINED_STATUS_CLASS,
      statusLabel: explainedSourceStatusLabel(detection),
    };
  }
  return {
    ...shippedSourcePresentation(detection, label, complete),
    // Every row in the list shares the widened status track, so the bars stay
    // aligned with one another whether or not this row is the withheld one.
    statusClassName: EXPLAINED_STATUS_CLASS,
  };
}

/**
 * The status text for a withheld row, built ON TOP of the shipped one so the
 * counts cannot drift between the two presentations.
 *
 * A row that lost its analyzed count already names that shortfall and gets no
 * second clause; a row that kept both counts is the one that said nothing.
 */
function explainedSourceStatusLabel(
  detection: OnboardingSourceDetection
): string {
  const stated = getSourceStatusLabel(detection);
  if (withheldShortfall(detection) === RATIO_UNAVAILABLE_LABEL) {
    return `${stated} · ${RATIO_UNAVAILABLE_LABEL}`;
  }
  return stated;
}

/**
 * WHICH shortfall a withheld row is naming — the single switch the row's status
 * text and its bar's accessible name both read.
 *
 * Two shortfalls set the withheld marker and they are not the same sentence: a
 * read that came back unusable takes the analyzed COUNT with it, while a store
 * that has outlived its transcripts keeps both counts and gives up only the
 * QUOTIENT. Deriving the two renders from one switch is what stops the bar
 * announcing a missing percentage over a row whose words say the count is what
 * is missing.
 */
function withheldShortfall(detection: OnboardingSourceDetection): string {
  if (detection.status === "detected" && detection.analyzed !== null) {
    return RATIO_UNAVAILABLE_LABEL;
  }
  return ANALYZED_UNAVAILABLE_LABEL;
}
