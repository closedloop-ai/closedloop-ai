"use client";

import { DocumentType } from "@repo/api/src/types/document";
import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import { CELL_CLASSES } from "@repo/app/documents/components/table/cells/shared-cell-styles";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { deriveScoreDisplay } from "@repo/app/documents/lib/evaluation-utils";
import {
  useFeatureJudgesFeedback,
  usePlanJudgesFeedback,
  usePrdJudgesFeedback,
} from "@repo/app/judges-analytics/hooks/use-judges";
import type { UseQueryResult } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";

/**
 * Judge-score column cell (FEA-1763 / PLN-874 Phase 3; extracted from
 * document-row.tsx). Document subtypes with judge feedback render a score;
 * everything else renders a dash.
 */

function ScoreCellDash() {
  return (
    <div className={CELL_CLASSES}>
      <span className="font-medium text-muted-foreground text-xs">—</span>
    </div>
  );
}

function ScoreCellFromFeedback({
  items,
}: {
  items: JudgeFeedbackItem[] | null | undefined;
}) {
  const score = deriveScoreDisplay(items);
  return (
    <div className={CELL_CLASSES}>
      {score === null ? (
        <span className="font-medium text-muted-foreground text-xs">—</span>
      ) : (
        <span className="truncate font-medium text-green-600 text-xs dark:text-green-400">
          {score}
        </span>
      )}
    </div>
  );
}

function ScoreCellWithQuery({
  queryResult,
}: {
  queryResult: UseQueryResult<JudgeFeedbackItem[] | null>;
}) {
  const { data, isLoading } = queryResult;
  if (isLoading) {
    return (
      <div className={CELL_CLASSES}>
        <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <ScoreCellFromFeedback items={data ?? undefined} />;
}

export function ScoreCell({ item }: { item: DocumentRowItem }) {
  const isPrd = item.kind === "document" && item.data.type === DocumentType.Prd;
  const isPlan =
    item.kind === "document" &&
    item.data.type === DocumentType.ImplementationPlan;
  const isFeature =
    item.kind === "document" && item.data.type === DocumentType.Feature;
  const documentId = item.kind === "project" ? "" : item.data.id;

  const prdJudgesQuery = usePrdJudgesFeedback(isPrd ? documentId : "");
  const planJudgesQuery = usePlanJudgesFeedback(isPlan ? documentId : "");
  const featureJudgesQuery = useFeatureJudgesFeedback(
    isFeature ? documentId : ""
  );

  if (item.kind === "project") {
    return <ScoreCellDash />;
  }
  if (isPrd) {
    return <ScoreCellWithQuery queryResult={prdJudgesQuery} />;
  }
  if (isPlan) {
    return <ScoreCellWithQuery queryResult={planJudgesQuery} />;
  }
  if (isFeature) {
    return <ScoreCellWithQuery queryResult={featureJudgesQuery} />;
  }
  return <ScoreCellDash />;
}
