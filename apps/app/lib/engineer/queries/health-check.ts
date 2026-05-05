import { queryOptions } from "@tanstack/react-query";
import { env } from "@/env";
import {
  COMPUTE_TARGET_HEADER,
  GATEWAY_HEALTH_CHECK_PATH,
  GATEWAY_RELAY_HEALTH_CHECK_PATH,
} from "@/lib/engineer/constants";
import type { EngineerRoutingSelection } from "@/lib/engineer/routing-store";
import { queryKeys } from "./keys";

const APP_VERSION_CHECK_ID = "app-version";
const APP_VERSION_CHECK_LABEL = "Gateway Version";
const PLUGIN_VERSIONS_CHECK_ID = "plugin-versions";
const PLUGIN_VERSIONS_CHECK_LABEL = "Plugin Updates";

export type CheckResultDebug = {
  errorCode?: string;
  stderr?: string;
  resolvedPath?: string;
  shell?: string;
  platform?: string;
  foundAt?: string[];
  overrideUsed?: string;
};

export type CheckResult = {
  id: string;
  label: string;
  required: boolean;
  passed: boolean;
  version?: string;
  error?: string;
  remediation?: string;
  debug?: CheckResultDebug;
};

export type NeutralMcpProviderAvailability = {
  available: boolean;
  serverName: string | null;
  matchedUrl: string | null;
  checkedAt: string;
  error?: string | null;
};

export type LegacyMcpProviderAvailability = {
  closedloopAvailable: boolean;
  checkedAt: string;
};

export type McpProviderAvailability =
  | NeutralMcpProviderAvailability
  | LegacyMcpProviderAvailability;

export type HealthCheckResponse = {
  checks: CheckResult[];
  allRequiredPassed: boolean;
  mcpServers?: {
    claude: McpProviderAvailability;
    codex: McpProviderAvailability;
  };
};

type HealthCheckTargetScope =
  | Pick<EngineerRoutingSelection, "mode" | "computeTargetId">
  | string;

type HealthCheckOptionsConfig = {
  relayTargetId?: string | null;
  latestVersion?: string | null;
};

type HealthCheckRequestInput = {
  expectedMcpUrl: string | null;
  relayTargetId?: string | null;
  latestVersion?: string | null;
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
}: HealthCheckRequestInput): HealthCheckRequestConfig {
  const params = new URLSearchParams();
  if (expectedMcpUrl) {
    params.set("expectedMcpUrl", expectedMcpUrl);
  }
  if (latestVersion) {
    params.set("latestVersion", latestVersion);
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

  return queryOptions<HealthCheckResponse>({
    queryKey: queryKeys.healthCheck(targetKey, expectedMcpUrl, latestVersion),
    queryFn: async () => {
      const request = buildHealthCheckRequest({
        expectedMcpUrl,
        relayTargetId,
        latestVersion,
      });
      const res = await fetch(request.url, request.init);
      return res.json();
    },
    staleTime: 0,
  });
}
