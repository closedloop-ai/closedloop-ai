import {
  type GenericArtifactKind as ArtifactKindType,
  type GenericArtifactStatus as ArtifactStatusType,
  GenericArtifactKind,
  GenericArtifactStatus,
} from "../generic-artifact-status";
import { tracedSessionTotals } from "./fixtures/session/traced-session";
import { TRACED_SESSION } from "./fixtures/session/traced-session-identity";

export const ArtifactKind = GenericArtifactKind;
export const ArtifactStatus = GenericArtifactStatus;
export type ArtifactKind = ArtifactKindType;
export type ArtifactStatus = ArtifactStatusType;

export type GenericArtifact = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  /** Exact provider/runtime evidence when the fixture alias is insufficient. */
  statusRaw?: string;
  owner: string;
  ownerId?: string | null;
  ownerInitials: string;
  /** Anyone who has written to or commented on the artifact. */
  collaborators: readonly string[];
  repository: string | null;
  project: string | null;
  tags: readonly string[];
  tagIds?: readonly string[];
  commentCount?: number;
  currentVersion: string;
  updated: string;
  updatedAgoMinutes: number;
  createdAgoDays: number;
  aiSpend: number;
  timeToReadyMinutes: number;
  outcomeScore: number;
  activityCount: number;
  relationshipCount: number;
  /**
   * The artifact's parent in a hierarchy view (ISS-6560). Optional because only
   * project collections render lineage; `null` is an explicit root, `undefined`
   * a fixture that carries no lineage at all.
   */
  parentArtifactId?: string | null;
  /** Values captured by the shared manual-creation experience. */
  creationValues?: Readonly<
    Record<string, string | number | readonly string[] | null>
  >;
};

export type ArtifactSessionPhase = {
  id: string;
  label: string;
  duration: string;
  cost: number;
  color: "primary" | "info" | "warning" | "success";
};

export type ArtifactWritingSession = {
  id: string;
  title: string;
  /** Whether the contributing session is still running. */
  status?: "active" | "completed";
  /** Why this session is related to the artifact. */
  relationship?: "commented" | "wrote";
  contributor: string;
  contributorInitials: string;
  /** Timestamp of the latest turn, tool event, or comment in the session. */
  lastInteractionAt?: string;
  /** Calendar date for the latest interaction, when the aggregate spans days. */
  lastInteractionDate?: string;
  /** Last transcript row owned by this session in the combined Sessions trace. */
  lastInteractionTraceRow?: number;
  model: string;
  startedAt: string;
  duration: string;
  phases: readonly ArtifactSessionPhase[];
  prompt: string;
  outcome: string;
};

export type ArtifactSessionTrace = {
  endAt: string;
  startDate: string;
  startAt: string;
  wallClock: string;
  sessions: readonly ArtifactWritingSession[];
};

