import type {
  CascadeStepInput,
  CreateRoutineInput,
  InvokedComponent,
  RoutineRunAttempt,
  UpdateRoutineInput,
} from "@repo/api/src/types/routine";
import { RoutineProvider } from "@repo/api/src/types/routine";
import type { Prisma } from "@repo/database";

/**
 * FEA-4365 — pure input→Prisma mappers and provider-capability normalization for
 * the Routines service. Kept here (not in `service.ts`) so the service module
 * stays an orchestration surface and the mapping/normalization rules live in one
 * testable place.
 *
 * Provider gating (mirrors the prototype's `providerCapabilities`): Claude-only
 * fields (`permissionMode`, `worktree`, `folderOrRepo`, `connectorIds`) and
 * Codex-only fields (`reasoningEffort`, `runsIn`, `project`) are NORMALIZED to
 * their empty/null value for a provider that can't emit them. This is applied on
 * every create AND on a provider transition in update, so switching a routine's
 * provider can never leave stale fields from the previous provider behind
 * (contradicting the null/empty contract the schema documents).
 */

type ProviderCapabilities = {
  /** Codex-only: reasoning effort + runsIn + named project workspace. */
  codexOnly: boolean;
  /** Claude-only: permission mode + worktree + folderOrRepo + connectors. */
  claudeOnly: boolean;
};

function capabilitiesFor(provider: RoutineProvider): ProviderCapabilities {
  return {
    codexOnly: provider === RoutineProvider.Codex,
    claudeOnly: provider === RoutineProvider.Claude,
  };
}

function serializeInvokedComponents(
  components: readonly InvokedComponent[] | undefined
): InvokedComponent[] {
  // Persisted as a JSON column; return a plain array so Prisma serializes it.
  // Tolerate an absent list (a caller that skipped the field defaults to []).
  return (components ?? []).map((component) => ({ ...component }));
}

function serializeAttempts(
  attempts: readonly RoutineRunAttempt[] | undefined
): RoutineRunAttempt[] {
  return (attempts ?? []).map((attempt) => ({ ...attempt }));
}

function serializeCascade(
  cascade: readonly CascadeStepInput[] | undefined
): CascadeStepInput[] {
  return (cascade ?? []).map((step) => ({ ...step }));
}

/** Claude-only capability fields, normalized to null/[] for other providers. */
function claudeCapabilityFields(
  input: CreateRoutineInput,
  claudeOnly: boolean
) {
  return {
    folderOrRepo: claudeOnly ? (input.folderOrRepo ?? null) : null,
    connectorIds: claudeOnly ? input.connectorIds : [],
    permissionMode: claudeOnly ? (input.permissionMode ?? null) : null,
    worktree: claudeOnly ? input.worktree : false,
  };
}

/** Codex-only capability fields, normalized to null for other providers. */
function codexCapabilityFields(input: CreateRoutineInput, codexOnly: boolean) {
  return {
    project: codexOnly ? (input.project ?? null) : null,
    runsIn: codexOnly ? (input.runsIn ?? null) : null,
    reasoningEffort: codexOnly ? (input.reasoningEffort ?? null) : null,
  };
}

/** crewd ScheduledTask carry-through fields, normalized to safe defaults. */
function crewdCarryFields(input: CreateRoutineInput) {
  return {
    route: input.route ?? null,
    harnessCascade: serializeCascade(input.harnessCascade),
    catchUp: input.catchUp,
    recurring: input.recurring,
    durable: input.durable,
    passKind: input.passKind ?? null,
    pass: input.pass ?? null,
    crew: input.crew,
    meta: (input.meta ?? {}) as Prisma.InputJsonValue,
  };
}

/**
 * Map a validated create/upsert input to the Prisma write payload, stamping the
 * caller's org and NORMALIZING provider-conditional fields so a field a provider
 * can't emit is stored as its empty/null value regardless of what the caller
 * sent. Identity (`id`) is applied by the caller; `organizationId` here.
 */
function buildRoutineWriteData(
  organizationId: string,
  input: CreateRoutineInput
): Prisma.RoutineUncheckedCreateInput {
  const caps = capabilitiesFor(input.provider);
  return {
    organizationId,
    sourceId: input.sourceId ?? null,
    teamId: input.teamId ?? null,
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    ownerId: input.ownerId ?? null,
    ownerName: input.ownerName ?? null,
    provider: input.provider,
    modelId: input.modelId,
    runsOn: input.runsOn,
    origin: input.origin,
    status: input.status,
    scheduleKind: input.scheduleKind,
    scheduleDetail: input.scheduleDetail,
    cron: input.cron ?? null,
    timezone: input.timezone,
    enabled: input.enabled,
    notifyMode: input.notifyMode,
    autoFixPullRequests: input.autoFixPullRequests,
    hostMachine: input.hostMachine ?? null,
    ...claudeCapabilityFields(input, caps.claudeOnly),
    ...codexCapabilityFields(input, caps.codexOnly),
    ...crewdCarryFields(input),
  };
}

/**
 * Map a validated PARTIAL update to a Prisma update payload. Only keys the
 * caller actually supplied are written (an absent key is left unchanged);
 * nullable columns accept explicit null to clear a provider-conditional field.
 * `organizationId`/`id`/`sourceId` are never writable here.
 *
 * When the update CHANGES the provider, the provider-conditional fields of the
 * OUTGOING provider are cleared in the same payload so a Claude→Codex switch
 * can't leave `permissionMode`/`worktree`/`connectorIds`/`folderOrRepo` behind
 * (and vice-versa) — even if the caller didn't mention them.
 */
function buildRoutineUpdateData(
  input: UpdateRoutineInput,
  nextProvider: RoutineProvider | null
): Prisma.RoutineUncheckedUpdateManyInput {
  const data: Prisma.RoutineUncheckedUpdateManyInput = {};
  const assignKeys: (keyof UpdateRoutineInput)[] = [
    "teamId",
    "name",
    "description",
    "instructions",
    "ownerId",
    "ownerName",
    "provider",
    "modelId",
    "runsOn",
    "origin",
    "status",
    "scheduleKind",
    "scheduleDetail",
    "cron",
    "timezone",
    "enabled",
    "notifyMode",
    "folderOrRepo",
    "project",
    "runsIn",
    "hostMachine",
    "connectorIds",
    "autoFixPullRequests",
    "permissionMode",
    "reasoningEffort",
    "worktree",
    "route",
    "harnessCascade",
    "catchUp",
    "recurring",
    "durable",
    "passKind",
    "pass",
    "crew",
    "meta",
  ];
  for (const key of assignKeys) {
    if (input[key] !== undefined) {
      (data as Record<string, unknown>)[key] = input[key];
    }
  }
  applyProviderTransitionClears(data, nextProvider);
  return data;
}

/**
 * When a provider transition is in play, force the outgoing provider's
 * capability fields to their empty/null value so they cannot survive the switch
 * regardless of whether the caller included them.
 */
function applyProviderTransitionClears(
  data: Prisma.RoutineUncheckedUpdateManyInput,
  nextProvider: RoutineProvider | null
): void {
  if (nextProvider === null) {
    return;
  }
  const caps = capabilitiesFor(nextProvider);
  if (!caps.claudeOnly) {
    data.folderOrRepo = null;
    data.connectorIds = [];
    data.permissionMode = null;
    data.worktree = false;
  }
  if (!caps.codexOnly) {
    data.project = null;
    data.runsIn = null;
    data.reasoningEffort = null;
  }
}

export {
  buildRoutineUpdateData,
  buildRoutineWriteData,
  serializeAttempts,
  serializeInvokedComponents,
};
