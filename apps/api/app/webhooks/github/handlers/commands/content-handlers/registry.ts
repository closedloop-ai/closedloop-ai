import {
  codeJudgesReportHandler,
  judgesReportHandler,
} from "./judges-report-handler";
import { perfSummaryHandler } from "./perf-summary-handler";
import type { AnyContentTransactionHandler } from "./types";

/**
 * All registered content transaction handlers.
 *
 * To add persistence for a new content type:
 * 1. Add its ContentKey to CONTENT_KEYS in ../../../extractors/keys.ts
 * 2. Create a handler file implementing ContentTransactionHandler<T>
 * 3. Add it to this array
 *
 * planSuccessHandler is closed for modification — it dispatches via
 * makeContentDispatcher(CONTENT_TRANSACTION_HANDLERS) without knowing
 * about individual content types.
 */
export const CONTENT_TRANSACTION_HANDLERS: AnyContentTransactionHandler[] = [
  judgesReportHandler,
  codeJudgesReportHandler,
  perfSummaryHandler,
];
