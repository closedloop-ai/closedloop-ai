import type {
  CheckResult,
  HealthCheckResponse,
  McpProviderAvailability,
  NeutralMcpProviderAvailability,
} from "@repo/api/src/types/compute-target";
import { PluginUpdateOutcome } from "@repo/api/src/types/compute-target";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { env } from "@/env";
import { COMPUTE_TARGET_HEADER } from "@/lib/desktop-command-signing/constants";
import {
  GATEWAY_HEALTH_CHECK_PATH,
  GATEWAY_RELAY_HEALTH_CHECK_PATH,
} from "@/lib/engineer/constants";
import type { EngineerRoutingSelection } from "@/lib/engineer/routing-store";
import { getPreLoopHealthCheckTimeoutMs } from "@/lib/system-check/health-check-timeouts";
import { queryKeys } from "./keys";

const APP_VERSION_CHECK_ID = "app-version";
const APP_VERSION_CHECK_LABEL = "Gateway Version";
const PLUGIN_VERSIONS_CHECK_ID = "plugin-versions";
const PLUGIN_VERSIONS_CHECK_LABEL = "Plugin Updates";
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

function normalizeHealthCheck(check: CheckResult): CheckResult {
  if (check.id === APP_VERSION_CHECK_ID) {
    return {
      ...check,
      label: APP_VERSION_CHECK_LABEL,
      passed: check.passed,
      required: true,
    };
  }

  if (check.id === PLUGIN_VERSIONS_CHECK_ID) {
    return {
      ...check,
      label: PLUGIN_VERSIONS_CHECK_LABEL,
    };
  }

  return check;
}

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

function getMcpCheckResult(
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
      const res = await fetch(request.url, {
        ...request.init,
        signal: composeHealthCheckSignal(
          signal,
          getPreLoopHealthCheckTimeoutMs(pluginAutoUpdateEnabled)
        ),
      });
      return parseHealthCheckResponse(res);
    },
    retry: false,
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
const optionalPluginUpdateOutcomeSchema = z.preprocess(
  (value) =>
    typeof value === "string" && !pluginUpdateOutcomeValues.has(value)
      ? undefined
      : value,
  z.enum(PluginUpdateOutcome).optional()
);

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
  })
  .passthrough();

const neutralMcpProviderAvailabilitySchema = z
  .object({
    available: z.boolean(),
    serverName: z.string().nullable(),
    matchedUrl: z.string().nullable(),
    checkedAt: z.string(),
    error: z.string().nullable().optional(),
  })
  .passthrough();

const legacyMcpProviderAvailabilitySchema = z
  .object({
    closedloopAvailable: z.boolean(),
    checkedAt: z.string(),
  })
  .passthrough();

const mcpProviderAvailabilitySchema = z.union([
  neutralMcpProviderAvailabilitySchema,
  legacyMcpProviderAvailabilitySchema,
]);

const healthCheckResponseSchema = z.object({
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
  timeoutMs: number
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
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
    throw new Error(getHealthCheckResponseErrorMessage(response, body));
  }

  const parsed = healthCheckResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("Gateway health check returned an invalid response");
  }

  return parsed.data;
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
