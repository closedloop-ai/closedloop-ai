"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import type { BranchViewCheck } from "@repo/api/src/types/branch-check-projection";
import {
  BranchViewChecksProviderState,
  CheckRowOutcomeBucket,
  checkRowOutcomeBucket,
  isWholeMeasuredPopulation,
} from "@repo/api/src/types/branch-check-projection";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import type { ToneLabelVariant } from "@repo/design-system/components/ui/tone-label";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useId, useState } from "react";
import {
  CHECK_ROW_BUCKET_VARIANT,
  CHECKS_POPULATION_EMPTY_LABEL,
  CHECKS_PROVIDER_UNAVAILABLE_LABEL,
  CHECKS_ROLLUP_UNREPORTED_LABEL,
  CHECKS_STATUS_UNREPORTED_LABEL,
  checkRowOutcome,
  checksPopulationShortfall,
} from "../../lib/checks-status-display";
import { BranchPrStatusRow } from "./branch-pr-status-row";

export type BranchPrMeasuredChecksProps = {
  detail: BranchPageDetail;
};

type MeasuredChecksStatement = {
  label: string;
  variant: ToneLabelVariant;
  items: readonly BranchViewCheck[];
  /**
   * ISS-8629: the population's shortfall in words, or `null` where there is
   * none. Derived ONCE beside the tone it explains, from the same predicate, so
   * the sentence and the colour cannot disagree about whether this population
   * is complete.
   */
  shortfall: string | null;
};

/**
 * ISS-8241 Half A: the selected pull request's checks as a producer MEASURED
 * them, or a named non-answer.
 *
 * Four non-answers, four sentences, none borrowing another's. `Checks not
 * reported` means no producer reached this pull request's head at all — the
 * projection is absent, which is the ONLY state spelled by absence. `Checks
 * could not be read` means a producer tried and the provider failed. `No checks
 * on this revision` is a measured EMPTY population, a fact about the revision
 * rather than a gap. `Checks outcome not reported` is a measured non-empty
 * population whose rows did not come back, so nothing can be said about what
 * ran. Anything else has rows, and the rows are the answer.
 *
 * The breakdown and the per-row words are the SAME vocabulary the live panel
 * beside this one renders, through the shared `checkRowOutcome` map, so turning
 * the flag on changes where the checks come from and not what a reader can learn
 * from them.
 *
 * Where rows exist the summary is COUNTED FROM THOSE ROWS, never from the
 * `checksStatus` column beside them. That column has writers which move it
 * without touching the rows — a `synchronize` redelivery stamps it `PENDING` at
 * an unchanged head, and the projection writer sets it from the PR-list rollup —
 * so pairing the two would put a headline word directly above a list that
 * contradicts it, which is the same defect one layer up.
 *
 * There is deliberately no freshness note, refresh control, or live-versus-
 * measured switch: this render lagging the provider between projection writes is
 * the cost Perrin accepted on 2026-08-27, not a gap to paper over.
 */
