import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";

export const workspaceName = "Acme Engineering";

// The signed-in user. When cloud sync is Off, the Sessions page shows only this
// person's local sessions — no teammates' cloud sessions — so the destination
// doesn't contradict the "nothing leaves this device" choice.
export const currentUserName = "Kaiti Carpenter";

// How the user authenticated in the web auth flow. Resolved at the very start
// of the post-auth flow (ISS-5249 revision): the choice determines whether the
// GitHub-dependent surfaces on the Sessions page render populated or as the
// "Connect GitHub" empty state, so the page can be drawn correctly the moment
// the user lands back on it.
export const AuthMethod = {
  GitHub: "github",
  Email: "email",
} as const;
export type AuthMethod = (typeof AuthMethod)[keyof typeof AuthMethod];

// ---------------------------------------------------------------------------
// Data & Sync levels — a faithful local copy of the desktop Settings → Data &
// Sync control. Titles, descriptions, per-line egress, and caveats are copied
// VERBATIM from the SSOT (packages/app/shared/lib/data-sync-copy.ts) so the
// consent copy can't drift — on a consent screen the copy is the product.
//
// The "Redacted sessions" level is intentionally omitted: its redaction lane is
// not plumbed yet (in production it behaves exactly like Metadata), so offering
// it would misstate what leaves the device. Only Off / Metadata / Full are
// selectable here.
// ---------------------------------------------------------------------------
export const DataSyncLevel = {
  Off: "off",
  Metadata: "metadata",
  Full: "full",
} as const;
export type DataSyncLevel = (typeof DataSyncLevel)[keyof typeof DataSyncLevel];

// The level the onboarding takeover lands on pre-selected.
//
// PRODUCT DECISION (ISS-5249): the post-auth takeover deliberately DEFAULTS to
// Full transcripts, because full transcript sync is how a team gets the most
// value out of the product (richest insights, replays, and team comparisons).
// This is an explicit product call and is intentionally different from Settings,
// which defaults to Metadata.
//
// Consent tradeoff, surfaced in the UI rather than buried: the pre-selected
// level uploads complete transcript bodies (prompt + file contents), so the
// Full option carries the caveat that spells this out, and nothing syncs until
// the user makes an explicit Save. The accompanying
// chip reads "Default" — the pre-selected default, i.e. where the selection
// starts — NOT "Recommended"; it is not a safety judgment about the level.
export const DEFAULT_SYNC_TAKEOVER_LEVEL: DataSyncLevel = DataSyncLevel.Full;

export type DataLine = {
  label: string;
  kind: "sync" | "local";
};

export type DataSyncLevelOption = {
  level: DataSyncLevel;
  title: string;
  description: string;
  // Short label for the current-level summary badge.
  badgeLabel: string;
  // What leaves the device vs. what stays local, described inline so the choice
  // is informed.
  dataLines: readonly DataLine[];
  caveat?: string;
};

export const dataSyncLevelOptions: readonly DataSyncLevelOption[] = [
  {
    level: DataSyncLevel.Off,
    title: "Off",
    description: "Nothing leaves this device.",
    badgeLabel: "Off",
    dataLines: [
      { label: "Session shape, timing & cost", kind: "local" },
      { label: "Tool-call activity (names & counts)", kind: "local" },
      { label: "Tool inputs & file contents", kind: "local" },
      { label: "Prompts & completions", kind: "local" },
    ],
    caveat:
      "You won't be able to sync across machines or compare with your team.",
  },
  {
    level: DataSyncLevel.Metadata,
    title: "Metadata only",
    description: "Cloud insights without your prompts or files.",
    badgeLabel: "Metadata only",
    dataLines: [
      { label: "Session shape, timing & cost", kind: "sync" },
      { label: "Tool-call activity (names & counts)", kind: "sync" },
      { label: "Tool inputs & file contents", kind: "local" },
      { label: "Prompts & completions", kind: "local" },
    ],
  },
  {
    level: DataSyncLevel.Full,
    title: "Full transcripts",
    description: "The richest insights, replays, and team comparisons.",
    badgeLabel: "Full transcripts",
    dataLines: [
      { label: "Session shape, timing & cost", kind: "sync" },
      { label: "Tool-call activity (names & counts)", kind: "sync" },
      { label: "Tool inputs & file contents", kind: "sync" },
      { label: "Prompts & completions", kind: "sync" },
    ],
    caveat:
      "Complete transcript bodies leave this device, including prompt and file contents.",
  },
];

// ---------------------------------------------------------------------------
// Sessions page — now that the user is authenticated they see all of their
// team's sessions plus the agentic components each teammate is using.
// ---------------------------------------------------------------------------
export type TeamSession = {
  id: string;
  title: string;
  author: string;
  component: string;
  cost: string;
  efficiency: string;
  // How long ago the session ran, so the date-range control has real rows to
  // include or exclude rather than only relabeling the toolbar.
  daysAgo: number;
};

