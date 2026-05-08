import { JUDGE_RADAR_METRICS } from "@repo/api/src/constants";

export const JUDGES_ANALYTICS_QUERY_STALE_TIME_MS = 5 * 60 * 1000;

export const JUDGES_ANALYTICS_SCORE_PAGE_SIZE = 20;
export const JUDGES_ANALYTICS_SCORE_TABLE_MAX_HEIGHT_CLASS = "max-h-[28rem]";
export const JUDGES_ANALYTICS_DELTA_WARNING_THRESHOLD = 0.3;
export const JUDGES_ANALYTICS_DELTA_CRITICAL_THRESHOLD = 0.6;

export const JUDGES_ANALYTICS_CHART_COLOR_TOKEN_COUNT = 5;
export const JUDGES_ANALYTICS_LATEST_RADAR_COLOR = "var(--chart-1)";

export const JUDGES_ANALYTICS_EVAL_COLOR = "var(--info)";
export const JUDGES_ANALYTICS_HUMAN_COLOR = "var(--warning)";

export const JUDGES_ANALYTICS_ALL_TIME_START_DATE = "2000-01-01";
export const JUDGES_ANALYTICS_DATE_RANGE_DAYS = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
} as const;

export const JUDGES_ANALYTICS_AXIS_HELP_ITEMS = [
  {
    axis: "Stubbornness",
    formula: `1 - clamp(stdDev / ${JUDGE_RADAR_METRICS.stubbornness.stdDevNormalizationDivisor}, 0, 1)`,
    interpretation:
      "Higher means the judge scores more consistently across artifacts.",
  },
  {
    axis: "Optimism",
    formula: "mean",
    interpretation:
      "Higher means the judge tends to score artifacts more positively.",
  },
  {
    axis: "Polarity",
    formula: "bimodalityCoefficient",
    interpretation:
      "Higher means the judge tends to split between very different score groups.",
  },
  {
    axis: "Certainty",
    formula: `count(score > ${JUDGE_RADAR_METRICS.certainty.extremeHighScore} or score < ${JUDGE_RADAR_METRICS.certainty.extremeLowScore}) / totalScores`,
    interpretation:
      "Higher means the judge more often gives decisive extreme scores rather than middle scores.",
  },
] as const;
