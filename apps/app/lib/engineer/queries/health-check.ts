import type {
  CheckResult,
  HealthCheckResponse,
  McpProviderAvailability,
  NeutralMcpProviderAvailability,
} from "@repo/api/src/types/compute-target";
import {
  HealthCheckRepairAction,
  PluginUpdateOutcome,
} from "@repo/api/src/types/compute-target";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { env } from "@/env";
import { COMPUTE_TARGET_HEADER } from "@/lib/desktop-command-signing/constants";
import {
  GATEWAY_HEALTH_CHECK_PATH,
  GATEWAY_RELAY_HEALTH_CHECK_PATH,
} from "@/lib/engineer/constants";
import type { EngineerRoutingSelection } from "@/lib/engineer/routing-store";
import {
  classifyHealthCheckFailure,
  HealthCheckFailureKind,
  HealthCheckHttpError,
  HealthCheckTimeoutError,
  isUnreachableHealthCheckFailure,
} from "@/lib/system-check/health-check-failure";
import { reportDroppedHealthCheckFields } from "@/lib/system-check/health-check-field-loss";
import {
  getPreLoopHealthCheckMaxAttempts,
  getPreLoopHealthCheckTimeoutMs,
} from "@/lib/system-check/health-check-timeouts";
import { normalizeHealthCheck } from "@/lib/system-check/normalize-health-check";
import { queryKeys } from "./keys";

export const HEALTH_CHECK_QUERY_STALE_TIME_MS = 24 * 60 * 60 * 1000;

export type {
  CheckResult,
  CheckResultDebug,
  HealthCheckResponse,
  LegacyMcpProviderAvailability,
  McpProviderAvailability,
  NeutralMcpProviderAvailability,
} from "@repo/api/src/types/compute-target";

type HealthCheckTargetScope =
  | Pick<EngineerRoutingSelection, "mode" | "computeTargetId">
  | string;

type HealthCheckOptionsConfig = {
  relayTargetId?: string | null;
  latestVersion?: string | null;
  pluginAutoUpdateEnabled?: boolean;
};

type HealthCheckRequestInput = {
  expectedMcpUrl: string | null;
  relayTargetId?: string | null;
  latestVersion?: string | null;
  pluginAutoUpdateEnabled?: boolean;
};

export type HealthCheckRequestConfig = {
  url: string;
  init?: RequestInit;
};

export function getHealthCheckTargetKey(
  routing: Pick<EngineerRoutingSelection, "mode" | "computeTargetId">
): string {
  return `${routing.mode}:${routing.computeTargetId ?? "none"}`;
}

function isNeutralMcpAvailability(
  availability: McpProviderAvailability
): availability is NeutralMcpProviderAvailability {
  return "available" in availability;
}

function getMcpCheckLabel(provider: "claude" | "codex"): string {
  return provider === "claude" ? "Claude MCP" : "Codex MCP";
}

function getMcpInstallRemediation(expectedMcpUrl: string | null): string {
  return expectedMcpUrl
    ? `Install a user/global MCP server pointing to ${expectedMcpUrl}. Project-local MCP installs are not supported.`
    : "Install the expected MCP server at user/global scope. Project-local MCP installs are not supported.";
}

/**
 * The MCP rows are the only System Check rows the web synthesizes rather than
 * receives, so the gateway cannot annotate them in `checks[]`. It puts its
 * repairability verdict on the `mcpServers` entry instead, and this carries it
 * across onto the row (ISS-5435) — after which `getRepairableChecks`,
 * `isRepairSupported`, and the panel treat an MCP row exactly like any other.
 *
 * Only FAILING rows are annotated, matching the gateway's own
 * `annotateRepairability`: a green row has nothing to repair. An older gateway
 * sends no `repair`, and the row is then correctly read as not repairable.
 */
function getMcpCheckResult(
  provider: "claude" | "codex",
  availability: McpProviderAvailability | undefined,
  expectedMcpUrl: string | null
): CheckResult | null {
  const check = buildMcpCheckResult(provider, availability, expectedMcpUrl);
  if (!check || check.passed || !availability?.repair) {
    return check;
  }
  return { ...check, repair: availability.repair };
}

