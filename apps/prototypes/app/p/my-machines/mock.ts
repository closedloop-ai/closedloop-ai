// Mock data for the member "my machines" install summary (FEA-4076).
// Presentational only, no DB, no API, no auth. This is the member-scoped mirror
// of the admin install matrix (FEA-4074): the admin view is component-first
// (one component × every org target), this view is MACHINE-first (my machines ×
// what a pack installed on each). All consts are declared before the builder
// functions that read them, so there is no temporal-dead-zone hazard during
// module evaluation.

// The kind of component a pack can install. Labels each component row in the
// per-machine detail. Mirrors the admin matrix's ComponentKind.
export const ComponentKind = {
  Agent: "agent",
  Skill: "skill",
  Command: "command",
  Hook: "hook",
  Mcp: "mcp",
} as const;

export type ComponentKind = (typeof ComponentKind)[keyof typeof ComponentKind];

// Singular / plural labels for a kind. The per-component detail row labels one
// component with the singular form; the plural is kept for completeness of the
// map.
export const COMPONENT_KIND_LABEL: Record<
  ComponentKind,
  { one: string; many: string }
> = {
  [ComponentKind.Agent]: { one: "agent", many: "agents" },
  [ComponentKind.Skill]: { one: "skill", many: "skills" },
  [ComponentKind.Command]: { one: "command", many: "commands" },
  [ComponentKind.Hook]: { one: "hook", many: "hooks" },
  [ComponentKind.Mcp]: { one: "MCP tool", many: "MCP tools" },
};

// The harness a component landed in on this machine. Shown in per-component
// detail so the member knows WHERE it installed, not just that it did.
export const Harness = {
  Claude: "claude",
  Codex: "codex",
  OpenCode: "opencode",
} as const;

export type Harness = (typeof Harness)[keyof typeof Harness];

export const HARNESS_LABEL: Record<Harness, string> = {
  [Harness.Claude]: "Claude",
  [Harness.Codex]: "Codex",
  [Harness.OpenCode]: "OpenCode",
};

// Per-component install state on one machine. Exactly one renders per component
// row (say-it-once). An offline machine keeps its LAST-KNOWN state — the detail
// says "here is what we last knew, as of <lastSeen>" rather than throwing that
// away and stamping every row "unknown". The staleness lives on the machine
// (`online: false` + `lastSeen`), not on a per-component state, so the disclosure
// stays more informative than the summary line, not less.
export const InstallState = {
  Installed: "installed",
  Updatable: "updatable",
  NotInstalled: "not-installed",
} as const;

export type InstallState = (typeof InstallState)[keyof typeof InstallState];

// A component this pack can install, and its state on one machine. `version` is
// the version currently installed on THIS machine (behind DEMO_PACK.version when
// the state is Updatable), so an update row can say from-what-to-what.
export type MachineComponent = {
  id: string;
  name: string;
  kind: ComponentKind;
  harness: Harness;
  version: string;
  state: InstallState;
};

// A machine a member has registered. The primary object of this view: the
// member scans their own machines, not the org matrix.
export type Machine = {
  id: string;
  name: string;
  platform: string;
  online: boolean;
  // When the gateway last read install state off this box. Shown on an offline
  // machine so the summary is "here is what we last knew", not a blank.
  lastSeen: string;
  components: readonly MachineComponent[];
};

// The pack whose install summary we're viewing, on the member's own machines.
// The component count is derived from PACK_COMPONENTS.length at read time, not
// stored, so the two can never drift.
export type Pack = {
  name: string;
  version: string;
  description: string;
};

export const DEMO_PACK: Pack = {
  name: "Platform Core",
  version: "2.4.0",
  description:
    "The baseline agents, skills, and guard hooks every repo runs. Install it on each machine you work from.",
};

// The five components the pack ships, reused per machine with a per-machine
// state. Declared once so a machine's component list stays readable and the
// by-kind breakdown lines up across machines.
const PACK_COMPONENTS: readonly Omit<MachineComponent, "state">[] = [
  {
    id: "cmp-reviewer",
    name: "code-reviewer",
    kind: ComponentKind.Agent,
    harness: Harness.Claude,
    version: "2.4.0",
  },
  {
    id: "cmp-scaffold",
    name: "scaffold-feature",
    kind: ComponentKind.Skill,
    harness: Harness.Claude,
    version: "2.4.0",
  },
  {
    id: "cmp-ship",
    name: "ship-it",
    kind: ComponentKind.Command,
    harness: Harness.Codex,
    version: "2.4.0",
  },
  {
    id: "cmp-precommit",
    name: "pre-commit-guard",
    kind: ComponentKind.Hook,
    harness: Harness.Claude,
    version: "2.4.0",
  },
  {
    id: "cmp-linear",
    name: "linear-sync",
    kind: ComponentKind.Mcp,
    harness: Harness.OpenCode,
    version: "2.4.0",
  },
];

