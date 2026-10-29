import { z } from "zod";
import type { AlwaysAllowRule } from "../../shared/contracts.js";
import { normalizeScopePath } from "../../shared/sandbox-policy.js";

/**
 * TTL applied when persisting an always-allow rule from an approval decision
 * (7 days). A rule older than this is treated as expired and pruned.
 */
export const ALWAYS_ALLOW_RULE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Keys-covered shape: a new key on `AlwaysAllowRule` fails tsc here. Not
 * `.strict()`, so a rule persisted by a newer build with an additive field
 * still validates; `isAlwaysAllowRule` returns the ORIGINAL object, never Zod
 * output, so those fields survive a prune + re-persist byte for byte.
 */
const alwaysAllowRuleShape = {
  // RemoveAlwaysAllowRule rejects a blank id and compares the TRIMMED id, so a
  // blank or whitespace-padded stored id could never be revoked. Such a rule is
  // treated as malformed rather than left auto-approving.
  id: z.string().refine((id) => id.length > 0 && id === id.trim()),
  operationId: z.string(),
  method: z.string(),
  path: z.string(),
  scopePath: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
} satisfies Record<keyof AlwaysAllowRule, z.ZodTypeAny>;

const alwaysAllowRuleSchema = z.object(alwaysAllowRuleShape);

/**
 * Drop always-allow rules that are malformed (electron-store has no schema, so
 * a `[null]` can reach disk) or whose `expiresAt` is in the past (or
 * unparseable). Pure — callers persist the returned array when it differs from
 * the input.
 */
export function pruneExpiredAlwaysAllowRules(
  rules: AlwaysAllowRule[] | undefined,
  now = Date.now()
): AlwaysAllowRule[] {
  if (!Array.isArray(rules) || rules.length === 0) {
    return [];
  }

  return rules.filter((rule) => {
    if (!isAlwaysAllowRule(rule)) {
      return false;
    }
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

export function isAlwaysAllowRule(value: unknown): value is AlwaysAllowRule {
  return alwaysAllowRuleSchema.safeParse(value).success;
}

/**
 * The original array when every element is a well-formed rule, else `null`.
 * Callers drop the write on `null`; they never throw on it.
 */
export function parseAlwaysAllowRules(
  value: unknown
): AlwaysAllowRule[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.every(isAlwaysAllowRule) ? value : null;
}
