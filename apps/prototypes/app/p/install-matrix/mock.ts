// Mock data for the per-target × per-harness install matrix (FEA-4074).
// Presentational only, no DB, no API, no auth. All consts are declared before
// the builder functions that read them so there is no temporal-dead-zone hazard
// during module evaluation.

// The three harnesses a component can be installed into. Columns of the matrix.
export const Harness = {
  Claude: "claude",
  Codex: "codex",
  OpenCode: "opencode",
} as const;

export type Harness = (typeof Harness)[keyof typeof Harness];

export const HARNESS_ORDER: readonly Harness[] = [
  Harness.Claude,
  Harness.Codex,
  Harness.OpenCode,
];

export const HARNESS_LABEL: Record<Harness, string> = {
  [Harness.Claude]: "Claude",
  [Harness.Codex]: "Codex",
  [Harness.OpenCode]: "OpenCode",
};

// The kind of component being installed. Drives which harnesses can run it.
// E.g. Codex has no hook runtime, so a Hook is unsupported on the Codex column.
export const ComponentKind = {
  Agent: "agent",
  Skill: "skill",
  Command: "command",
  Hook: "hook",
  Mcp: "mcp",
} as const;

export type ComponentKind = (typeof ComponentKind)[keyof typeof ComponentKind];

export const COMPONENT_KIND_LABEL: Record<ComponentKind, string> = {
  [ComponentKind.Agent]: "Agent",
  [ComponentKind.Skill]: "Skill",
  [ComponentKind.Command]: "Command",
  [ComponentKind.Hook]: "Hook",
  [ComponentKind.Mcp]: "MCP tool",
};

// Which harnesses can run each component kind. Support is a property of the
// component KIND and the harness, independent of any target. A cell whose harness
// is not in this list renders as "unsupported": the harness has no runtime for
// that kind, so there is nothing to install. This mirrors the desktop scanner —
// Codex does load Skills (from ~/.codex/skills), so Skill is supported there; the
// only genuine gap in this set is Codex having no hook runtime.
export const KIND_SUPPORTED_HARNESSES: Record<
  ComponentKind,
  readonly Harness[]
> = {
  [ComponentKind.Agent]: [Harness.Claude, Harness.Codex, Harness.OpenCode],
  [ComponentKind.Skill]: [Harness.Claude, Harness.Codex, Harness.OpenCode],
  [ComponentKind.Command]: [Harness.Claude, Harness.Codex, Harness.OpenCode],
  // Codex has no hook runtime.
  [ComponentKind.Hook]: [Harness.Claude, Harness.OpenCode],
  [ComponentKind.Mcp]: [Harness.Claude, Harness.Codex, Harness.OpenCode],
};

// Which harnesses are actually present on a given target. Cell state is component
// support INTERSECTED WITH target availability: a harness the kind supports but
// that the target doesn't have installed can't hold an install, so its cell reads
// "unsupported" for that target rather than defaulting to "not installed" (which
// would invite an install that can't land). Absence of a harness on a target is a
// missing runtime, not a missing install.
export type TargetHarnesses = Partial<Record<Harness, boolean>>;

// Per-cell install state. Exactly one of these renders in each cell. `unsupported`
// is derived from the component kind, not stored per target; the others are the
// real state of that (target, harness) pair.
export const CellState = {
  Installed: "installed",
  NotInstalled: "not-installed",
  Updatable: "updatable",
  Converting: "converting",
  Unsupported: "unsupported",
  OfflineUnknown: "offline-unknown",
  // A per-target install/update that failed. Keeps the rest of the matrix usable
  // (unlike MatrixError, which is for a read failure that blanks the whole grid);
  // the cell offers a retry rather than pretending the component is absent.
  Failed: "failed",
} as const;

export type CellState = (typeof CellState)[keyof typeof CellState];

// The explicit intent of a cell action, decided at click time from the state the
// user saw. The handler applies THIS action rather than re-deriving one from
// whatever the cell's state happens to be when the update runs, so a double-click
// or a stale repeat cannot silently invert into the opposite operation.
export const CellAction = {
  Install: "install",
  Update: "update",
  Remove: "remove",
  Retry: "retry",
} as const;

export type CellAction = (typeof CellAction)[keyof typeof CellAction];

// A registered compute target (a machine/node the org can install onto). Rows.
export type Target = {
  id: string;
  name: string;
  platform: string;
  online: boolean;
  // Which harnesses this target has a runtime for. A harness absent here can't
  // hold an install regardless of component support, so its cell reads
  // "unsupported" rather than "not installed". Absent = harness not on the box.
  harnesses: TargetHarnesses;
  // Per-harness state for this target, keyed by harness. Only present for
  // harnesses the component kind supports AND the target has; other cells are
  // derived (unsupported / not-installed).
  cells: Partial<Record<Harness, CellState>>;
};

export type PackComponent = {
  id: string;
  name: string;
  kind: ComponentKind;
  pack: string;
  version: string;
  description: string;
};

// The component whose matrix we are viewing. A Hook, deliberately, so the Codex
// column shows the unsupported treatment against real installed/updatable cells.
export const DEMO_COMPONENT: PackComponent = {
  id: "cmp-pre-commit-guard",
  name: "pre-commit-guard",
  kind: ComponentKind.Hook,
  pack: "Platform Core",
  version: "2.4.0",
  description:
    "Blocks commits that touch generated files or skip the lint gate. Runs on the client before each commit.",
};