export function BranchPrMeasuredChecks({
  detail,
}: BranchPrMeasuredChecksProps) {
  const [open, setOpen] = useState(false);
  const shortfallId = useId();
  const statement = measuredChecksStatement(detail);
  if (statement.items.length === 0) {
    return (
      <BranchPrStatusRow
        label="Checks"
        value={
          <ToneLabel variant={statement.variant}>{statement.label}</ToneLabel>
        }
      />
    );
  }

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger
        aria-describedby={statement.shortfall ? shortfallId : undefined}
        className="flex w-full items-center gap-2 text-left text-sm"
      >
        <ChevronRightIcon
          aria-hidden
          className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-muted-foreground">Checks</span>
        <ToneLabel className="ml-auto tabular-nums" variant={statement.variant}>
          {statement.label}
        </ToneLabel>
      </CollapsibleTrigger>
      {statement.shortfall ? (
        <p className="mt-1 pl-5 text-muted-foreground text-xs" id={shortfallId}>
          {statement.shortfall}
        </p>
      ) : null}
      <CollapsibleContent>
        <div className="mt-2 divide-y border-t">
          {statement.items.map((check) => (
            <CheckRow check={check} key={check.id} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const NOTHING_MEASURED: MeasuredChecksStatement = {
  label: CHECKS_STATUS_UNREPORTED_LABEL,
  variant: "default",
  items: [],
  shortfall: null,
};

function CheckRow({ check }: { check: BranchViewCheck }) {
  const outcome = checkRowOutcome(check.status, check.conclusion);
  return (
    <div className="flex items-center gap-3 py-2 text-xs">
      <span className="min-w-0 flex-1 truncate">{check.name}</span>
      <ToneLabel variant={outcome.variant}>{outcome.label}</ToneLabel>
      {check.targetUrl ? (
        <a
          aria-label={`Open ${check.name} check`}
          className="text-muted-foreground hover:text-foreground"
          href={check.targetUrl}
          rel="noreferrer"
          target="_blank"
        >
          <ExternalLinkIcon aria-hidden className="size-3.5" />
        </a>
      ) : null}
    </div>
  );
}

function measuredChecksStatement(
  detail: BranchPageDetail
): MeasuredChecksStatement {
  const projection = detail.selectedPullRequestChecksProjection;
  if (!projection) {
    return NOTHING_MEASURED;
  }
  if (
    projection.providerState ===
    BranchViewChecksProviderState.ProviderUnavailable
  ) {
    return {
      ...NOTHING_MEASURED,
      label: CHECKS_PROVIDER_UNAVAILABLE_LABEL,
      variant: "warning",
    };
  }
  if (projection.providerState === BranchViewChecksProviderState.NoChecks) {
    return { ...NOTHING_MEASURED, label: CHECKS_POPULATION_EMPTY_LABEL };
  }
  if (projection.items.length === 0) {
    // Measured, non-empty by its own count, and yet no rows came back. Nobody
    // can say what ran, so this names the gap rather than borrowing either
    // neighbour's sentence.
    return { ...NOTHING_MEASURED, label: CHECKS_ROLLUP_UNREPORTED_LABEL };
  }
  const whole = isWholeMeasuredPopulation(projection);
  return {
    ...breakdown(projection.items, whole),
    items: projection.items,
    shortfall: checksPopulationShortfall(projection),
  };
}

/**
 * The summary counted from the rows in hand, in their own words, toned by the
 * worst outcome present — a failure outranks a pending run, which outranks a
 * pass, so the colour never reads better than the list does.
 *
 * The categories are stated in that same worst-first order rather than in the
 * order the rows happened to arrive, so two reads of one population cannot
 * word the summary differently, and the part a reader most needs comes first.
 *
 * ISS-8629: an INCOMPLETE population starts at `Inconclusive` rather than
 * `Passed`, so the passing tone is withheld until every row is in hand — Kaito's
 * ruling of 2026-08-31. This is the same reasoning the unreadable-word rule
 * already applies below: what the render has not seen cannot lift the headline to
 * green. A failure or an unfinished run still outranks the seed, so only the
 * green is withheld and never a warning a reader needs. The LABEL is untouched —
 * it tallies the rows in hand and never claimed to verdict the population — and
 * `checksPopulationShortfall` states the shortfall in words beneath, because a
 * withheld tone is a colour and WCAG 1.4.1 forbids carrying this in hue alone.
 */
function breakdown(
  items: readonly BranchViewCheck[],
  wholePopulation: boolean
): {
  label: string;
  variant: ToneLabelVariant;
} {
  const tally = new Map<string, { count: number; severity: number }>();
  let worst: CheckRowOutcomeBucket = wholePopulation
    ? CheckRowOutcomeBucket.Passed
    : CheckRowOutcomeBucket.Inconclusive;
  for (const check of items) {
    const outcome = checkRowOutcome(check.status, check.conclusion);
    // An unreadable outcome is neither a pass nor a failure. It tones as one of
    // the inconclusive rows so an unrecognized word can never lift the headline.
    const bucket =
      checkRowOutcomeBucket(check.status, check.conclusion) ??
      CheckRowOutcomeBucket.Inconclusive;
    const severity = BUCKET_SEVERITY[bucket];
    const seen = tally.get(outcome.label);
    tally.set(outcome.label, { count: (seen?.count ?? 0) + 1, severity });
    if (severity > BUCKET_SEVERITY[worst]) {
      worst = bucket;
    }
  }
  const categories = Array.from(tally, ([label, entry]) => ({
    label,
    ...entry,
  }))
    .sort(
      (left, right) =>
        right.severity - left.severity || left.label.localeCompare(right.label)
    )
    .map((entry) => `${entry.label} ${entry.count}`);
  return {
    label: categories.join(" · "),
    variant: CHECK_ROW_BUCKET_VARIANT[worst],
  };
}

/**
 * Which outcome wins the headline. Exhaustive over the bucket union so a bucket
 * added upstream fails typecheck here — a side inventory that merely TYPED its
 * keys would still compile with the new member missing, and the missing member
 * would silently rank as the BEST outcome.
 */
const BUCKET_SEVERITY: Record<CheckRowOutcomeBucket, number> = {
  [CheckRowOutcomeBucket.Passed]: 0,
  [CheckRowOutcomeBucket.Inconclusive]: 1,
  [CheckRowOutcomeBucket.Pending]: 2,
  [CheckRowOutcomeBucket.Failed]: 3,
};