function buildMcpCheckResult(
  provider: "claude" | "codex",
  availability: McpProviderAvailability | undefined,
  expectedMcpUrl: string | null
): CheckResult | null {
  if (!availability) {
    return null;
  }

  const label = getMcpCheckLabel(provider);
  const id = `${provider}-mcp`;

  if (isNeutralMcpAvailability(availability)) {
    const hasDetectionContext = Boolean(
      expectedMcpUrl ||
        availability.available ||
        availability.serverName ||
        availability.matchedUrl
    );

    if (!hasDetectionContext) {
      return null;
    }

    if (availability.available) {
      return {
        id,
        label,
        required: false,
        passed: true,
        version: availability.serverName ?? undefined,
      };
    }

    if (availability.error) {
      const installRemediation = getMcpInstallRemediation(expectedMcpUrl);
      let remediation = "Retry check.";
      if (availability.error === "Project-local config unsupported") {
        remediation = installRemediation;
      } else if (availability.serverName) {
        remediation = `Retry check. ${availability.serverName} is configured for ${availability.matchedUrl ?? expectedMcpUrl ?? "the expected MCP URL"}`;
      } else if (expectedMcpUrl) {
        remediation = `Retry check. If this persists, verify a user/global MCP server pointing to ${expectedMcpUrl} is configured.`;
      }
      return {
        id,
        label,
        required: false,
        passed: false,
        error: availability.error,
        remediation,
      };
    }

    return {
      id,
      label,
      required: false,
      passed: false,
      error: availability.serverName ? "Disconnected" : "Not configured",
      remediation: availability.serverName
        ? `Ensure the ${availability.serverName} MCP server is enabled and connected`
        : getMcpInstallRemediation(expectedMcpUrl),
    };
  }

  if (!(expectedMcpUrl || availability.closedloopAvailable)) {
    return null;
  }

  return availability.closedloopAvailable
    ? {
        id,
        label,
        required: false,
        passed: true,
      }
    : {
        id,
        label,
        required: false,
        passed: false,
        error: "Unavailable",
        remediation: getMcpInstallRemediation(expectedMcpUrl),
      };
}

export function getRenderableHealthChecks(
  response: HealthCheckResponse | undefined,
  expectedMcpUrl: string | null = env.NEXT_PUBLIC_MCP_SERVER_URL ?? null
): CheckResult[] | undefined {
  if (!response) {
    return undefined;
  }

  const checks = response?.checks
    ? response.checks.map(normalizeHealthCheck)
    : [];
  const claudeMcp = getMcpCheckResult(
    "claude",
    response.mcpServers?.claude,
    expectedMcpUrl
  );
  const codexMcp = getMcpCheckResult(
    "codex",
    response.mcpServers?.codex,
    expectedMcpUrl
  );

  if (claudeMcp) {
    checks.push(claudeMcp);
  }

  if (codexMcp) {
    checks.push(codexMcp);
  }

  return checks;
}

/** Builds the health-check request for direct local-gateway or relay-target execution. */
export function buildHealthCheckRequest({
  expectedMcpUrl,
  relayTargetId = null,
  latestVersion = null,
  pluginAutoUpdateEnabled = false,
}: HealthCheckRequestInput): HealthCheckRequestConfig {
  const params = new URLSearchParams();
  if (expectedMcpUrl) {
    params.set("expectedMcpUrl", expectedMcpUrl);
  }
  if (latestVersion) {
    params.set("latestVersion", latestVersion);
  }
  if (pluginAutoUpdateEnabled) {
    params.set("pluginAutoUpdate", "1");
  }

  const path =
    relayTargetId === null
      ? GATEWAY_HEALTH_CHECK_PATH
      : GATEWAY_RELAY_HEALTH_CHECK_PATH;
  const url = params.toString() ? `${path}?${params.toString()}` : path;

  if (relayTargetId === null) {
    return { url };
  }

  return {
    url,
    init: {
      headers: {
        [COMPUTE_TARGET_HEADER]: relayTargetId,
      },
    },
  };
}

