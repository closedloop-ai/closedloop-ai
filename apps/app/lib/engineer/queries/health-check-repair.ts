import type {
  CheckResult,
  HealthCheckRepairResponse,
} from "@repo/api/src/types/compute-target";
import {
  HealthCheckRepairAction,
  HealthCheckRepairStepStatus,
} from "@repo/api/src/types/compute-target";
import { z } from "zod";
import { COMPUTE_TARGET_HEADER } from "@/lib/desktop-command-signing/constants";
import {
  GATEWAY_HEALTH_CHECK_REPAIR_PATH,
  GATEWAY_RELAY_HEALTH_CHECK_REPAIR_PATH,
} from "@/lib/engineer/constants";
import type { HealthCheckRequestConfig } from "@/lib/engineer/queries/health-check";
import { healthCheckResponseSchema } from "@/lib/engineer/queries/health-check";

/**
 * Client for the gateway's Repair operation (ISS-5389).
 *
 * Repair is a POST because it changes the target machine; it is reached through
 * the exact same gateway/relay seam as the health check, so the browser never
 * needs a localhost path and CloudRelay users get it too.
 */

export type RepairHealthCheckInput = {
  expectedMcpUrl: string | null;
  relayTargetId?: string | null;
  latestVersion?: string | null;
};

/**
 * Whether Repair has anything to do for these checks. Drives whether the
 * control is offered at all — a Repair button that would run zero steps for the
 * failure on screen is the dead affordance this gate exists to prevent.
 */
export function getRepairableChecks(
  checks: CheckResult[] | undefined
): CheckResult[] {
  return (checks ?? []).filter(
    (check) => !check.passed && check.repair?.repairable === true
  );
}

/**
 * True when the gateway that produced these checks understands Repair at all.
 * An older Desktop returns rows with no `repair` field; the panel must hide or
 * disable the control with a reason rather than POST to a route that 404s.
 */
export function isRepairSupported(checks: CheckResult[] | undefined): boolean {
  return (checks ?? []).some((check) => check.repair !== undefined);
}

export function buildHealthCheckRepairRequest({
  expectedMcpUrl,
  relayTargetId = null,
  latestVersion = null,
}: RepairHealthCheckInput): HealthCheckRequestConfig {
  const params = new URLSearchParams();
  if (expectedMcpUrl) {
    params.set("expectedMcpUrl", expectedMcpUrl);
  }
  if (latestVersion) {
    params.set("latestVersion", latestVersion);
  }

  const basePath =
    relayTargetId === null
      ? GATEWAY_HEALTH_CHECK_REPAIR_PATH
      : GATEWAY_RELAY_HEALTH_CHECK_REPAIR_PATH;
  const url = params.toString() ? `${basePath}?${params.toString()}` : basePath;

  const headers: Record<string, string> = {};
  if (relayTargetId !== null) {
    headers[COMPUTE_TARGET_HEADER] = relayTargetId;
  }

  return {
    url,
    init: {
      method: "POST",
      headers,
    },
  };
}

export async function repairHealthCheck(
  input: RepairHealthCheckInput,
  signal?: AbortSignal
): Promise<HealthCheckRepairResponse> {
  const request = buildHealthCheckRepairRequest(input);
  const response = await fetch(request.url, { ...request.init, signal });
  return parseHealthCheckRepairResponse(response);
}

const repairStepSchema = z
  .object({
    action: z.enum(HealthCheckRepairAction),
    label: z.string().trim().min(1),
    status: z.enum(HealthCheckRepairStepStatus),
    checkIds: z.array(z.string().trim().min(1)),
    detail: z.string().optional(),
  })
  .passthrough();

/**
 * A newer gateway may report a step whose `action`/`status` this build has never
 * heard of. Dropping the unknown step keeps the panel truthful about the ones it
 * does understand instead of rejecting the whole repair response.
 */
const tolerantRepairStepSchema = z.preprocess((value) => {
  const parsed = repairStepSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}, repairStepSchema.optional());

const healthCheckRepairResponseSchema = z.object({
  steps: z.array(tolerantRepairStepSchema),
  result: healthCheckResponseSchema,
  joinedInFlight: z.boolean().optional(),
});

async function parseHealthCheckRepairResponse(
  response: Response
): Promise<HealthCheckRepairResponse> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(getRepairErrorMessage(response, body));
  }

  const parsed = healthCheckRepairResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("Repair returned an invalid response");
  }

  return {
    ...parsed.data,
    steps: parsed.data.steps.filter((step) => step !== undefined),
  };
}

function getRepairErrorMessage(response: Response, body: unknown): string {
  const parsed = z
    .object({
      error: z.string().trim().min(1).optional(),
      message: z.string().trim().min(1).optional(),
    })
    .safeParse(body);
  const detail = parsed.success
    ? (parsed.data.error ?? parsed.data.message)
    : undefined;

  if (response.status === 404 || response.status === 405) {
    return "This gateway build does not support Repair. Update the Closedloop Gateway app on that machine.";
  }

  return detail
    ? `Repair failed: ${detail}`
    : `Repair failed with HTTP ${response.status}`;
}
