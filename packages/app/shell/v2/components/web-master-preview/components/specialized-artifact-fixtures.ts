import {
  ArtifactKind,
  ArtifactStatus,
  type GenericArtifact,
  genericArtifacts,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import {
  formatAgo,
  HARNESS_CONFIG,
  type SessionRow,
  SessionStatus,
  sessionRows,
} from "../../../../../agents/components/sessions/web-master-legacy-preview/mock"; // Cross-slice: preview shell hosts the Sessions preview (ISS-12938).
import { agentArtifacts } from "./agent-artifact-model";
import { prototypeArtifacts } from "./prototype-artifact-specialization";
import type { SpecializedArtifactKind } from "./specialized-artifact-kinds";

export function artifactsForKind(
  kind: SpecializedArtifactKind
): readonly GenericArtifact[] {
  if (kind === "documents") {
    return documentArtifacts;
  }
  if (kind === "issues" || kind === "issues-v2") {
    return issueArtifacts;
  }
  if (kind === "sessions") {
    return sessionRows.map(sessionToArtifact);
  }
  if (kind === "agents") {
    return agentArtifacts;
  }
  return prototypeArtifacts;
}

const documentArtifacts = buildExpandedArtifacts(ArtifactKind.Document, [
  [
    "DOC-211",
    "Agent governance PRD",
    "Define review, approval, and rollout rules for reusable agent definitions.",
  ],
  [
    "DOC-205",
    "Session trace product brief",
    "Explain how multi-session provenance should read across artifact types.",
  ],
  [
    "DOC-198",
    "Prototype review guidelines",
    "Document the interaction and evidence required before prototype handoff.",
  ],
  [
    "DOC-192",
    "Artifact permissions model",
    "Clarify owners, collaborators, viewers, and artifact-level actions.",
  ],
  [
    "DOC-181",
    "Custom fields specification",
    "Specify shared custom-field types, editors, filters, and table rendering.",
  ],
  [
    "DOC-174",
    "Artifact migration plan",
    "Sequence the migration of legacy list and detail surfaces to the shared shell.",
  ],
]);

const issueArtifacts = buildExpandedArtifacts(ArtifactKind.Issue, [
  [
    "FEA-2510",
    "Adopt shared artifact list controls",
    "Move filter, sort, grouping, options, and fields onto the reusable list shell.",
  ],
  [
    "FEA-2504",
    "Standardize artifact detail tabs",
    "Apply fixed Artifact, Details, and Sessions labels to supported artifact types.",
  ],
  [
    "FEA-2499",
    "Persist custom field values",
    "Store custom field definitions and values for artifact list and detail editing.",
  ],
  [
    "FEA-2492",
    "Add artifact contribution sessions",
    "Show only sessions that wrote, revised, or commented on an artifact definition.",
  ],
  [
    "FEA-2488",
    "Unify artifact comments",
    "Keep artifact comments distinct from trace comments while sharing the rail.",
  ],
  [
    "FEA-2476",
    "Migrate legacy project views",
    "Apply the generic table and detail grammar to team project views.",
  ],
]);

function buildExpandedArtifacts(
  kind: ArtifactKind,
  fixtures: readonly (readonly [string, string, string])[]
): readonly GenericArtifact[] {
  const base = genericArtifacts.filter((artifact) => artifact.kind === kind);
  const template = base[0];
  if (!template) {
    return base;
  }
  const updates = [4, 8, 13, 21, 52, 88];
  // Index 3 is kind-specific. The issues board keys its leading lane on Triage
  // and counts Active toward the active-work metric, so an issue row here must
  // not join "In progress" just because it lost its former status; documents
  // have no Triage lane and keep Active.
  //
  // Index 4 is kind-specific for the same reason at the other end of the board:
  // documents land `Completed` in their "Published" lane, while the issues
  // board's end lane is "Done", keyed on `Approved`. A shared `Completed` put
  // every sixth issue in a lane that board does not declare.
  const statuses = [
    ArtifactStatus.InReview,
    ArtifactStatus.Approved,
    ArtifactStatus.Active,
    kind === ArtifactKind.Issue ? ArtifactStatus.Triage : ArtifactStatus.Active,
    kind === ArtifactKind.Issue
      ? ArtifactStatus.Approved
      : ArtifactStatus.Completed,
    ArtifactStatus.InReview,
  ];
  return [
    ...base,
    ...fixtures.map(([slug, title, summary], index) => ({
      ...template,
      activityCount: 7 + index * 3,
      aiSpend: 8.4 + index * 4.75,
      collaborators: [
        "Ottilie Eastwick",
        "Jordan Lee",
        "Pascoe Birchall",
      ].slice(0, 1 + (index % 3)),
      commentCount: 2 + index * 2,
      createdAgoDays: updates[index]! + 14,
      currentVersion: String(index + 1),
      id: `${kind.toLowerCase()}-fixture-${index + 1}`,
      outcomeScore: 72 + index * 4,
      owner: ["Ottilie Eastwick", "Jordan Lee", "Pascoe Birchall"][index % 3]!,
      ownerInitials: ["AE", "JL", "PB"][index % 3]!,
      relationshipCount: 2 + index,
      slug,
      status: statuses[index]!,
      summary,
      tags:
        kind === ArtifactKind.Document
          ? ["PRD", "Platform"]
          : ["Feature", "Artifacts"],
      timeToReadyMinutes: 12 + index * 6,
      title,
      updated: `${updates[index]}d ago`,
      updatedAgoMinutes: updates[index]! * 24 * 60,
    })),
  ];
}

function sessionToArtifact(row: SessionRow): GenericArtifact {
  const status = sessionArtifactStatus(row.status);
  return {
    activityCount: Math.max(1, Math.round(row.durationMs / 60_000)),
    aiSpend: row.cost,
    collaborators: row.collaborators.map((person) => person.name),
    commentCount: row.commentCount,
    createdAgoDays: Math.floor(row.startedAgoMinutes / 1440),
    currentVersion: "1",
    id: row.id,
    kind: ArtifactKind.Session,
    outcomeScore: row.autonomy ?? 0,
    owner: row.user?.name ?? "Unassigned",
    ownerInitials: row.user?.initials ?? "—",
    project: row.projects[0] ?? null,
    relationshipCount: row.linkedIssues.length + row.linkedAgents.length,
    repository: row.repo,
    slug: row.id.toUpperCase(),
    status,
    summary: `A ${HARNESS_CONFIG[row.harness].label} session using ${row.model ?? "an unspecified model"}.`,
    tags: row.tags.map((tag) => tag.label),
    timeToReadyMinutes: Math.max(1, Math.round(row.durationMs / 60_000)),
    title: row.name,
    updated: formatAgo(row.lastActivityAgoMinutes),
    updatedAgoMinutes: row.updatedAgoMinutes,
  };
}

// Exhaustive over the three-value session lifecycle so a future member fails
// typecheck here instead of yielding `undefined` at the call site.
const SESSION_ARTIFACT_STATUS: Record<SessionStatus, ArtifactStatus> = {
  [SessionStatus.Active]: ArtifactStatus.Active,
  [SessionStatus.Inactive]: ArtifactStatus.Completed,
  [SessionStatus.Failed]: ArtifactStatus.Failed,
};

function sessionArtifactStatus(status: SessionStatus): ArtifactStatus {
  return SESSION_ARTIFACT_STATUS[status];
}

export function sessionCostValues(row: SessionRow | undefined) {
  const api = row?.cost ?? 0;
  const subscription = row?.apiEquivalentCost ?? 0;
  return { api, subscription, total: api + subscription };
}

export function stableIndex(artifact: GenericArtifact): number {
  return artifact.slug.length % 3;
}
