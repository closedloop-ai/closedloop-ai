// Convert & Install - mock data.
//
// The discover -> convert -> preview -> install flow for FEA-4075. A team member
// finds a component published for one harness (e.g. a Codex command) and wants
// it on their own harness (Claude). Converting on the fly is lossy: some fields
// map cleanly, some map with caveats, some do not map at all. This models the
// FEA-4078 capability map (per-field supported / partial / unsupported) so the
// preview can be honest about what installs, what changes, and what is dropped
// before the user commits.
//
// Presentational, mock-only. Deterministic ordering, no dates, no fetch.

// Harness format a component targets. Mirrors the Packs prototype domain.
export const Harness = {
  Claude: "claude",
  Codex: "codex",
} as const;

export type Harness = (typeof Harness)[keyof typeof Harness];

export const HARNESS_LABEL: Record<Harness, string> = {
  [Harness.Claude]: "Claude",
  [Harness.Codex]: "Codex",
};

// The kind of component being converted. Mirrors PackContentKind minus MCP,
// which does not convert between harnesses in this flow.
export const ComponentKind = {
  Agent: "agent",
  Skill: "skill",
  Command: "command",
  Hook: "hook",
} as const;

export type ComponentKind = (typeof ComponentKind)[keyof typeof ComponentKind];

export const COMPONENT_KIND_LABEL: Record<ComponentKind, string> = {
  [ComponentKind.Agent]: "Agent",
  [ComponentKind.Skill]: "Skill",
  [ComponentKind.Command]: "Command",
  [ComponentKind.Hook]: "Hook",
};

// How a single source field maps onto the target harness, from the capability
// map. Supported maps 1:1; partial maps with a caveat (renamed, approximated,
// or degraded); unsupported has no target equivalent and is dropped.
export const FieldSupport = {
  Supported: "supported",
  Partial: "partial",
  Unsupported: "unsupported",
} as const;

export type FieldSupport = (typeof FieldSupport)[keyof typeof FieldSupport];

export const FIELD_SUPPORT_LABEL: Record<FieldSupport, string> = {
  [FieldSupport.Supported]: "Converts cleanly",
  [FieldSupport.Partial]: "Converts with changes",
  [FieldSupport.Unsupported]: "Not supported",
};

// One row of the conversion breakdown: a source field and how it lands on the
// target. `note` explains a partial mapping or why a field is dropped.
export type FieldMapping = {
  /** Field as named on the source harness. */
  sourceField: string;
  /** Field as it lands on the target harness, or null when dropped. */
  targetField: string | null;
  support: FieldSupport;
  /** Caveat for partial mappings; drop reason for unsupported. */
  note?: string;
  /**
   * True when this dropped field is itself the reason install is blocked (a
   * required capability with no target equivalent), as opposed to a field that
   * only drops because it depends on another blocking capability. Lets the
   * blocked banner count root blockers, not every dependent dropped field.
   */
  blocksInstall?: boolean;
};

// The overall convertibility of a source -> target pairing, from the capability
// map. Clean: every field maps. Partial: some fields drop or degrade, install
// still allowed with a warning. Blocked: a required capability has no target
// equivalent, install is not offered.
export const Convertibility = {
  Clean: "clean",
  Partial: "partial",
  Blocked: "blocked",
} as const;

export type Convertibility =
  (typeof Convertibility)[keyof typeof Convertibility];

// The terminal result of a convert-and-install attempt, used only to drive the
// prototype's converting -> installed vs. converting -> error demo. In
// production this is the real write result, not a fixture.
export const InstallOutcome = {
  Success: "success",
  Error: "error",
} as const;

export type InstallOutcome =
  (typeof InstallOutcome)[keyof typeof InstallOutcome];

// A discoverable component in its published (source) harness format.
export type SourceComponent = {
  id: string;
  name: string;
  kind: ComponentKind;
  description: string;
  /** Harness the component was originally authored for. */
  sourceHarness: Harness;
  /** Marketplace org / author shown as provenance. */
  publisher: string;
  /** Convertibility onto the other harness (the single target in this flow). */
  convertibility: Convertibility;
  /** Per-field mapping onto the target harness. */
  mappings: readonly FieldMapping[];
  /**
   * Demo-only: how the install attempt resolves so the prototype can show both
   * the installed and error states. Blocked components never install.
   */
  installOutcome: InstallOutcome;
};

// The target harness is always the one the source was not authored for.
export const targetHarnessFor = (source: SourceComponent): Harness =>
  source.sourceHarness === Harness.Claude ? Harness.Codex : Harness.Claude;

const countBySupport = (
  component: SourceComponent,
  support: FieldSupport
): number => component.mappings.filter((m) => m.support === support).length;

export const supportedCount = (component: SourceComponent): number =>
  countBySupport(component, FieldSupport.Supported);

export const partialCount = (component: SourceComponent): number =>
  countBySupport(component, FieldSupport.Partial);

export const unsupportedCount = (component: SourceComponent): number =>
  countBySupport(component, FieldSupport.Unsupported);