export const teamSessions: readonly TeamSession[] = [
  {
    id: "s-1",
    title: "Refactor billing webhook retries",
    author: "Kaiti Carpenter",
    component: "Claude Code",
    cost: "$4.12",
    efficiency: "High",
    daysAgo: 2,
  },
  {
    id: "s-2",
    title: "Add pagination to activity feed",
    author: "Marcus Lee",
    component: "Codex",
    cost: "$2.87",
    efficiency: "High",
    daysAgo: 9,
  },
  {
    id: "s-3",
    title: "Migrate auth middleware to Fluid",
    author: "Priya Shah",
    component: "Cursor",
    cost: "$6.40",
    efficiency: "Medium",
    daysAgo: 20,
  },
  {
    id: "s-4",
    title: "Fix flaky sync integration test",
    author: "Dan Rivera",
    component: "Claude Code",
    cost: "$1.95",
    efficiency: "High",
    daysAgo: 45,
  },
  {
    id: "s-5",
    title: "Draft schema for team invites",
    author: "Priya Shah",
    component: "Codex",
    cost: "$3.28",
    efficiency: "Medium",
    daysAgo: 120,
  },
];

// Session date-range window, mirroring the shared Sessions/Branches range set
// (packages/app/shared/lib/format-utils.ts). An ordered array drives the
// segmented control's render order, exactly as the production source does.
export const DATE_RANGES = ["7d", "30d", "90d", "all"] as const;
export type DateRange = (typeof DATE_RANGES)[number];

export const DATE_RANGE_LABELS: Record<DateRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

export const DATE_RANGE_SHORT_LABELS: Record<DateRange, string> = {
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  all: "All",
};

export const DEFAULT_DATE_RANGE: DateRange = "90d";

// Lookback horizon in days per range; "all" has no upper bound.
export const DATE_RANGE_LOOKBACK_DAYS: Record<DateRange, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: Number.POSITIVE_INFINITY,
};

// GitHub-dependent metrics. Populated only when the user signed in with GitHub;
// otherwise the tiles render the "Connect GitHub" empty state.
export type GithubMetric = {
  key: string;
  label: string;
  value: string;
  delta: number;
  deltaPolarity: MetricPolarity;
};

// GitHub metrics windowed by the same date range that filters the sessions
// table, so the tiles and the rows below them always describe the same window
// (a shorter range shows fewer merged PRs) rather than the eye reading two.
// Cost / merged PR and median PR size are ratios/medians, so they vary only
// modestly across windows; merged-PR volume scales with the range.
export const githubMetricsByRange: Record<DateRange, readonly GithubMetric[]> =
  {
    "7d": [
      {
        key: "merged-prs",
        label: "Merged PRs",
        value: "18",
        delta: 12,
        deltaPolarity: MetricPolarity.HigherIsBetter,
      },
      {
        key: "cost-per-pr",
        label: "Cost / merged PR",
        value: "$164",
        delta: -8,
        deltaPolarity: MetricPolarity.LowerIsBetter,
      },
      {
        key: "median-pr-size",
        label: "Median PR size",
        value: "182 lines",
        delta: -6,
        deltaPolarity: MetricPolarity.Neutral,
      },
    ],
    "30d": [
      {
        key: "merged-prs",
        label: "Merged PRs",
        value: "74",
        delta: 15,
        deltaPolarity: MetricPolarity.HigherIsBetter,
      },
      {
        key: "cost-per-pr",
        label: "Cost / merged PR",
        value: "$169",
        delta: -7,
        deltaPolarity: MetricPolarity.LowerIsBetter,
      },
      {
        key: "median-pr-size",
        label: "Median PR size",
        value: "201 lines",
        delta: -5,
        deltaPolarity: MetricPolarity.Neutral,
      },
    ],
    "90d": [
      {
        key: "merged-prs",
        label: "Merged PRs",
        value: "212",
        delta: 19,
        deltaPolarity: MetricPolarity.HigherIsBetter,
      },
      {
        key: "cost-per-pr",
        label: "Cost / merged PR",
        value: "$171",
        delta: -6,
        deltaPolarity: MetricPolarity.LowerIsBetter,
      },
      {
        key: "median-pr-size",
        label: "Median PR size",
        value: "214 lines",
        delta: -4,
        deltaPolarity: MetricPolarity.Neutral,
      },
    ],
    all: [
      {
        key: "merged-prs",
        label: "Merged PRs",
        value: "538",
        delta: 9,
        deltaPolarity: MetricPolarity.HigherIsBetter,
      },
      {
        key: "cost-per-pr",
        label: "Cost / merged PR",
        value: "$167",
        delta: -5,
        deltaPolarity: MetricPolarity.LowerIsBetter,
      },
      {
        key: "median-pr-size",
        label: "Median PR size",
        value: "220 lines",
        delta: -3,
        deltaPolarity: MetricPolarity.Neutral,
      },
    ],
  };
