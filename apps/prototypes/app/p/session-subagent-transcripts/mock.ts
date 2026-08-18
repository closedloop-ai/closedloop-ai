/**
 * Mock cohorts for the session subagent-transcript disclosure prototype
 * (ISS-4677). Presentational only, these mirror the SHAPE of the production
 * `TranscriptAvailabilitySummary[]` on `AgentSessionDetail.transcripts` plus the
 * session's `agentCount`, because the whole point of the surface is that those
 * two numbers must reconcile.
 */

export const MockAvailability = {
  Available: "available",
  Stale: "stale",
  UploadPending: "uploadPending",
  UploadFailed: "uploadFailed",
  PermanentlyUnavailable: "permanentlyUnavailable",
  Missing: "missing",
} as const;

export type MockAvailability =
  (typeof MockAvailability)[keyof typeof MockAvailability];

export type MockTranscriptFile = {
  fileKey: string;
  availability: MockAvailability;
  /**
   * The subagent's type/name, when the session's agent rows carry one. Nine
   * numbered pills give the reader nothing to choose between; the type is what
   * tells them which sidechain they are jumping into. Absent = no agent row
   * matched, so the chip falls back to its raw key.
   */
  label?: string;
};

export type MockCohort = {
  id: string;
  /** Reviewer-facing name for the sandbox switcher. */
  label: string;
  /** What this cohort is here to prove. */
  note: string;
  /**
   * `undefined` = the producer never reported per-file availability. NOT the
   * same as an empty array, which reports "there are none".
   */
  files: MockTranscriptFile[] | undefined;
  /** Agent rows the session reports, INCLUDING the main agent. 0 = not loaded. */
  agentCount: number;
  /** Which file the reader deep-linked to. */
  activeFileKey: string;
};

/**
 * Subagent types a real Closedloop session actually runs, cycled so every chip
 * carries a name the reader can choose on.
 */
const SUBAGENT_TYPES = [
  "code-reviewer",
  "test-engineer",
  "explorer",
  "design-critic",
  "database-architect",
  "api-architect",
  "security-privacy",
  "devops-architect",
  "typescript-expert",
  "ux-writer",
] as const;

function subagentFiles(
  count: number,
  availability: MockAvailability = MockAvailability.Available
): MockTranscriptFile[] {
  return Array.from({ length: count }, (_unused, index) => ({
    fileKey: `subagent:agent-${index + 1}`,
    availability,
    label: SUBAGENT_TYPES[index % SUBAGENT_TYPES.length],
  }));
}

const MAIN_FILE: MockTranscriptFile = {
  fileKey: "main",
  availability: MockAvailability.Available,
};

export const COHORTS: readonly MockCohort[] = [
  {
    id: "wall",
    label: "Chip wall (9 subagents)",
    note: "The case that motivated the change: nine sidechain chips wrapped over three rows above the trace. Collapsed by default; Main stays inline so the reader can always get back. Every chip carries its subagent type, so the drawer is a list to pick from rather than one to scroll past.",
    files: [MAIN_FILE, ...subagentFiles(9)],
    agentCount: 10,
    activeFileKey: "main",
  },
  {
    id: "shortfall",
    label: "Count shortfall (9 files, 12 subagents)",
    note: "The reconciliation case. Twelve subagents ran; only nine left a readable transcript. A bare '(9)' beside the word 'subagent' would contradict the Subagents metric, so the header names each population once.",
    files: [MAIN_FILE, ...subagentFiles(9)],
    agentCount: 13,
    activeFileKey: "main",
  },
  {
    id: "surplus",
    label: "Count surplus (9 files, 3 subagents)",
    note: "The same contradiction from the other side: the file lane and the agent-row lane drift independently, so files can OUTNUMBER the reported subagents. The bare count is dropped here too — the header states both numbers rather than a confident '(9)' next to a Subagents metric of 3.",
    files: [MAIN_FILE, ...subagentFiles(9)],
    agentCount: 4,
    activeFileKey: "main",
  },
  {
    id: "unreadable",
    label: "Every unreadable state",
    note: "One sidechain is still uploading, one upload failed, one row is missing and one was skipped as too large. The uploading chip stays calm and openable — its bytes are on the way — while the three that are never coming are warning-toned, marked in visible text, and not links at all.",
    files: [
      MAIN_FILE,
      ...subagentFiles(3),
      {
        fileKey: "subagent:agent-5",
        availability: MockAvailability.UploadPending,
        label: "explorer",
      },
      {
        fileKey: "subagent:agent-6",
        availability: MockAvailability.UploadFailed,
        label: "test-engineer",
      },
      {
        fileKey: "subagent:agent-7",
        availability: MockAvailability.Missing,
        label: "api-architect",
      },
      {
        fileKey: "subagent:agent-8",
        availability: MockAvailability.PermanentlyUnavailable,
        label: "design-critic",
      },
    ],
    agentCount: 8,
    activeFileKey: "main",
  },
  {
    id: "deep-linked",
    label: "Arriving deep-linked, shut",
    note: "Arriving at ?file=subagent:agent-4 with the disclosure shut. The active file is pinned inline beside Main — collapsed must never hide where you actually are — and it STAYS pinned when you open the drawer, so the row above does not shift under you mid-interaction.",
    files: [MAIN_FILE, ...subagentFiles(9)],
    agentCount: 10,
    activeFileKey: "subagent:agent-4",
  },
  {
    id: "swarm",
    label: "Swarm (40 sidechains)",
    note: "The scale question: an unbounded wrapped grid would move the chip wall one click deeper rather than solve it. Past roughly four rows the drawer scrolls in place, so opening it costs the trace a fixed amount of room however many subagents ran.",
    files: [MAIN_FILE, ...subagentFiles(40)],
    agentCount: 41,
    activeFileKey: "main",
  },
  {
    id: "single",
    label: "One sidechain (no disclosure)",
    note: "One extra chip is not a wall. Folding it costs a click and buys nothing, so both chips stay inline, the disclosure only appears above the threshold — but the reconciliation caption still renders, because a mismatch below the fold threshold is exactly as misleading as one above it.",
    files: [MAIN_FILE, ...subagentFiles(1)],
    agentCount: 6,
    activeFileKey: "main",
  },
  {
    id: "true-zero",
    label: "True zero subagents",
    note: "Availability WAS reported and contains no sidechain, and the session reports one agent row. A knowable zero, but with nothing to switch to, the switcher renders nothing at all rather than an empty shell.",
    files: [MAIN_FILE],
    agentCount: 1,
    activeFileKey: "main",
  },
  {
    id: "unavailable",
    label: "Availability unavailable / loading",
    note: "The producer never reported per-file availability (older desktop build, or the detail is still loading). We know nothing, so we claim nothing, no chips, no '0'. This is the state the old code mislabelled as 'No subagent activity.'",
    files: undefined,
    agentCount: 0,
    activeFileKey: "main",
  },
];
