import type { AlwaysAllowRule } from "../../shared/contracts.js";
import { normalizeScopePath } from "../../shared/sandbox-policy.js";

/**
 * TTL applied when persisting an always-allow rule from an approval decision
 * (7 days). A rule older than this is treated as expired and pruned.
 */
export const ALWAYS_ALLOW_RULE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Drop always-allow rules whose `expiresAt` is in the past (or unparseable).
 * Pure — callers persist the returned array when it differs from the input.
 */
export function pruneExpiredAlwaysAllowRules(
  rules: AlwaysAllowRule[] | undefined,
  now = Date.now()
): AlwaysAllowRule[] {
  if (!Array.isArray(rules) || rules.length === 0) {
    return [];
  }

  return rules.filter((rule) => {
    const expiresAt = Date.parse(rule.expiresAt);
    if (Number.isNaN(expiresAt)) {
      return false;
    }
    return expiresAt > now;
  });
}

/**
 * True when an active always-allow rule matches the request (same operation,
 * method, path, and normalized scope path).
 */
export function matchesAlwaysAllowRule(
  rules: AlwaysAllowRule[],
  request: {
    operationId: string;
    method: string;
    path: string;
    scopePath?: string | null;
  }
): boolean {
  const normalizedScope = normalizeScopePath(request.scopePath);
  return rules.some((rule) => {
    if (rule.operationId !== request.operationId) {
      return false;
    }
    if (rule.method.toUpperCase() !== request.method.toUpperCase()) {
      return false;
    }
    if (rule.path !== request.path) {
      return false;
    }
    return normalizeScopePath(rule.scopePath) === normalizedScope;
  });
}
