// Presentational states for the desktop startup-readiness prototype. The
// fixture separates durable, queryable data from freshness work so the UI can
// be useful before a long history scan finishes.

export const StartupStage = {
  OpeningStore: "opening-store",
  LoadingSaved: "loading-saved",
  CheckingHistory: "checking-history",
  ProcessingHistory: "processing-history",
  PreparingViews: "preparing-views",
  SyncingCloud: "syncing-cloud",
  NeedsAttention: "needs-attention",
  Ready: "ready",
  // The resting state a user sits in nearly all the time: the panel is gone.
  // The shipped phase set has this and unmounts the panel, so the prototype
  // needs it too or the reference never shows the app without the strip.
  Hidden: "hidden",
} as const;

export type StartupStage = (typeof StartupStage)[keyof typeof StartupStage];

export const StepState = {
  Complete: "complete",
  Active: "active",
  Pending: "pending",
  Error: "error",
} as const;

export type StepState = (typeof StepState)[keyof typeof StepState];

export type ReadinessStep = {
  id: string;
  label: string;
  description: string;
  state: StepState;
  percentage?: number;
};

export type StartupFixture = {
  stage: StartupStage;
  switcherLabel: string;
  headline: string;
  detail: string;
  savedSessionCount?: number;
  sourceFileProgress?: { processed: number; total: number };
  warning?: string;
  /**
   * The user paused history processing. The bar freezes and the copy changes,
   * so the frozen treatment can be reviewed next to the sweeping one.
   */
  paused?: boolean;
  /** Historical sessions still waiting for cloud sync, for the cloud detail row. */
  cloudPendingCount?: number;
  steps: readonly ReadinessStep[];
};

export type SessionRow = {
  id: string;
  name: string;
  harness: string;
  repository: string;
  status: string;
  lastActivity: string;
};

const readinessSteps = [
  {
    id: "saved",
    label: "Saved sessions",
    description: "Open the local store and make existing sessions available.",
  },
  {
    id: "history",
    label: "Local history",
    description: "Check supported agent tools for new or changed sessions.",
  },
  {
    id: "views",
    label: "Session views",
    description: "Refresh timelines, links, and summaries from verified data.",
  },
] as const;

/**
 * Which checklist step each stage is working on, stated explicitly rather than
 * derived from the stage's position in an ordered list. The arithmetic version
 * (`stageIndex - 1` over a 7-entry order) lit the wrong step for most working
 * stages: Processing, Preparing and Syncing all landed on "Session views", so
 * the panel put a green check on "Local history" while the detail line right
 * under it said it was reading Claude Code history. Three elements, two stories.
 *
 * This mirrors the shipped `getActiveStepIndex`, where Checking, Processing and
 * NeedsAttention all resolve to 1, so the reference and the build tell the same
 * story. Exhaustive by stage so a new stage cannot silently inherit one.
 */
const activeStepIndexByStage: Record<StartupStage, number> = {
  [StartupStage.OpeningStore]: 0,
  [StartupStage.LoadingSaved]: 0,
  [StartupStage.CheckingHistory]: 1,
  [StartupStage.ProcessingHistory]: 1,
  [StartupStage.NeedsAttention]: 1,
  [StartupStage.PreparingViews]: 2,
  [StartupStage.SyncingCloud]: 2,
  [StartupStage.Ready]: 2,
  // The panel is unmounted here; the value is never rendered but must be honest
  // rather than borrowed from another stage.
  [StartupStage.Hidden]: 2,
};

function buildSteps(stage: StartupStage): readonly ReadinessStep[] {
  const activeStepIndex = activeStepIndexByStage[stage];

  return readinessSteps.map((step, index) => {
    let state: StepState = StepState.Pending;
    if (stage === StartupStage.Ready || index < activeStepIndex) {
      state = StepState.Complete;
    } else if (index === activeStepIndex) {
      state =
        stage === StartupStage.NeedsAttention
          ? StepState.Error
          : StepState.Active;
    }
    return { ...step, state };
  });
}