export function healthCheckOptions(
  routing: HealthCheckTargetScope = "default",
  expectedMcpUrl: string | null = env.NEXT_PUBLIC_MCP_SERVER_URL ?? null,
  config: HealthCheckOptionsConfig = {}
) {
  const targetKey =
    typeof routing === "string" ? routing : getHealthCheckTargetKey(routing);
  const relayTargetId = config.relayTargetId ?? null;
  const latestVersion = config.latestVersion || null;
  const pluginAutoUpdateEnabled = config.pluginAutoUpdateEnabled ?? false;
  // An explicit `relayTargetId` is not the only way a health check reaches
  // CloudRelay. Callers that pass only a routing selection still hit
  // `GATEWAY_HEALTH_CHECK_PATH`, and the fetch interceptor rewrites that to the
  // relay whenever the selection is CloudRelay — so the budget must fork on the
  // routing mode too, or those checks get the localhost budget for a relay
  // round trip. That is the exact mis-budgeting ISS-5169 is about.
  const relayTarget = relayTargetId !== null || isCloudRelayRouting(routing);
  const timeoutScope = { pluginAutoUpdateEnabled, relayTarget };
  const maxAttempts = getPreLoopHealthCheckMaxAttempts(timeoutScope);

  return queryOptions<HealthCheckResponse>({
    queryKey: queryKeys.healthCheck(
      targetKey,
      expectedMcpUrl,
      latestVersion,
      pluginAutoUpdateEnabled
    ),
    queryFn: async ({ signal }) => {
      const request = buildHealthCheckRequest({
        expectedMcpUrl,
        relayTargetId,
        latestVersion,
        pluginAutoUpdateEnabled,
      });
      const timeoutMs = getPreLoopHealthCheckTimeoutMs(timeoutScope);
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      try {
        const res = await fetch(request.url, {
          ...request.init,
          signal: composeHealthCheckSignal(signal, timeoutSignal),
        });
        return await parseHealthCheckResponse(res);
      } catch (error) {
        // Our own budget expiring is a reachability verdict, not an opaque
        // abort — surface it as such so the gate can tell it apart from a
        // target that answered with failing checks (ISS-5169).
        if (timeoutSignal.aborted && !signal.aborted) {
          throw new HealthCheckTimeoutError(
            relayTarget
              ? HealthCheckFailureKind.RelayTimeout
              : HealthCheckFailureKind.LocalTimeout,
            timeoutMs
          );
        }
        throw error;
      }
    },
    // A single slow relay round trip is a transient, not a verdict. Retry it
    // once — but only when nothing answered; a responder that returned an
    // error or an invalid body will return the same thing on a replay.
    retry: (failureCount, error) =>
      failureCount < maxAttempts - 1 &&
      isUnreachableHealthCheckFailure(
        classifyHealthCheckFailure(error, { relayTarget })
      ),
    retryDelay: 0,
    staleTime: (query) => {
      const data = query.state.data;
      if (!data) {
        return HEALTH_CHECK_QUERY_STALE_TIME_MS;
      }
      const hasFailingCheck = data.checks?.some((check) => !check.passed);
      return hasFailingCheck ? 0 : HEALTH_CHECK_QUERY_STALE_TIME_MS;
    },
  });
}

const healthCheckDebugSchema = z
  .object({
    errorCode: z.string().optional(),
    stderr: z.string().optional(),
    resolvedPath: z.string().optional(),
    shell: z.string().optional(),
    platform: z.string().optional(),
    foundAt: z.array(z.string()).optional(),
    nonExecutableAt: z.array(z.string()).optional(),
    overrideUsed: z.string().optional(),
  })
  .passthrough();

const remediationLinkUrlSchema = z.url().refine(
  (value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "Remediation link URLs must use HTTPS" }
);

const remediationLinkSchema = z.object({
  label: z.string().trim().min(1),
  url: remediationLinkUrlSchema,
});

const pluginUpdateOutcomeValues = new Set<string>(
  Object.values(PluginUpdateOutcome)
);
/**
 * Keeps only an outcome this build knows and degrades everything else —
 * including a non-string — to absent. `healthCheckResponseSchema` is parsed as
 * one unit, so a single unusable outcome threw away the WHOLE health check and
 * surfaced as "Gateway health check returned an invalid response" rather than a
 * panel missing one telemetry field (ISS-5868).
 */
const optionalPluginUpdateOutcomeSchema = z.preprocess(
  (value) =>
    typeof value === "string" && pluginUpdateOutcomeValues.has(value)
      ? value
      : undefined,
  z.enum(PluginUpdateOutcome).optional()
);

const repairActionValues = new Set<string>(
  Object.values(HealthCheckRepairAction)
);
/**
 * A newer gateway can name a repair action this build has never heard of. Drop
 * the unknown action rather than rejecting the whole check row — the row still
 * has a truthful error and remediation to render, and `repairable` without a
 * recognised action simply means "this build cannot drive it" (ISS-5389). A
 * non-string `action` degrades the same way, because the response is parsed as
 * one unit and rejecting it costs the entire panel, not one field (ISS-5868).
 */
