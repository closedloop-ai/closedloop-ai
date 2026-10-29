import { toDesktopApiPathname } from "@repo/api/src/desktop-api-namespace";
import { type ApiResult, failure } from "@repo/api/src/types/common";
import {
  HEALTH_CHECK_REPAIR_OPERATION_ID,
  HEALTH_CHECK_REPAIR_PATH,
} from "@repo/api/src/types/compute-target";
import { NextResponse } from "next/server";

/**
 * Ownership boundary for the System Check Repair operation (ISS-5389).
 *
 * Repair mutates the target machine: it clears binary-path overrides and runs
 * `claude plugin enable`. A teammate's target is theirs to heal.
 *
 * Command creation authorizes with `findAccessibleById`, which is owner-only
 * since ISS-12617 retired target sharing, and accepts any `/api/gateway/*`
 * path in the body. When targets could be shared, anyone holding a session
 * token could reach the repair by POSTing the command directly (ISS-5389
 * review).
 *
 * Current Desktop builds no longer serve repair (ISS-12749); installed older
 * builds still do, so this guard stays as defense in depth until none remain.
 */

export function isHealthCheckRepairCommand(
  input: Readonly<{ operationId: string; path: string }>
): boolean {
  return (
    input.operationId === HEALTH_CHECK_REPAIR_OPERATION_ID ||
    toDesktopApiPathname(input.path) === HEALTH_CHECK_REPAIR_PATH
  );
}

export function healthCheckRepairNotOwnedResponse(): NextResponse<
  ApiResult<never>
> {
  return NextResponse.json(
    failure("Repair is only available on compute targets you own", {
      code: HEALTH_CHECK_REPAIR_NOT_OWNED_ERROR_CODE,
    }),
    { status: 403 }
  );
}

export const HEALTH_CHECK_REPAIR_NOT_OWNED_ERROR_CODE =
  "health_check_repair_not_owned" as const;
