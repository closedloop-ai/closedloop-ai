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
 * `claude plugin enable`. A target shared with you by a teammate is theirs to
 * heal.
 *
 * The app's gateway-relay forwarder already refuses this early for UX, but that
 * is not the boundary. Command creation authorizes with `findAccessibleById`,
 * which intentionally includes org-shared targets, and accepts any
 * `/api/gateway/*` path in the body, so anyone holding a session token could
 * reach the repair by POSTing the command directly (ISS-5389 review). This is
 * the check that actually holds.
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