function createFixture(fixture: Omit<StartupFixture, "steps">): StartupFixture {
  return { ...fixture, steps: buildSteps(fixture.stage) };
}

export const startupFixtures: readonly StartupFixture[] = [
  createFixture({
    stage: StartupStage.OpeningStore,
    switcherLabel: "Opening",
    headline: "Opening your session library",
    detail: "Starting the private on-device store.",
  }),
  createFixture({
    stage: StartupStage.LoadingSaved,
    switcherLabel: "Saved data",
    headline: "Loading saved sessions",
    detail: "Your most recent sessions will appear first.",
  }),
  createFixture({
    stage: StartupStage.CheckingHistory,
    switcherLabel: "Checking",
    headline: "3,086 saved sessions are ready",
    detail: "Checking local agent history for anything new.",
    savedSessionCount: 3086,
  }),
  createFixture({
    stage: StartupStage.ProcessingHistory,
    switcherLabel: "Processing",
    headline: "Your saved sessions are ready",
    detail: "Reading newly discovered Claude Code history in the background.",
    savedSessionCount: 3086,
    sourceFileProgress: { processed: 13, total: 14 },
  }),
  createFixture({
    stage: StartupStage.PreparingViews,
    switcherLabel: "Preparing",
    headline: "3,090 sessions are ready",
    detail: "Refreshing timelines and links for the latest sessions.",
    savedSessionCount: 3090,
  }),
  createFixture({
    stage: StartupStage.SyncingCloud,
    switcherLabel: "Syncing",
    headline: "3,090 saved sessions ready on this Mac",
    // Design review: lead with the reassurance, and let the countdown live on
    // the labelled cloud row in the details rather than after a semicolon here.
    detail: "Local sessions stay usable while cloud history catches up.",
    savedSessionCount: 3090,
    cloudPendingCount: 750,
  }),
  createFixture({
    stage: StartupStage.NeedsAttention,
    switcherLabel: "Attention",
    headline: "3,086 saved sessions are still available",
    detail: "One history location needs access before it can be checked.",
    savedSessionCount: 3086,
    warning:
      "Claude Code history could not be read. Existing sessions are unchanged.",
  }),
  createFixture({
    stage: StartupStage.ProcessingHistory,
    switcherLabel: "Paused",
    headline: "Your saved sessions are ready",
    detail:
      "History processing is paused. Your saved sessions remain available.",
    savedSessionCount: 3086,
    sourceFileProgress: { processed: 4000, total: 10_000 },
    paused: true,
  }),
  createFixture({
    stage: StartupStage.Ready,
    switcherLabel: "Ready",
    headline: "3,090 sessions ready",
    detail: "Local history checked just now.",
    savedSessionCount: 3090,
  }),
  createFixture({
    stage: StartupStage.Hidden,
    switcherLabel: "Resting",
    headline: "",
    detail: "",
    savedSessionCount: 3090,
  }),
];

export const sessionRows: readonly SessionRow[] = [
  {
    id: "session-1",
    name: "Desktop sync integrity repair",
    harness: "Claude Code",
    repository: "closedloop-ai/symphony-alpha",
    status: "Active",
    lastActivity: "just now",
  },
  {
    id: "session-2",
    name: "Startup readiness experience",
    harness: "Codex",
    repository: "closedloop-ai/symphony-alpha",
    status: "Completed",
    lastActivity: "8m ago",
  },
  {
    id: "session-3",
    name: "Agent session chunk validation",
    harness: "Claude Code",
    repository: "closedloop-ai/symphony-alpha",
    status: "Completed",
    lastActivity: "24m ago",
  },
  {
    id: "session-4",
    name: "Relay retry diagnostics",
    harness: "OpenCode",
    repository: "closedloop-ai/closedloop-electron",
    status: "Completed",
    lastActivity: "1h ago",
  },
  {
    id: "session-5",
    name: "Session reconciliation audit",
    harness: "Codex",
    repository: "closedloop-ai/symphony-alpha",
    status: "Completed",
    lastActivity: "2h ago",
  },
];
