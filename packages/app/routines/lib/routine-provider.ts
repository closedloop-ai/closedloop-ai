/**
 * Cross-provider Routine model — providers, models, connectors, and the
 * `providerCapabilities` switch (FEA-4349 / PRD-566).
 *
 * A Routine is a scheduled agent run that can target either the Claude
 * (Claude Code) or Codex harness. Each provider exposes a different config
 * surface — Claude has permission modes, worktrees, connectors, a
 * behavior/auto-fix toggle, a manual trigger, and folder-scoped context;
 * Codex has a reasoning-effort selector and project-scoped context, and none
 * of the Claude-only items. `providerCapabilities` is the SINGLE source of
 * truth for those differences: every provider-conditional field consults this
 * record rather than checking the provider id ad hoc, so adding a third
 * provider is one row here instead of hunting down every branch.
 *
 * Faithful to the frozen prototype at
 * `apps/prototypes/app/p/routines/mock.ts` (do not fork the vocabulary).
 *
 * NOTE — const-object enums, never TS `enum` or arrays (Biome forbids `enum`);
 * runtime const references everywhere; new declarations appended at the bottom.
 */

export const RoutineProvider = {
  Claude: "claude",
  Codex: "codex",
} as const;
export type RoutineProvider =
  (typeof RoutineProvider)[keyof typeof RoutineProvider];

export const providerLabel: Record<RoutineProvider, string> = {
  [RoutineProvider.Claude]: "Claude",
  [RoutineProvider.Codex]: "Codex",
};

export type ModelOption = {
  id: string;
  label: string;
  provider: RoutineProvider;
};

export const modelOptions: readonly ModelOption[] = [
  { id: "fable-5", label: "Fable 5", provider: RoutineProvider.Claude },
  { id: "opus-4-8", label: "Opus 4.8", provider: RoutineProvider.Claude },
  { id: "sonnet-5", label: "Sonnet 5", provider: RoutineProvider.Claude },
  { id: "haiku-4-5", label: "Haiku 4.5", provider: RoutineProvider.Claude },
  { id: "gpt-5-6-sol", label: "GPT-5.6 Sol", provider: RoutineProvider.Codex },
  {
    id: "gpt-5-6-terra",
    label: "GPT-5.6 Terra",
    provider: RoutineProvider.Codex,
  },
  {
    id: "gpt-5-6-luna",
    label: "GPT-5.6 Luna",
    provider: RoutineProvider.Codex,
  },
  { id: "gpt-5-5", label: "GPT-5.5", provider: RoutineProvider.Codex },
  { id: "gpt-5-4", label: "GPT-5.4", provider: RoutineProvider.Codex },
  {
    id: "gpt-5-4-mini",
    label: "GPT-5.4 Mini",
    provider: RoutineProvider.Codex,
  },
  {
    id: "gpt-5-3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    provider: RoutineProvider.Codex,
  },
];

/**
 * How a provider scopes a routine's working context: Claude routines target a
 * local folder or repo string; Codex routines target a named project workspace.
 */
export const ContextKind = {
  Folder: "folder",
  Project: "project",
} as const;
export type ContextKind = (typeof ContextKind)[keyof typeof ContextKind];

/**
 * Claude's permission mode — the DOMAIN value the Claude Code harness actually
 * consumes at the execution boundary. These are the canonical SDK wire values
 * (`default`/`acceptEdits`/`plan`/`bypassPermissions`); the config UI shows the
 * matching `permissionModeLabel` copy, but the routine persists and forwards the
 * value, so the label is never mistaken for the harness input.
 */
export const PermissionMode = {
  Default: "default",
  AcceptEdits: "acceptEdits",
  Plan: "plan",
  BypassPermissions: "bypassPermissions",
} as const;
export type PermissionMode =
  (typeof PermissionMode)[keyof typeof PermissionMode];

export const permissionModeLabel: Record<PermissionMode, string> = {
  [PermissionMode.Default]: "Settings default",
  [PermissionMode.Plan]: "Plan",
  [PermissionMode.AcceptEdits]: "Accept edits",
  [PermissionMode.BypassPermissions]: "Bypass permissions",
};

/**
 * Codex's reasoning effort — the DOMAIN value forwarded verbatim to Codex's
 * `model_reasoning_effort` flag (see `apps/desktop/src/server/operations/codex.ts`).
 * Values are the lowercase tokens the flag accepts; the config UI shows the
 * matching `reasoningEffortLabel` copy, never the raw token, and never a display
 * string like "Extra High" that would not survive the flag boundary.
 */
export const ReasoningEffort = {
  Minimal: "minimal",
  Low: "low",
  Medium: "medium",
  High: "high",
} as const;
export type ReasoningEffort =
  (typeof ReasoningEffort)[keyof typeof ReasoningEffort];

