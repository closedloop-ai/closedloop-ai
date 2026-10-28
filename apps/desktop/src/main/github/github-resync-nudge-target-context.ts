import { isRecord } from "../../shared/type-guards.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ActiveCommandKeyTargetContext = {
  computeTargetId: string;
  gatewayId?: string;
};

export type ParsedBrowserCommandKeyCommandTargetContext =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "present"; context: ActiveCommandKeyTargetContext };

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

function normalizeUuid(value: unknown): string | null {
  return isUuid(value) ? value.trim() : null;
}

/**
 * Parses optional target context from a reserved command body.
 * Present-but-invalid context is distinct from truly absent context.
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
 * ISS-7486: why a reserved command's target context did not match the active
 * one. This is the distinction the previous boolean collapsed.
 *
 * Over the 7 days to 2026-09-14, 39,110 rejected desktop command acks — 100% of
 * every rejection, every other reason at zero — carried the single wire reason
 * that boolean produced. Three unrelated failures shared it, and only the last
 * is a disagreement: the command carried no context at all, the DESKTOP had no
 * resolvable active context, or both sides named a target and they differ.
 * Reporting the first two as a mismatch is absence dressed as disagreement, and
 * the remedy for each is a different change.
 */
export const BrowserCommandKeyTargetContextOutcome = {
  Match: "match",
  /** The command carried no target context at all. */
  CommandContextAbsent: "command_context_absent",
  /** The DESKTOP could not resolve an active context. Nothing disagreed. */
  ActiveContextUnresolved: "active_context_unresolved",
  /** Both sides named a compute target and they differ. */
  ComputeTargetMismatch: "compute_target_mismatch",
  /** The command named a gateway and it differs from the active one. */
  GatewayMismatch: "gateway_mismatch",
} as const;

export type BrowserCommandKeyTargetContextOutcome =
  (typeof BrowserCommandKeyTargetContextOutcome)[keyof typeof BrowserCommandKeyTargetContextOutcome];

/** Every outcome that is a rejection; the match is the only one that is not. */
export type BrowserCommandKeyTargetContextRejection = Exclude<
  BrowserCommandKeyTargetContextOutcome,
  typeof BrowserCommandKeyTargetContextOutcome.Match
>;

/**
 * Classifies a reserved command's target context against the active one.
 *
 * Present-but-invalid context is the caller's to reject before it gets here —
 * every producer already does, and excluding it keeps this fold exhaustive over
 * outcomes that can actually be counted.
 */
export function classifyBrowserCommandKeyTargetContext(input: {
  commandContext: Exclude<
    ParsedBrowserCommandKeyCommandTargetContext,
    { kind: "invalid" }
  >;
  activeContext?: ActiveCommandKeyTargetContext;
}): BrowserCommandKeyTargetContextOutcome {
  if (input.commandContext.kind === "absent") {
    return BrowserCommandKeyTargetContextOutcome.CommandContextAbsent;
  }
  const active = input.activeContext;
  if (!active) {
    return BrowserCommandKeyTargetContextOutcome.ActiveContextUnresolved;
  }
  const { context } = input.commandContext;
  if (context.computeTargetId !== active.computeTargetId) {
    return BrowserCommandKeyTargetContextOutcome.ComputeTargetMismatch;
  }
  if (
    context.gatewayId !== undefined &&
    context.gatewayId !== active.gatewayId
  ) {
    return BrowserCommandKeyTargetContextOutcome.GatewayMismatch;
  }
  return BrowserCommandKeyTargetContextOutcome.Match;
}
