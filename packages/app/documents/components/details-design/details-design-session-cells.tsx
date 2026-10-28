"use client";

// Cross-slice on purpose: the Details harness renders production's own Session
// Cost value, which the agents slice owns.
import { SessionEvidenceCoverage } from "@repo/api/src/types/session-evidence-coverage-constants";
import { createAgentSessionDetailFixture } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { SessionCostValue } from "@repo/app/agents/components/detail/session-flagged-properties";
import {
  joinPropertySentences,
  resolveMetricProvenanceNote,
  SessionProvenanceMetric,
} from "@repo/app/agents/components/detail/session-metric-provenance";
import { SESSION_COST_POPULATION_NOTE } from "@repo/app/agents/components/detail/session-population-notes";
import {
  costLabelIsFigure,
  deriveCostAvailability,
  deriveSessionCostLabel,
  hasRecordedTokenUsage,
} from "@repo/app/agents/lib/cost-availability";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY,
  SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import type { ReactNode } from "react";

/**
 * ISS-10792 harness: production's Session Cost row, value only. Each
 * sentence, constant and flag is the one `session-properties-panel.tsx` uses;
 * the session is the agents slice's own detail fixture, billed metadata-only
 * so the provenance sentence has something to say.
 */
const SESSION = createAgentSessionDetailFixture({
  authoritativeCostUsd: 4.1,
  evidenceCoverage: SessionEvidenceCoverage.MetadataOnly,
});

function useDisclosures() {
  return {
    evidence:
      useFeatureFlagEnabledOptional(
        SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY
      ) === true,
    population:
      useFeatureFlagEnabledOptional(
        SESSION_METRIC_POPULATION_DISCLOSURE_FEATURE_FLAG_KEY
      ) === true,
  };
}

/**
 * Production's `ExplainedPropertyValue` shape: the sentence in a tooltip on a
 * button, and in the accessible name after the visible value.
 */
function Explained({
  children,
  explanation,
}: {
  children: ReactNode;
  explanation: string | undefined;
}) {
  if (!explanation) {
    return <span className="px-1">{children}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="rounded px-1 text-left underline decoration-dotted underline-offset-4"
          type="button"
        >
          {children}
          <span className="sr-only"> {explanation}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{explanation}</TooltipContent>
    </Tooltip>
  );
}

/** The pane's `.prd-cost-*` spacing is not loaded outside the session page. */
const COST_PAIR_LAYOUT =
  "[&_.prd-cost-figure]:inline-flex [&_.prd-cost-figure]:items-baseline [&_.prd-cost-figure]:gap-1 [&_.prd-cost-pair]:inline-flex [&_.prd-cost-pair]:gap-3 [&_.prd-cost-source]:text-muted-foreground [&_.prd-cost-source]:text-xs";

export function SessionCostCell() {
  const disclose = useDisclosures();
  const figure = costLabelIsFigure(deriveCostAvailability(SESSION));
  return (
    <span className={COST_PAIR_LAYOUT}>
      <Explained
        explanation={joinPropertySentences(
          disclose.population && figure ? SESSION_COST_POPULATION_NOTE : null,
          resolveMetricProvenanceNote({
            disclosureEnabled: disclose.evidence,
            evidenceCoverage: SESSION.evidenceCoverage,
            metric: SessionProvenanceMetric.Cost,
            valueIsSourceBacked: figure && hasRecordedTokenUsage(SESSION),
          })
        )}
      >
        <SessionCostValue
          estimate={deriveSessionCostLabel(SESSION)}
          session={SESSION}
        />
      </Explained>
    </span>
  );
}