export const reasoningEffortLabel: Record<ReasoningEffort, string> = {
  [ReasoningEffort.Minimal]: "Minimal",
  [ReasoningEffort.Low]: "Low",
  [ReasoningEffort.Medium]: "Medium",
  [ReasoningEffort.High]: "High",
};

/**
 * A selectable option in a provider-conditional dropdown: a typed domain
 * `value` (what crosses the execution boundary) paired with display `label`
 * copy (what the picker renders). Kept generic over the value union so the two
 * Routine fields type from the value, not the label.
 */
export type CapabilityOption<Value extends string> = {
  value: Value;
  label: string;
};

export const permissionModeOptions: readonly CapabilityOption<PermissionMode>[] =
  deepFreeze([
    { value: PermissionMode.Default, label: permissionModeLabel.default },
    { value: PermissionMode.Plan, label: permissionModeLabel.plan },
    {
      value: PermissionMode.AcceptEdits,
      label: permissionModeLabel.acceptEdits,
    },
    {
      value: PermissionMode.BypassPermissions,
      label: permissionModeLabel.bypassPermissions,
    },
  ]);

export const reasoningEffortOptions: readonly CapabilityOption<ReasoningEffort>[] =
  deepFreeze([
    { value: ReasoningEffort.Minimal, label: reasoningEffortLabel.minimal },
    { value: ReasoningEffort.Low, label: reasoningEffortLabel.low },
    { value: ReasoningEffort.Medium, label: reasoningEffortLabel.medium },
    { value: ReasoningEffort.High, label: reasoningEffortLabel.high },
  ]);

/**
 * The single source of truth for what a provider's scheduled-run config surface
 * can show. Every provider-conditional field in the New Routine form and the
 * read-only Detail view consults this record rather than checking the provider
 * id directly. Where a provider does not show a field at all, hide it rather
 * than rendering it disabled.
 *
 * The whole record is deeply `readonly` (via `DeepReadonly` + `as const` on the
 * literal) so a consumer that reads `capabilities.connectors` or holds an option
 * list cannot legally mutate the shared object and flip a capability for every
 * later reader (`capabilitiesForProvider` returns these objects by reference).
 *
 * - `manualTrigger` — the schedule picker offers a "Manual" (run-on-demand)
 *   trigger. Claude only; Codex's Repeat options have no Manual.
 * - `permissionModes` — the Permissions dropdown options (typed domain value +
 *   display label), or `null` when the provider has no permission concept (Codex).
 * - `worktree` — the "run in a git worktree" checkbox (Claude only).
 * - `connectors` — the Connectors tab / data-source integrations (Claude only).
 * - `behaviorAutoFix` — the Behavior tab's auto-fix-pull-requests toggle
 *   (Claude only).
 * - `reasoningEffortOptions` — the reasoning-effort selector options (typed
 *   domain value + display label), or `null` when the provider has no equivalent
 *   (Claude).
 * - `contextKind` — how the provider scopes context (folder vs project).
 */
export type ProviderCapabilities = {
  manualTrigger: boolean;
  permissionModes: readonly CapabilityOption<PermissionMode>[] | null;
  worktree: boolean;
  connectors: boolean;
  behaviorAutoFix: boolean;
  reasoningEffortOptions: readonly CapabilityOption<ReasoningEffort>[] | null;
  contextKind: ContextKind;
};

export const providerCapabilities: DeepReadonly<
  Record<RoutineProvider, ProviderCapabilities>
> = deepFreeze({
  [RoutineProvider.Claude]: {
    manualTrigger: true,
    permissionModes: permissionModeOptions,
    worktree: true,
    connectors: true,
    behaviorAutoFix: true,
    reasoningEffortOptions: null,
    contextKind: ContextKind.Folder,
  },
  [RoutineProvider.Codex]: {
    manualTrigger: false,
    permissionModes: null,
    worktree: false,
    connectors: false,
    behaviorAutoFix: false,
    reasoningEffortOptions,
    contextKind: ContextKind.Project,
  },
});

/**
 * Codex's "Runs in" choice: continue the chat this task was set up from, or
 * always start a fresh one. No Claude equivalent — Claude routines are scoped
 * by folder/repo, not by chat continuity.
 */
export const RunsIn = {
  NewChat: "new-chat",
  ExistingChat: "existing-chat",
} as const;
export type RunsIn = (typeof RunsIn)[keyof typeof RunsIn];

export const runsInLabel: Record<RunsIn, string> = {
  [RunsIn.NewChat]: "New chat",
  [RunsIn.ExistingChat]: "Existing chat",
};

