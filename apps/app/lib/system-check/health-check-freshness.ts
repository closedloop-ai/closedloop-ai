"use client";

import type { HealthCheckResponse } from "@/lib/engineer/queries/health-check";
import { getRenderableHealthChecks } from "@/lib/engineer/queries/health-check";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLI_CHECK_IDS = new Set([
  "git",
  "claude-cli",
  "github-cli",
  "python3",
  "codex-cli",
]);

export const HEALTH_CHECK_CLI_FRESHNESS_MS = 7 * DAY_MS;
export const HEALTH_CHECK_DEFAULT_FRESHNESS_MS = DAY_MS;

type CheckedAtInput = Date | string | number;

export type HealthCheckCacheEntry = {
  data: HealthCheckResponse;
  checkedAt: CheckedAtInput;
  expectedMcpUrl?: string | null;
  latestVersion?: string | null;
  pluginAutoUpdateEnabled?: boolean;
};

type HealthCheckFreshnessInput = {
  entry: HealthCheckCacheEntry;
  expectedMcpUrl: string | null;
  latestVersion?: string | null;
  pluginAutoUpdateEnabled?: boolean;
  now?: number;
  requiredOnly?: boolean;
};

function toTimestamp(checkedAt: CheckedAtInput): number {
  if (typeof checkedAt === "number") {
    return checkedAt;
  }
  return new Date(checkedAt).getTime();
}

function getFreshnessWindowMs(checkId: string): number {
  return CLI_CHECK_IDS.has(checkId)
    ? HEALTH_CHECK_CLI_FRESHNESS_MS
    : HEALTH_CHECK_DEFAULT_FRESHNESS_MS;
}

function isMcpCheckId(checkId: string): boolean {
  return checkId.endsWith("-mcp");
}

/** Returns the age of a cached health-check entry, or null if its timestamp is invalid. */
export function getHealthCheckCacheAgeMs(
  entry: HealthCheckCacheEntry,
  now = Date.now()
): number | null {
  const checkedAtMs = toTimestamp(entry.checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    return null;
  }
  return now - checkedAtMs;
}

/**
 * Evaluates whether a cached health-check result is still valid for the current
 * target context. CLI-only rows get a longer window; app/config/plugin/MCP and
 * unknown rows use the conservative one-day window.
 */
export function isHealthCheckCacheEntryFresh({
  entry,
  expectedMcpUrl,
  latestVersion = null,
  pluginAutoUpdateEnabled = false,
  now = Date.now(),
  requiredOnly = false,
}: HealthCheckFreshnessInput): boolean {
  const ageMs = getHealthCheckCacheAgeMs(entry, now);
  if (ageMs === null || ageMs < 0) {
    return false;
  }

  if ((entry.pluginAutoUpdateEnabled ?? false) !== pluginAutoUpdateEnabled) {
    return false;
  }

  const checks =
    getRenderableHealthChecks(entry.data, expectedMcpUrl)?.filter(
      (check) => !requiredOnly || check.required
    ) ?? [];
  if (checks.length === 0) {
    return ageMs <= HEALTH_CHECK_DEFAULT_FRESHNESS_MS;
  }

  if (
    latestVersion &&
    checks.some((check) => check.id === "app-version") &&
    entry.latestVersion !== latestVersion
  ) {
    return false;
  }

  if (
    checks.some((check) => isMcpCheckId(check.id)) &&
    (entry.expectedMcpUrl ?? null) !== expectedMcpUrl
  ) {
    return false;
  }

  return checks.every((check) => ageMs <= getFreshnessWindowMs(check.id));
}