export const genericArtifacts: readonly GenericArtifact[] = [
  {
    id: "artifact-1",
    slug: "FEA-2481",
    title: "Unified artifact experience",
    summary:
      "Define the common list and detail grammar used by every artifact surface.",
    kind: ArtifactKind.Issue,
    status: ArtifactStatus.InReview,
    owner: "Ottilie Eastwick",
    ownerInitials: "AE",
    collaborators: ["Pascoe Birchall", "Sam Chen", "Jordan Lee"],
    repository: "closedloop-ai",
    project: "Artifact foundations",
    tags: ["Foundations", "UX"],
    commentCount: 14,
    currentVersion: "4",
    updated: "just now",
    updatedAgoMinutes: 1,
    createdAgoDays: 0,
    aiSpend: 18.72,
    timeToReadyMinutes: 14,
    outcomeScore: 91,
    activityCount: 12,
    relationshipCount: 6,
  },
  {
    id: "artifact-2",
    slug: "DOC-184",
    title: "Artifact interaction principles",
    summary:
      "The product principles and interaction rules that make artifacts feel related.",
    kind: ArtifactKind.Document,
    status: ArtifactStatus.Approved,
    owner: "Pascoe Birchall",
    ownerInitials: "PB",
    collaborators: ["Ottilie Eastwick", "Jordan Lee"],
    repository: null,
    project: "Artifact foundations",
    tags: ["Principles", "Product", "Design system", "Research", "Governance"],
    commentCount: 8,
    currentVersion: "3",
    updated: "12d ago",
    updatedAgoMinutes: 12 * 24 * 60,
    createdAgoDays: 21,
    aiSpend: 9.84,
    timeToReadyMinutes: 22,
    outcomeScore: 88,
    activityCount: 8,
    relationshipCount: 4,
  },
  // The one session this sandbox describes end to end. Its component tree, and
  // therefore its spend, live in `./fixtures/session/traced-session.ts`; the Sessions
  // prototype's `ses_7b91` row and this tab's flame Trace read the same rows, so
  // `aiSpend` is REDUCED from the tree rather than typed beside it and cannot
  // disagree with what the Trace tab's header adds up.
  {
    id: "artifact-3",
    slug: TRACED_SESSION.artifactSlug,
    title: TRACED_SESSION.name,
    summary:
      "Design session creating a shared visual system for artifact list and detail pages.",
    kind: ArtifactKind.Session,
    status: ArtifactStatus.Active,
    owner: TRACED_SESSION.ownerName,
    ownerInitials: TRACED_SESSION.ownerInitials,
    collaborators: ["Pascoe Birchall", "Sam Chen"],
    repository: "closedloop-ai",
    project: "Artifact foundations",
    tags: ["Prototype", "Design"],
    commentCount: 23,
    currentVersion: "1",
    updated: "just now",
    updatedAgoMinutes: 0,
    createdAgoDays: 0,
    aiSpend: tracedSessionTotals.costUsd,
    timeToReadyMinutes: 31,
    outcomeScore: 76,
    activityCount: tracedSessionTotals.invocationCount,
    relationshipCount: 3,
  },
  {
    id: "artifact-4",
    slug: "BR-2048",
    title: "prototype/generic-artifacts-web-master",
    summary:
      "Working branch for the generic artifact visual reference and Web Master integration.",
    kind: ArtifactKind.Branch,
    status: ArtifactStatus.Active,
    owner: "Ottilie Eastwick",
    ownerInitials: "AE",
    collaborators: ["Pascoe Birchall"],
    repository: "closedloop-ai",
    project: "Artifact foundations",
    tags: ["Prototype"],
    commentCount: 5,
    currentVersion: "7",
    updated: "45d ago",
    updatedAgoMinutes: 45 * 24 * 60,
    createdAgoDays: 60,
    aiSpend: 27.33,
    timeToReadyMinutes: 17,
    outcomeScore: 83,
    activityCount: 17,
    relationshipCount: 5,
  },
  {
    id: "artifact-5",
    slug: "ISS-4382",
    title: "Make documents a first-class artifact",
    summary:
      "Align document navigation and metadata with the rest of the artifact family.",
    kind: ArtifactKind.Issue,
    status: ArtifactStatus.Triage,
    owner: "Sam Chen",
    ownerInitials: "SC",
    collaborators: [
      "Ottilie Eastwick",
      "Pascoe Birchall",
      "Jordan Lee",
      "Taylor Reed",
    ],
    repository: "closedloop-ai",
    project: "Documents",
    tags: ["Documents", "Platform"],
    commentCount: 11,
    currentVersion: "2",
    updated: "75d ago",
    updatedAgoMinutes: 75 * 24 * 60,
    createdAgoDays: 110,
    aiSpend: 14.25,
    timeToReadyMinutes: 26,
    outcomeScore: 69,
    activityCount: 19,
    relationshipCount: 7,
  },
  {
    id: "artifact-6",
    slug: "DOC-167",
    title: "Sessions product brief",
    summary:
      "Requirements and rationale for treating harness sessions as navigable artifacts.",
    kind: ArtifactKind.Document,
    status: ArtifactStatus.Completed,
    owner: "Jordan Lee",
    ownerInitials: "JL",
    collaborators: [],
    repository: null,
    project: "Sessions",
    tags: ["Sessions", "Brief"],
    commentCount: 3,
    currentVersion: "4",
    updated: "120d ago",
    updatedAgoMinutes: 120 * 24 * 60,
    createdAgoDays: 180,
    aiSpend: 11.07,
    timeToReadyMinutes: 19,
    outcomeScore: 95,
    activityCount: 6,
    relationshipCount: 9,
  },
];