// All three harnesses present on the box. The common case; declared once so the
// per-target `harnesses` field stays readable.
const ALL_HARNESSES: TargetHarnesses = {
  [Harness.Claude]: true,
  [Harness.Codex]: true,
  [Harness.OpenCode]: true,
};

// The registered machines. Ordered so the DEFAULT landing state is a target with
// a problem, not an all-green mock: `mbp-ci-runner` is offline (state unknown),
// and `linux-build-02` has a failed/updatable mix. Say-it-once: each cell holds
// exactly one CellState.
export const DEMO_TARGETS: readonly Target[] = [
  {
    id: "tgt-ci-runner",
    name: "mbp-ci-runner",
    platform: "macOS 14.5 · arm64",
    online: false,
    harnesses: ALL_HARNESSES,
    cells: {
      [Harness.Claude]: CellState.OfflineUnknown,
      [Harness.OpenCode]: CellState.OfflineUnknown,
    },
  },
  {
    id: "tgt-linux-build-02",
    name: "linux-build-02",
    platform: "Ubuntu 22.04 · x86_64",
    online: true,
    // Codex isn't installed on this box, so the Codex cell reads unsupported for
    // this target even though a Hook is unsupported on Codex anyway.
    harnesses: { [Harness.Claude]: true, [Harness.OpenCode]: true },
    cells: {
      [Harness.Claude]: CellState.Updatable,
      [Harness.OpenCode]: CellState.Failed,
    },
  },
  {
    id: "tgt-parkers-mbp",
    name: "parkers-mbp",
    platform: "macOS 15.1 · arm64",
    online: true,
    harnesses: ALL_HARNESSES,
    cells: {
      [Harness.Claude]: CellState.Installed,
      [Harness.OpenCode]: CellState.Converting,
    },
  },
  {
    id: "tgt-win-desktop-01",
    name: "win-desktop-01",
    platform: "Windows 11 · x86_64",
    online: true,
    harnesses: ALL_HARNESSES,
    cells: {
      [Harness.Claude]: CellState.Installed,
      [Harness.OpenCode]: CellState.Installed,
    },
  },
];

// Which state a cell renders for a given target + harness on this component.
// Cell state is component support INTERSECTED WITH target availability:
//   1. the harness can't run this component kind at all -> Unsupported, or
//   2. the target doesn't have that harness installed        -> Unsupported.
// Only when the harness both supports the kind and exists on the target do we
// read the target's stored state, defaulting to not-installed.
export const cellStateFor = (
  component: PackComponent,
  target: Target,
  harness: Harness
): CellState => {
  const kindSupports =
    KIND_SUPPORTED_HARNESSES[component.kind].includes(harness);
  const targetHasHarness = target.harnesses[harness] === true;
  if (!(kindSupports && targetHasHarness)) {
    return CellState.Unsupported;
  }
  return target.cells[harness] ?? CellState.NotInstalled;
};

// A cell "has an installation" when the component is present, whether current or
// behind. Update-available means installed-but-stale, so it counts as installed
// for the rollup; it also needs action, so it is counted there too.
export const isInstalledState = (state: CellState): boolean =>
  state === CellState.Installed || state === CellState.Updatable;

// A cell needs a user action when it can hold an install but isn't current:
// not-installed, update-available, or a failed attempt to retry.
export const needsActionState = (state: CellState): boolean =>
  state === CellState.NotInstalled ||
  state === CellState.Updatable ||
  state === CellState.Failed;

// The action a cell affords right now, or null for a terminal / blocked state
// (offline, unsupported, converting). Decided at click time and passed to the
// handler so the applied operation matches what the user saw, not whatever the
// state has drifted to by the time the update runs.
export const actionForState = (state: CellState): CellAction | null => {
  if (state === CellState.NotInstalled) {
    return CellAction.Install;
  }
  if (state === CellState.Updatable) {
    return CellAction.Update;
  }
  if (state === CellState.Installed) {
    return CellAction.Remove;
  }
  if (state === CellState.Failed) {
    return CellAction.Retry;
  }
  return null;
};

// Apply an explicit action to a cell's current state (mocked, local only). The
// action is the intent captured at click time; if the current state no longer
// affords it (a stale double-click, or the cell already moved), the request is a
// no-op so a repeat can't invert into the opposite operation. The UI never lies:
// the glyph only moves when the requested action still fits the state.
export const applyCellAction = (
  state: CellState,
  action: CellAction
): CellState => {
  if (
    (action === CellAction.Install && state === CellState.NotInstalled) ||
    (action === CellAction.Update && state === CellState.Updatable) ||
    (action === CellAction.Retry && state === CellState.Failed)
  ) {
    return CellState.Installed;
  }
  if (action === CellAction.Remove && state === CellState.Installed) {
    return CellState.NotInstalled;
  }
  return state;
};

// Count of targets in each state for a harness column, used by the summary row.
export type HarnessRollup = {
  harness: Harness;
  supported: boolean;
  installed: number;
  needsAction: number;
  total: number;
};

export const rollupFor = (
  component: PackComponent,
  targets: readonly Target[],
  harness: Harness
): HarnessRollup => {
  const supported = KIND_SUPPORTED_HARNESSES[component.kind].includes(harness);
  let installed = 0;
  let needsAction = 0;
  for (const target of targets) {
    const state = cellStateFor(component, target, harness);
    if (isInstalledState(state)) {
      installed += 1;
    }
    if (needsActionState(state)) {
      needsAction += 1;
    }
  }
  return {
    harness,
    supported,
    installed,
    needsAction,
    total: targets.length,
  };
};