/**
 * Codex's Project is a named workspace picked from a list (mirrors the sidebar's
 * own "Projects" grouping), not a free-text folder or repo path.
 */
export const codexProjectOptions: readonly string[] = [
  "None",
  "Closedloop.ai - Active Work",
  "Eye&Co",
];

/**
 * Notification scope, shared across both providers (Codex's Scheduled Tasks
 * panel shows this exact All-runs / Failed-runs-only control on every trigger
 * type).
 */
export const NotifyMode = {
  AllRuns: "all-runs",
  FailedRunsOnly: "failed-runs-only",
} as const;
export type NotifyMode = (typeof NotifyMode)[keyof typeof NotifyMode];

export const notifyModeLabel: Record<NotifyMode, string> = {
  [NotifyMode.AllRuns]: "All runs",
  [NotifyMode.FailedRunsOnly]: "Failed runs only",
};

export type ConnectorOption = {
  id: string;
  label: string;
  availableFor: readonly RoutineProvider[];
};

/**
 * Connectors — data-source integrations. Claude-only per the Codex reference
 * (no Connectors concept there); the whole Connectors surface is gated on
 * `providerCapabilities.connectors`, and `availableFor` exists underneath that
 * gate so a connector could later be scoped further without a new mechanism.
 */
export const connectorOptions: readonly ConnectorOption[] = [
  { id: "asana", label: "Asana", availableFor: [RoutineProvider.Claude] },
  {
    id: "closedloop",
    label: "ClosedLoop",
    availableFor: [RoutineProvider.Claude],
  },
  { id: "gmail", label: "Gmail", availableFor: [RoutineProvider.Claude] },
  {
    id: "google-calendar",
    label: "Google Calendar",
    availableFor: [RoutineProvider.Claude],
  },
  {
    id: "google-drive",
    label: "Google Drive",
    availableFor: [RoutineProvider.Claude],
  },
  { id: "gusto", label: "Gusto", availableFor: [RoutineProvider.Claude] },
  {
    id: "quickbooks",
    label: "Intuit QuickBooks",
    availableFor: [RoutineProvider.Claude],
  },
];

/**
 * The conservative capability floor for a provider this build does not know —
 * an unknown/new harness (e.g. a crewd `opencode` cascade step, or a provider
 * added by a newer build). Every provider-conditional surface is HIDDEN
 * (`false`/`null`) so an unrecognized provider degrades gracefully to the safe
 * default rather than crashing on an `undefined` capability lookup. Context
 * defaults to folder scope, the least assuming surface.
 */
export const fallbackProviderCapabilities: DeepReadonly<ProviderCapabilities> =
  deepFreeze({
    manualTrigger: false,
    permissionModes: null,
    worktree: false,
    connectors: false,
    behaviorAutoFix: false,
    reasoningEffortOptions: null,
    contextKind: ContextKind.Folder,
  });

/** The model options a given provider offers (drives the New Routine picker). */
export function modelsForProvider(
  provider: RoutineProvider
): readonly ModelOption[] {
  return modelOptions.filter((model) => model.provider === provider);
}

/** The connectors available to a given provider. */
export function connectorsForProvider(
  provider: RoutineProvider
): readonly ConnectorOption[] {
  return connectorOptions.filter((connector) =>
    connector.availableFor.includes(provider)
  );
}

/**
 * The capability record for a provider — the single provider-conditional switch.
 * Accepts an arbitrary provider string (not just a known `RoutineProvider`) so a
 * cascade step from an unknown/newer harness degrades to the conservative
 * `fallbackProviderCapabilities` floor instead of returning `undefined` and
 * crashing every `capabilities.<field>` read downstream.
 */
export function capabilitiesForProvider(
  provider: RoutineProvider | string
): DeepReadonly<ProviderCapabilities> {
  return (
    providerCapabilities[provider as RoutineProvider] ??
    fallbackProviderCapabilities
  );
}

/**
 * Recursively marks every property (and array element) of `T` as `readonly`, so
 * a shared capability object handed out by reference cannot be mutated by a
 * caller. Functions are left as-is. Local to this module — no repo-wide
 * `DeepReadonly` utility exists to reuse.
 */
export type DeepReadonly<T> = T extends (...args: readonly unknown[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/**
 * Recursively `Object.freeze`s `value` (its own object/array properties too) and
 * returns it typed as `DeepReadonly<T>`. Backs the RUNTIME half of the
 * immutability guarantee that `DeepReadonly` only expresses at compile time, so a
 * caller that ignores the types still cannot mutate a shared capability record or
 * option list. `function` declaration (hoisted) so the module-scope consts above
 * can freeze at initialization.
 */
function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
