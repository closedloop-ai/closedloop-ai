import {
  OTHER_MODEL_PROVIDER,
  providerOf,
} from "@repo/app/insights/lib/model-provider";
import type {
  AgentsInsightsResponse,
  CategoryBucket,
} from "@closedloop-ai/loops-api/insights";
import { CpuIcon, LayersIcon, TerminalIcon } from "lucide-react";
import { harnessDisplayLabel } from "../../import-splash/import-splash-state";
import type { TourStep, TourSummaryChip, TourSummaryRow } from "./tour";

/**
 * The models caption the tour has always shown. Kept verbatim on the flag-off
 * path: it is a claim about the product, not about this device's data, and
 * nothing else in the flag-off intro changes.
 */
const LEGACY_MODELS_CAPTION = "across Claude, OpenAI, and more.";
/** How the unrecognized-provider bucket reads inside a sentence. */
const OTHER_PROVIDERS_LABEL = "other providers";
const PROVIDER_LIST_FORMAT = new Intl.ListFormat("en-US", {
  style: "long",
  type: "conjunction",
});

export type BuildTourStepsOptions = {
  sessionsTotal: number;
  agents: AgentsInsightsResponse | undefined;
  /**
   * ISS-5112 — the resolved `guest-onboarding` Labs flag. On, the tour is the
   * guest's first look at the product: it gains a "Harnesses found" row and
   * drops the Recent Sessions spotlight. Off, every step is byte-for-byte what
   * shipped before.
   */
  guestOnboardingEnabled: boolean;
  /**
   * Harness ids found in the local store, most-used first, with the `unknown`
   * bucket already dropped (see `useTourHarnesses`). Empty means "nothing found
   * yet, or still reading" — the row is omitted rather than shown empty.
   */
  harnesses: readonly string[];
};

export function buildTourSteps({
  sessionsTotal,
  agents,
  guestOnboardingEnabled,
  harnesses,
}: BuildTourStepsOptions): TourStep[] {
  const modelsKpi = agents?.kpis.find((kpi) => kpi.key === "models");
  const modelChips: TourSummaryChip[] = (agents?.charts.modelBreakdown ?? [])
    .slice(0, 4)
    .map((bucket) => ({ label: bucket.label, mono: true }));
  const extraModels = Math.max(
    0,
    (agents?.charts.modelBreakdown.length ?? 0) - modelChips.length
  );
  if (extraModels > 0) {
    modelChips.push({
      label: `+${extraModels} more`,
      mono: false,
      muted: true,
    });
  }

  const summary: TourSummaryRow[] = [
    {
      icon: <LayersIcon size={15} />,
      label: "Sessions parsed",
      value: sessionsTotal.toLocaleString(),
      sub: "found on this device",
    },
    {
      icon: <CpuIcon size={15} />,
      label: "Models in use",
      value: modelsKpi ? String(modelsKpi.value) : undefined,
      chips: modelChips.length > 0 ? modelChips : undefined,
      sub: modelsCaption(
        agents?.charts.modelBreakdown ?? [],
        guestOnboardingEnabled
      ),
    },
    // Last, deliberately. It is the one row with no number, so between the two
    // rows that have one it punched a hole in the value column. Ending on it
    // lets the column read number, number, then terminate.
    ...buildHarnessSummaryRows(guestOnboardingEnabled, harnesses),
  ];

  const steps: TourStep[] = [
    {
      intro: true,
      eyebrow: "Ready",
      title: "Build and see how your agents perform",
      body: "Your local agent session logs have been parsed and analyzed. Keep using AI the way you already do — Closedloop runs quietly in the background and shows you how your agents are performing.",
      summary,
    },
    {
      sel: "stats",
      eyebrow: "Your numbers",
      title: "The headline metrics",
      body: "Sessions, token spend, PRs shipped, and lines of code per dollar. Every figure computed right here on this Mac.",
    },
    {
      sel: "activity",
      eyebrow: "Activity",
      title: "When the work happens",
      body: "Each agent run on this machine, plotted across the selected window.",
    },
  ];
  // ISS-5112: guest mode trims the walkthrough to five beats. The Recent
  // Sessions card still renders (and keeps its `data-tour` anchor) — only its
  // spotlight step goes, so a first-run guest reaches the end sooner.
  if (!guestOnboardingEnabled) {
    steps.push({
      sel: "sessions",
      eyebrow: "Detail",
      title: "Every session, drillable",
      body: "A live log of each run — status, repo, model, and cost. Any row opens the full session replay.",
    });
  }
  steps.push(
    {
      sel: "models",
      eyebrow: "Models",
      title: "Which models did the work",
      body: "Spend over time by model, with the spend share by provider beside it — so you can see where the money goes.",
    },
    {
      sel: "prs",
      eyebrow: "Throughput",
      title: "Shipping velocity",
      body: "Pull requests merged over time, followed by repository-level shipping patterns in the breakdown row.",
    }
  );
  return steps;
}

/**
 * The guest tour's "Harnesses found" row, or nothing.
 *
 * Omitted whenever there is nothing to list — flag off, the read still in
 * flight, or a store with only unattributed sessions. A row headed "Harnesses
 * found" with no chips beside it would claim a discovery that did not happen.
 *
 * Carries a caption but deliberately NO count. "Models in use" earns its number
 * because its chips stop at four and the rest fold into "+N more"; this row
 * lists every harness it found, so a count beside them only tells the reader
 * how many chips are already in front of them. The caption scopes the claim to
 * what was actually read — the local session logs — rather than reintroducing
 * the validated-vs-best-effort split the repo has no canonical list for (the
 * only statement of it is hand-maintained prose in
 * `apps/desktop/docs/harness-telemetry-matrix.md`).
 */
function buildHarnessSummaryRows(
  guestOnboardingEnabled: boolean,
  harnesses: readonly string[]
): TourSummaryRow[] {
  if (!guestOnboardingEnabled || harnesses.length === 0) {
    return [];
  }
  return [
    {
      icon: <TerminalIcon size={15} />,
      label: "Harnesses found",
      chips: harnesses.map((harness) => ({
        label: harnessDisplayLabel(harness),
      })),
      sub: "detected in your local session logs",
    },
  ];
}

/**
 * The caption under "Models in use".
 *
 * Flag off it is the shipped sentence, untouched. Flag on it is derived from the
 * providers actually behind this device's model spend, because the harness row
 * sits beside it in the same summary: a Codex-only user reading "Harnesses
 * found: Codex" and then "across Claude, OpenAI, and more." is being told
 * something false by one of the two lines.
 *
 * No named provider resolvable (no spend yet, or every model unrecognized) means
 * no caption. A sentence that can only say "across other providers" carries
 * nothing, and inventing one would be the same lie in a quieter voice.
 */
function modelsCaption(
  modelBreakdown: readonly CategoryBucket[],
  guestOnboardingEnabled: boolean
): string | undefined {
  if (!guestOnboardingEnabled) {
    return LEGACY_MODELS_CAPTION;
  }
  const named: string[] = [];
  let hasOther = false;
  for (const bucket of modelBreakdown) {
    const provider = providerOf(bucket.key || bucket.label);
    if (provider === OTHER_MODEL_PROVIDER) {
      hasOther = true;
    } else if (!named.includes(provider)) {
      named.push(provider);
    }
  }
  if (named.length === 0) {
    return undefined;
  }
  const parts = hasOther ? [...named, OTHER_PROVIDERS_LABEL] : named;
  return `across ${PROVIDER_LIST_FORMAT.format(parts)}.`;
}
