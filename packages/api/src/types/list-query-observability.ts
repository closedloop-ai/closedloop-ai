import type { ListQueryRefusal } from "./list-query-expression.ts";

/** Which request vocabulary reached a list-query boundary. */
export const ListQuerySource = {
  Canonical: "canonical",
  Legacy: "legacy",
} as const;
export type ListQuerySource =
  (typeof ListQuerySource)[keyof typeof ListQuerySource];

/** Bounded execution paths shared by API and Desktop list-query telemetry. */
export const ListQueryExecution = {
  Count: "count",
  CursorPage: "cursor_page",
  DatabasePage: "database_page",
  DisplayValueFallback: "display_value_fallback",
  HydratedFallback: "hydrated_fallback",
  PreHydrationPage: "pre_hydration_page",
  Refused: "refused",
  Unsupported: "unsupported",
} as const;
export type ListQueryExecution =
  (typeof ListQueryExecution)[keyof typeof ListQueryExecution];

/** Value-free query facts safe to attach to operational telemetry. */
export type ListQueryObservation = {
  source?: ListQuerySource;
  execution?: ListQueryExecution;
  refusal?: ListQueryRefusal;
  matchedCount?: number;
  resultCount?: number;
  scannedCount?: number;
};