// One component's per-machine spec: its install state, plus an optional installed
// version override (an Updatable component sits behind DEMO_PACK.version, so the
// row can show from-what-to-what).
type ComponentSpec = {
  state: InstallState;
  version?: string;
};

// Build one machine's component list from a per-component spec map. A component
// absent from the map defaults to not-installed at the pack's version. Offline
// machines keep their last-known spec here; the machine's `online: false` +
// `lastSeen` carry the staleness, so the detail shows "what we last knew" rather
// than a wall of unknowns.
const buildComponents = (
  specs: Partial<Record<string, ComponentSpec>>
): readonly MachineComponent[] =>
  PACK_COMPONENTS.map((component) => {
    const spec = specs[component.id];
    return {
      ...component,
      version: spec?.version ?? component.version,
      state: spec?.state ?? InstallState.NotInstalled,
    };
  });

// The member's registered machines. Ordered so the list does NOT open all-green:
// an online machine that's fully installed, an online machine that's partial
// (some not-installed, one stale), and an offline machine we can't read. The
// offline box is last but never hidden.
export const DEMO_MACHINES: readonly Machine[] = [
  {
    id: "mac-parkers-mbp",
    name: "parkers-mbp",
    platform: "macOS 15.1 · arm64",
    online: true,
    lastSeen: "just now",
    components: buildComponents({
      "cmp-reviewer": { state: InstallState.Installed },
      "cmp-scaffold": { state: InstallState.Installed },
      "cmp-ship": { state: InstallState.Installed },
      "cmp-precommit": { state: InstallState.Installed },
      "cmp-linear": { state: InstallState.Installed },
    }),
  },
  {
    id: "mac-linux-dev",
    name: "linux-dev-02",
    platform: "Ubuntu 22.04 · x86_64",
    online: true,
    lastSeen: "just now",
    components: buildComponents({
      "cmp-reviewer": { state: InstallState.Installed },
      "cmp-scaffold": { state: InstallState.Updatable, version: "2.3.1" },
      "cmp-ship": { state: InstallState.NotInstalled },
      "cmp-precommit": { state: InstallState.Installed },
      "cmp-linear": { state: InstallState.NotInstalled },
    }),
  },
  {
    id: "mac-old-mini",
    name: "office-mac-mini",
    platform: "macOS 13.6 · arm64",
    online: false,
    lastSeen: "3 days ago",
    // Offline, but we keep the last-known state so the detail can show what we
    // last read rather than a wall of unknowns.
    components: buildComponents({
      "cmp-reviewer": { state: InstallState.Installed },
      "cmp-scaffold": { state: InstallState.Installed },
      "cmp-ship": { state: InstallState.NotInstalled },
      "cmp-precommit": { state: InstallState.Updatable, version: "2.2.0" },
      "cmp-linear": { state: InstallState.NotInstalled },
    }),
  },
];

// A component "has an installation" when it's present, current or behind. An
// available update is installed-but-stale, so it counts as installed for the
// ratio; it's also actionable, so it counts there too. An offline machine's
// state is unknown, so it counts as neither installed nor known-missing.
export const isInstalledState = (state: InstallState): boolean =>
  state === InstallState.Installed || state === InstallState.Updatable;

// A component needs a member action when it can hold an install but isn't
// current: not-installed or an available update.
export const needsActionState = (state: InstallState): boolean =>
  state === InstallState.NotInstalled || state === InstallState.Updatable;

// Per-machine rollup: how many of the pack's components are installed, how many
// need action, and whether the numbers are live. `readable` is false for an
// offline machine — the counts are then LAST-KNOWN, not current, and the UI
// frames them "as of <lastSeen>" rather than as a live reading.
export type MachineRollup = {
  installed: number;
  needsAction: number;
  total: number;
  readable: boolean;
};

export const rollupFor = (machine: Machine): MachineRollup => {
  const total = machine.components.length;
  let installed = 0;
  let needsAction = 0;
  for (const component of machine.components) {
    if (isInstalledState(component.state)) {
      installed += 1;
    }
    if (needsActionState(component.state)) {
      needsAction += 1;
    }
  }
  return { installed, needsAction, total, readable: machine.online };
};

// The ratio "installed on N of your M machines" for the pack header. A machine
// counts toward the numerator when at least one component is installed on it
// (live reading OR last-known while offline); the denominator is every
// registered machine, because the offline box is still one of the member's
// machines. The name says "machines with an install", not "fully installed" —
// a partially-installed machine still counts here.
export const machinesWithInstallCount = (
  machines: readonly Machine[]
): { installed: number; total: number } => {
  let installed = 0;
  for (const machine of machines) {
    const rollup = rollupFor(machine);
    if (rollup.installed > 0) {
      installed += 1;
    }
  }
  return { installed, total: machines.length };
};
