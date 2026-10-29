import { getPrismaErrorCode, getPrismaRawQuerySqlState } from "@/lib/db-utils";
import {
  BranchAnalyticsRollupFailureCategory,
  type BranchAnalyticsRollupFailureCategory as BranchAnalyticsRollupFailureCategoryType,
} from "./branch-analytics-rollup-contract";

/** Classify rollup producer failures without logging raw error content. */
export function classifyBranchAnalyticsRollupFailure(
  error: unknown
): BranchAnalyticsRollupFailureCategoryType {
  const sqlState = getPrismaRawQuerySqlState(error);
  if (sqlState) {
    return `${BranchAnalyticsRollupFailureCategory.SqlStatePrefix}${sqlState}`;
  }
  const prismaCode = getPrismaErrorCode(error);
  if (prismaCode) {
    return `${BranchAnalyticsRollupFailureCategory.PrismaCodePrefix}${prismaCode}`;
  }
  return BranchAnalyticsRollupFailureCategory.Unknown;
}