const checkResultRepairSchema = z
  .object({
    repairable: z.boolean(),
    action: z.preprocess(
      (value) =>
        typeof value === "string" && repairActionValues.has(value)
          ? value
          : undefined,
      z.enum(HealthCheckRepairAction).optional()
    ),
    reason: z.string().optional(),
    blockedByCheckId: z.string().optional(),
  })
  .passthrough()
  .optional();

const checkResultSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    required: z.boolean(),
    passed: z.boolean(),
    version: z.string().optional(),
    error: z.string().optional(),
    remediation: z.string().optional(),
    debug: healthCheckDebugSchema.optional(),
    enableAttempted: z.boolean().optional(),
    enableOutcome: optionalPluginUpdateOutcomeSchema,
    enablePluginIds: z.array(z.string().trim().min(1)).optional(),
    updateAttempted: z.boolean().optional(),
    updateOutcome: optionalPluginUpdateOutcomeSchema,
    updatePluginIds: z.array(z.string().trim().min(1)).optional(),
    remediationLinks: z.array(remediationLinkSchema).optional(),
    repair: checkResultRepairSchema,
  })
  .passthrough();

// `repair` is declared here rather than left to `.passthrough()` so the same
// unknown-action preprocessing the check rows get also applies to the MCP rows
// this module synthesizes from these entries (ISS-5435).
const neutralMcpProviderAvailabilitySchema = z
  .object({
    available: z.boolean(),
    serverName: z.string().nullable(),
    matchedUrl: z.string().nullable(),
    checkedAt: z.string(),
    error: z.string().nullable().optional(),
    repair: checkResultRepairSchema,
  })
  .passthrough();

const legacyMcpProviderAvailabilitySchema = z
  .object({
    closedloopAvailable: z.boolean(),
    checkedAt: z.string(),
    repair: checkResultRepairSchema,
  })
  .passthrough();

const mcpProviderAvailabilitySchema = z.union([
  neutralMcpProviderAvailabilitySchema,
  legacyMcpProviderAvailabilitySchema,
]);

export const healthCheckResponseSchema = z.object({
  checks: z.array(checkResultSchema),
  allRequiredPassed: z.boolean(),
  mcpServers: z
    .object({
      claude: mcpProviderAvailabilitySchema.optional(),
      codex: mcpProviderAvailabilitySchema.optional(),
    })
    .optional(),
});

function composeHealthCheckSignal(
  querySignal: AbortSignal,
  timeoutSignal: AbortSignal
): AbortSignal {
  if (querySignal.aborted) {
    return querySignal;
  }

  return AbortSignal.any([querySignal, timeoutSignal]);
}

async function parseHealthCheckResponse(
  response: Response
): Promise<HealthCheckResponse> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    // Keep the status on the error. A flat `Error` collapses the relay's own
    // "503 Compute target offline" into `Unknown`, which is neither retried nor
    // eligible for the Cloud fallback (ISS-5171).
    throw new HealthCheckHttpError(
      getHealthCheckResponseErrorMessage(response, body),
      response.status
    );
  }

  const parsed = healthCheckResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("Gateway health check returned an invalid response");
  }

  // A LocalElectron response never reaches the API, so the persist boundary's
  // dropped-field report never runs for it — without this, the same guards throw
  // the same malformed fields away in the browser in total silence (ISS-5868).
  reportDroppedHealthCheckFields(body, parsed.data);

  return parsed.data;
}

/**
 * Whether the scope this query was built for dispatches through CloudRelay.
 * A bare target-key string carries the mode as its prefix (see
 * `getHealthCheckTargetKey`), so both call shapes answer the same question.
 */
function isCloudRelayRouting(routing: HealthCheckTargetScope): boolean {
  const mode =
    typeof routing === "string" ? routing.split(":")[0] : routing.mode;
  return mode === EngineerRoutingMode.CloudRelay;
}

function getHealthCheckResponseErrorMessage(
  response: Response,
  body: unknown
): string {
  const parsed = z
    .object({
      error: z.string().trim().min(1).optional(),
      message: z.string().trim().min(1).optional(),
    })
    .safeParse(body);
  const detail = parsed.success
    ? (parsed.data.error ?? parsed.data.message)
    : undefined;

  return detail
    ? `Gateway health check failed: ${detail}`
    : `Gateway health check failed with HTTP ${response.status}`;
}
