import type { User } from "@repo/api/src/types/organization";
import { log } from "@repo/observability/log";
import type { NextRequest } from "next/server";
import type { z } from "zod";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { parseDateRange } from "../validators";

type DateRangeParams = { startDate: string; endDate: string };

export function createJudgesAnalyticsHandler<
  TParams extends DateRangeParams,
  TResponse,
>(config: {
  validator: z.ZodType<TParams>;
  parseExtra?: (params: TParams) => Record<string, unknown>;
  fetch: (
    orgId: string,
    startDate: Date,
    endDate: Date,
    extra?: Record<string, unknown>
  ) => Promise<TResponse>;
  errorMessage: string;
}) {
  return async ({ user }: { user: User }, request: NextRequest) => {
    try {
      const { body: params, errorResponse: parseError } = parseQueryParams(
        request,
        config.validator
      );
      if (parseError) {
        return parseError;
      }

      const extra = config.parseExtra?.(params);

      log.info("judges-analytics query", {
        organizationId: user.organizationId,
        startDate: params.startDate,
        endDate: params.endDate,
        extra,
      });

      const { startDate, endDate } = parseDateRange(
        params.startDate,
        params.endDate
      );
      const result = await config.fetch(
        user.organizationId,
        startDate,
        endDate,
        extra
      );

      return successResponse(result);
    } catch (error) {
      return errorResponse(config.errorMessage, error);
    }
  };
}