// Components that will actually land on the target: everything except the
// fully-unsupported (dropped) fields.
export const carriedFieldCount = (component: SourceComponent): number =>
  supportedCount(component) + partialCount(component);

// The number of required capabilities that are the actual reason install is
// blocked. A dropped field that only depends on another blocker (Tool matcher →
// PreToolUse) is not counted, so the blocked banner never overstates what the
// target lacks.
export const blockingCapabilityCount = (component: SourceComponent): number =>
  component.mappings.filter((m) => m.blocksInstall === true).length;

// ---------------------------------------------------------------------------
// Discoverable components - one per flow state.
// ---------------------------------------------------------------------------

// Clean convert: a Codex command that maps 1:1 onto Claude.
const cleanCommand: SourceComponent = {
  id: "changelog-command",
  name: "changelog",
  kind: ComponentKind.Command,
  description:
    "Generates a release changelog from merged PRs since the last tag.",
  sourceHarness: Harness.Codex,
  publisher: "closedloop/community",
  convertibility: Convertibility.Clean,
  mappings: [
    {
      sourceField: "Prompt template",
      targetField: "Prompt template",
      support: FieldSupport.Supported,
    },
    {
      sourceField: "Command name",
      targetField: "Slash command",
      support: FieldSupport.Supported,
    },
    {
      sourceField: "Argument hints",
      targetField: "Argument hints",
      support: FieldSupport.Supported,
    },
    {
      sourceField: "Description",
      targetField: "Description",
      support: FieldSupport.Supported,
    },
  ],
  installOutcome: InstallOutcome.Success,
};

// Partial convert: a Claude agent that mostly maps but drops one field and
// approximates another onto Codex.
const partialAgent: SourceComponent = {
  id: "release-captain-agent",
  name: "release-captain",
  kind: ComponentKind.Agent,
  description:
    "Cuts a release: bumps versions, drafts notes, and opens the tag PR.",
  sourceHarness: Harness.Claude,
  publisher: "closedloop/platform",
  convertibility: Convertibility.Partial,
  mappings: [
    {
      sourceField: "System prompt",
      targetField: "Instructions",
      support: FieldSupport.Supported,
    },
    {
      sourceField: "Allowed tools",
      targetField: "Allowed tools",
      support: FieldSupport.Supported,
    },
    {
      sourceField: "Model preference",
      targetField: "Model preference",
      support: FieldSupport.Partial,
      note: "Codex has no exact match for the requested model; falls back to the nearest available tier.",
    },
    {
      sourceField: "Subagent delegation",
      targetField: null,
      support: FieldSupport.Unsupported,
      note: "Codex has no subagent concept. The delegation step is dropped; the agent runs single-threaded.",
    },
  ],
  installOutcome: InstallOutcome.Success,
};

// Partial convert that fails on write, to show the error state after a lossy
// preview: a Codex skill that mostly maps onto Claude but the install itself
// doesn't land.
const partialSkill: SourceComponent = {
  id: "test-scaffold-skill",
  name: "test-scaffold",
  kind: ComponentKind.Skill,
  description: "Scaffolds a Vitest suite for the file under the cursor.",
  sourceHarness: Harness.Codex,
  publisher: "closedloop/community",
  convertibility: Convertibility.Partial,
  mappings: [
    {
      sourceField: "Instructions",
      targetField: "Skill prompt",
      support: FieldSupport.Supported,
    },
    {
      sourceField: "Trigger phrase",
      targetField: "Skill name",
      support: FieldSupport.Partial,
      note: "Claude keys skills by name, not free-text trigger; the phrase becomes the skill name.",
    },
    {
      sourceField: "Auto-run on save",
      targetField: null,
      support: FieldSupport.Unsupported,
      note: "Claude skills are invoked on demand, not by file-save events. The auto-run trigger is dropped.",
    },
  ],
  installOutcome: InstallOutcome.Error,
};

// Blocked: a Claude hook that depends on a capability Codex does not have at
// all, so install is not offered.
const blockedHook: SourceComponent = {
  id: "pre-commit-guard-hook",
  name: "pre-commit-guard",
  kind: ComponentKind.Hook,
  description:
    "Runs a lint-and-typecheck gate on every PreToolUse before a file write.",
  sourceHarness: Harness.Claude,
  publisher: "closedloop/platform",
  convertibility: Convertibility.Blocked,
  mappings: [
    {
      sourceField: "Hook script",
      targetField: "Hook script",
      support: FieldSupport.Supported,
    },
    {
      sourceField: "PreToolUse trigger",
      targetField: null,
      support: FieldSupport.Unsupported,
      note: "Codex exposes no tool-lifecycle hook point. Without a trigger the hook can never fire, so it cannot be installed.",
      blocksInstall: true,
    },
    {
      sourceField: "Tool matcher",
      targetField: null,
      support: FieldSupport.Unsupported,
      note: "Depends on the PreToolUse trigger above.",
    },
  ],
  installOutcome: InstallOutcome.Success,
};

export const sourceComponents: readonly SourceComponent[] = [
  cleanCommand,
  partialAgent,
  partialSkill,
  blockedHook,
];
