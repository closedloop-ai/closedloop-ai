import { queryOptions } from "@tanstack/react-query";
import { env } from "@/env";
import type { EngineerRoutingSelection } from "@/lib/engineer/routing-store";
import { queryKeys } from "./keys";

export type CheckResult = {
  id: string;
  label: string;
  required: boolean;
  passed: boolean;
  version?: string;
  error?: string;
  remediation?: string;
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
      return {
        id,
        label,
        required: false,
        passed: false,
        error: availability.error,
        remediation:
          availability.error === "Project-local config unsupported"
            ? installRemediation
            : availability.serverName
              ? `Retry check. ${availability.serverName} is configured for ${availability.matchedUrl ?? expectedMcpUrl ?? "the expected MCP URL"}`
              : expectedMcpUrl
                ? `Retry check. If this persists, verify a user/global MCP server pointing to ${expectedMcpUrl} is configured.`
                : "Retry check.",
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

  const checks = [...response.checks];
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

export function healthCheckOptions(
  routing: HealthCheckTargetScope = "default",
  expectedMcpUrl: string | null = env.NEXT_PUBLIC_MCP_SERVER_URL ?? null
) {
  const targetKey =
    typeof routing === "string" ? routing : getHealthCheckTargetKey(routing);
  const params = new URLSearchParams();

  if (expectedMcpUrl) {
    params.set("expectedMcpUrl", expectedMcpUrl);
  }

  return queryOptions<HealthCheckResponse>({
    queryKey: queryKeys.healthCheck(targetKey, expectedMcpUrl),
    queryFn: async () => {
      const url = params.toString()
        ? `/api/engineer/health-check?${params.toString()}`
        : "/api/engineer/health-check";
      const res = await fetch(url);
      return res.json();
    },
    staleTime: 0,
  });
}
