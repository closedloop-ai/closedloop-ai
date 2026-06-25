import { BROWSER_KEY_TARGET_ACCESS } from "../shared/contracts.js";
import { isRecord } from "../shared/type-guards.js";
import { normalizeCommandKeyFingerprint } from "./authorized-command-key-store.js";
import type { OrganizationCommandPublicKey } from "./authorized-public-keys-client.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ActiveCommandKeyTargetContext = {
  computeTargetId: string;
  gatewayId?: string;
};

export type CommandKeyReconciliationReason =
  | "hello_ack"
  | "periodic"
  | "manual";

export type OrganizationCommandKeyReconciliationMode =
  | "full"
  | "promote_only"
  | "skip";

export type OrganizationCommandKeyClassificationKind =
  | "empty"
  | "all_scoped"
  | "mixed_scoped"
  | "legacy_broad"
  | "invalid_only";

export type OrganizationCommandKeyClassification = {
  kind: OrganizationCommandKeyClassificationKind;
  reconciliationMode: OrganizationCommandKeyReconciliationMode;
  relevantKeys: OrganizationCommandPublicKey[];
  notificationKeys: OrganizationCommandPublicKey[];
  ignoredKeys: OrganizationCommandPublicKey[];
  diagnostics: {
    reason: CommandKeyReconciliationReason;
    fetchedCount: number;
    relevantCount: number;
    ignoredCount: number;
    legacyCount: number;
    invalidContextCount: number;
    mismatchedContextCount: number;
    activeComputeTargetId?: string;
    activeGatewayPresent: boolean;
  };
};

export type ParsedBrowserCommandKeyCommandTargetContext =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "present"; context: ActiveCommandKeyTargetContext };

type ParsedResponseTargetContext =
  | { ok: true; context: ActiveCommandKeyTargetContext }
  | { ok: false; reason: "absent" | "invalid" | "mismatch" };

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

function normalizeUuid(value: unknown): string | null {
  return isUuid(value) ? value.trim() : null;
}

function targetContextMatchesActive(input: {
  context: ActiveCommandKeyTargetContext;
  activeContext?: ActiveCommandKeyTargetContext;
}): boolean {
  if (!input.activeContext) {
    return false;
  }
  if (input.context.computeTargetId !== input.activeContext.computeTargetId) {
    return false;
  }
  if (input.context.gatewayId === undefined) {
    return true;
  }
  return input.context.gatewayId === input.activeContext.gatewayId;
}

function parseResponseTargetContext(
  key: OrganizationCommandPublicKey,
  activeContext?: ActiveCommandKeyTargetContext
): ParsedResponseTargetContext {
  if (!("targetContext" in key)) {
    return { ok: false, reason: "absent" };
  }
  if (!isRecord(key.targetContext)) {
    return { ok: false, reason: "invalid" };
  }
  const record = key.targetContext;
  if (record.access !== BROWSER_KEY_TARGET_ACCESS.OwnedTarget) {
    return { ok: false, reason: "invalid" };
  }
  const computeTargetId = normalizeUuid(record.computeTargetId);
  if (!computeTargetId) {
    return { ok: false, reason: "invalid" };
  }
  const hasGateway = Object.hasOwn(record, "gatewayId");
  const gatewayId = hasGateway ? normalizeUuid(record.gatewayId) : undefined;
  if (hasGateway && !gatewayId) {
    return { ok: false, reason: "invalid" };
  }

  const context = {
    computeTargetId,
    ...(gatewayId ? { gatewayId } : {}),
  };
  if (!targetContextMatchesActive({ context, activeContext })) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, context };
}

/**
 * Classifies API `/public-keys` output before the reconciler mutates local
 * key state. Only valid owner-target matches become relevant.
 */
