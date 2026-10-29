import { registerGoldenDefinitionVersions } from "../derived/definition-registry";
import {
  backfillSearchDocuments,
  refreshBranchAnalyticsRollups,
} from "../derived/rollups";
import type { VibeSeedStage } from "../stage";

export const STAGES: readonly VibeSeedStage[] = [
  {
    name: "definition-registry",
    models: [
      "DefinitionVersion",
      "DefinitionVersionEditor",
      "SourceOccurrence",
    ],
    run: registerGoldenDefinitionVersions,
  },
  {
    name: "branch-analytics-rollup",
    models: ["BranchAnalyticsSessionRollup", "BranchAnalyticsRollupState"],
    run: refreshBranchAnalyticsRollups,
  },
  {
    name: "search-documents",
    models: ["SearchDocument"],
    run: backfillSearchDocuments,
  },
];