const sharedWritingSessions: readonly ArtifactWritingSession[] = [
  {
    id: "session-discovery",
    title: "Establish the artifact structure",
    status: "completed",
    relationship: "wrote",
    contributor: "Ottilie Eastwick",
    contributorInitials: "AE",
    lastInteractionAt: "12:35am",
    lastInteractionDate: "2026-07-22",
    lastInteractionTraceRow: 46,
    model: "claude-opus-4-8",
    startedAt: "9:02am",
    duration: "31m 18s",
    phases: [
      {
        id: "discovery",
        label: "Discovery",
        duration: "8m",
        cost: 3.42,
        color: "info",
      },
      {
        id: "creation",
        label: "Creation",
        duration: "19m",
        cost: 12.86,
        color: "primary",
      },
      {
        id: "review",
        label: "Review",
        duration: "4m",
        cost: 2.18,
        color: "success",
      },
    ],
    prompt:
      "Create the first version of this artifact using the shared requirements and current project context.",
    outcome:
      "Established the initial structure, drafted the core content, and saved a reviewable artifact version.",
  },
  {
    id: "session-revision",
    title: "Address review feedback",
    status: "completed",
    relationship: "commented",
    contributor: "Pascoe Birchall",
    contributorInitials: "PB",
    lastInteractionAt: "5:54pm",
    lastInteractionDate: "2026-07-26",
    lastInteractionTraceRow: 86,
    model: "gpt-5.5",
    startedAt: "10:18am",
    duration: "24m 09s",
    phases: [
      {
        id: "analysis",
        label: "Analysis",
        duration: "6m",
        cost: 2.08,
        color: "info",
      },
      {
        id: "rework",
        label: "Rework",
        duration: "14m",
        cost: 7.96,
        color: "warning",
      },
      {
        id: "validation",
        label: "Validation",
        duration: "4m",
        cost: 1.59,
        color: "success",
      },
    ],
    prompt:
      "Apply the review comments while preserving the artifact’s intent and shared interaction conventions.",
    outcome:
      "Resolved the review feedback, tightened the artifact, and produced the current candidate version.",
  },
  {
    id: "session-finalize",
    title: "Finalize the current version",
    status: "active",
    relationship: "wrote",
    contributor: "Jordan Lee",
    contributorInitials: "JL",
    lastInteractionAt: "9:02am",
    lastInteractionDate: "2026-07-31",
    lastInteractionTraceRow: 102,
    model: "claude-sonnet-5",
    startedAt: "11:06am",
    duration: "13m 42s",
    phases: [
      {
        id: "verification",
        label: "Verification",
        duration: "5m",
        cost: 1.84,
        color: "info",
      },
      {
        id: "polish",
        label: "Polish",
        duration: "6m",
        cost: 3.46,
        color: "primary",
      },
      {
        id: "publish",
        label: "Publish",
        duration: "3m",
        cost: 0.92,
        color: "success",
      },
    ],
    prompt:
      "Verify the artifact against its acceptance criteria and prepare the current version for downstream use.",
    outcome:
      "Completed the final checks, clarified the remaining language, and marked the version current.",
  },
];

export const genericArtifactSessionTrace: ArtifactSessionTrace = {
  startDate: "2026-07-18",
  startAt: "9:02am",
  endAt: "11:20am",
  wallClock: "2h 18m",
  sessions: sharedWritingSessions,
};

const ARTIFACT_KIND_VALUES: ReadonlySet<string> = new Set(
  Object.values(ArtifactKind)
);

export function isArtifactKind(value: string): value is ArtifactKind {
  return ARTIFACT_KIND_VALUES.has(value);
}