export function classifyOrganizationCommandKeysForTarget(input: {
  keys: OrganizationCommandPublicKey[];
  activeContext?: ActiveCommandKeyTargetContext;
  reason: CommandKeyReconciliationReason;
}): OrganizationCommandKeyClassification {
  if (input.keys.length === 0) {
    return {
      kind: "empty",
      reconciliationMode: input.activeContext ? "full" : "skip",
      relevantKeys: [],
      notificationKeys: [],
      ignoredKeys: [],
      diagnostics: {
        reason: input.reason,
        fetchedCount: 0,
        relevantCount: 0,
        ignoredCount: 0,
        legacyCount: 0,
        invalidContextCount: 0,
        mismatchedContextCount: 0,
        activeComputeTargetId: input.activeContext?.computeTargetId,
        activeGatewayPresent: Boolean(input.activeContext?.gatewayId),
      },
    };
  }

  const relevantKeys: OrganizationCommandPublicKey[] = [];
  const ignoredKeys: OrganizationCommandPublicKey[] = [];
  let legacyCount = 0;
  let invalidContextCount = 0;
  let mismatchedContextCount = 0;

  for (const key of input.keys) {
    const parsed = parseResponseTargetContext(key, input.activeContext);
    if (parsed.ok) {
      relevantKeys.push(key);
      continue;
    }
    ignoredKeys.push(key);
    if (parsed.reason === "absent") {
      legacyCount += 1;
    } else if (parsed.reason === "mismatch") {
      mismatchedContextCount += 1;
    } else {
      invalidContextCount += 1;
    }
  }

  const kind: OrganizationCommandKeyClassificationKind =
    relevantKeys.length === input.keys.length
      ? "all_scoped"
      : legacyCount === input.keys.length
        ? "legacy_broad"
        : relevantKeys.length > 0
          ? "mixed_scoped"
          : "invalid_only";
  const reconciliationMode: OrganizationCommandKeyReconciliationMode =
    kind === "all_scoped"
      ? "full"
      : kind === "mixed_scoped"
        ? "promote_only"
        : "skip";

  return {
    kind,
    reconciliationMode,
    relevantKeys,
    notificationKeys: reconciliationMode === "skip" ? [] : relevantKeys,
    ignoredKeys,
    diagnostics: {
      reason: input.reason,
      fetchedCount: input.keys.length,
      relevantCount: relevantKeys.length,
      ignoredCount: ignoredKeys.length,
      legacyCount,
      invalidContextCount,
      mismatchedContextCount,
      activeComputeTargetId: input.activeContext?.computeTargetId,
      activeGatewayPresent: Boolean(input.activeContext?.gatewayId),
    },
  };
}

/**
 * Selects a key for explicit approval. Legacy by-fingerprint selection is
 * allowed only when the triggering direct command was truly contextless.
 */
export function selectOrganizationCommandKeyForApproval(input: {
  keys: OrganizationCommandPublicKey[];
  fingerprint: unknown;
  activeContext?: ActiveCommandKeyTargetContext;
  commandTargetContext: ParsedBrowserCommandKeyCommandTargetContext;
}): OrganizationCommandPublicKey | null {
  const fingerprint = normalizeCommandKeyFingerprint(input.fingerprint);
  if (!fingerprint || input.commandTargetContext.kind === "invalid") {
    return null;
  }

  const scoped = classifyOrganizationCommandKeysForTarget({
    keys: input.keys,
    activeContext: input.activeContext,
    reason: "manual",
  }).relevantKeys.find((key) => key.fingerprint === fingerprint);
  if (scoped) {
    return scoped;
  }

  if (input.commandTargetContext.kind !== "absent") {
    return null;
  }
  return (
    input.keys.find(
      (key) => !("targetContext" in key) && key.fingerprint === fingerprint
    ) ?? null
  );
}

/**
 * Parses optional target context from reserved approval/revocation command
 * bodies. Present-but-invalid context is distinct from truly absent context.
 */
export function parseBrowserCommandKeyCommandTargetContext(
  body: unknown
): ParsedBrowserCommandKeyCommandTargetContext {
  if (!isRecord(body)) {
    return { kind: "invalid" };
  }
  const hasComputeTargetId = Object.hasOwn(body, "computeTargetId");
  const hasGatewayId = Object.hasOwn(body, "gatewayId");
  const hasNestedTargetContext = Object.hasOwn(body, "targetContext");
  if (!(hasComputeTargetId || hasGatewayId || hasNestedTargetContext)) {
    return { kind: "absent" };
  }
  if (hasNestedTargetContext || !hasComputeTargetId) {
    return { kind: "invalid" };
  }

  const computeTargetId = normalizeUuid(body.computeTargetId);
  if (!computeTargetId) {
    return { kind: "invalid" };
  }
  const gatewayId = hasGatewayId ? normalizeUuid(body.gatewayId) : undefined;
  if (hasGatewayId && !gatewayId) {
    return { kind: "invalid" };
  }
  return {
    kind: "present",
    context: {
      computeTargetId,
      ...(gatewayId ? { gatewayId } : {}),
    },
  };
}

/**
 * Returns true only when a reserved command carries valid target context for
 * the currently registered Desktop target.
 */
export function browserCommandKeyTargetContextMatches(input: {
  commandContext: ParsedBrowserCommandKeyCommandTargetContext;
  activeContext?: ActiveCommandKeyTargetContext;
}): boolean {
  return (
    input.commandContext.kind === "present" &&
    targetContextMatchesActive({
      context: input.commandContext.context,
      activeContext: input.activeContext,
    })
  );
}
