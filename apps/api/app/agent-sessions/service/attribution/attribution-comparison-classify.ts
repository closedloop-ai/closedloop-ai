/**
 * ISS-12552: the pure half of the attribution comparison
 * report. Classifies each session link with the flag off (the legacy rule)
 * and on (evidence and branch participation), sorts what the flag would drop
 * by why, and splits sessions without evidence by whether they can still get
 * it. No user-facing copy: the report is an operator artifact.
 */

import { evidenceProvenanceKind } from "@repo/api/src/types/attribution-provenance-kind";
import {
  ProvenanceRelationshipKind,
  RELATED_SESSION_ELIGIBLE_KINDS,
} from "@repo/api/src/types/provenance-relationship";
import {
  branchLaneParticipationKind,
  classifySessionLinkKind,
} from "../provenance-eligibility";

/** Strongest first; a pair takes the first kind any of its rows names. */
const STRENGTH: readonly ProvenanceRelationshipKind[] = [
  ProvenanceRelationshipKind.Production,
  ProvenanceRelationshipKind.Contribution,
  ProvenanceRelationshipKind.Comment,
  ProvenanceRelationshipKind.Invocation,
  ProvenanceRelationshipKind.Usage,
  ProvenanceRelationshipKind.Reference,
];

export const AbsentEvidenceGroup = {
  /** The session synced evidence, and none of it names this target. */
  EvidenceSyncedNoClaim: "evidenceSyncedNoClaim",
  /** Synced after receipts existed with no evidence: an older Desktop (estimate). */
  DesktopNotUpgraded: "desktopNotUpgraded",
  /** Before receipts, transcript retained in the cloud: recoverable by replay. */
  PredatesReceipts: "predatesReceipts",
  /** Before receipts, no cloud transcript (a Desktop may still hold one). */
  NoRetainedTranscript: "noRetainedTranscript",
} as const;
export type AbsentEvidenceGroup =
  (typeof AbsentEvidenceGroup)[keyof typeof AbsentEvidenceGroup];

export type ComparisonLink = {
  sourceId: string;
  targetId: string;
  linkType: string;
  branchParticipation: string | null;
  metadata: unknown;
};

export type ComparisonEvidence = {
  id: string;
  relationshipKind: string;
  outcome: string;
  source: string;
};

export type LinkComparison = {
  flagOff: ProvenanceRelationshipKind;
  /** Null when the link carries neither evidence nor participation. */
  flagOn: ProvenanceRelationshipKind | null;
  drop: "readOrReference" | "absentEvidence" | null;
  added: boolean;
};

export function compareLink(
  link: ComparisonLink,
  evidence: readonly ComparisonEvidence[]
): LinkComparison {
  const flagOff = classifySessionLinkKind(link);
  const participation = branchLaneParticipationKind(link);
  const kinds = [
    ...evidence.flatMap(
      (row) => evidenceProvenanceKind(row.relationshipKind) ?? []
    ),
    ...(participation ? [participation] : []),
  ];
  const flagOn = STRENGTH.find((kind) => kinds.includes(kind)) ?? null;
  const eligibleOff = isEligible(flagOff);
  const eligibleOn = flagOn !== null && isEligible(flagOn);
  let drop: LinkComparison["drop"] = null;
  if (eligibleOff && !eligibleOn) {
    drop = evidence.length > 0 ? "readOrReference" : "absentEvidence";
  }
  return { flagOff, flagOn, drop, added: !eligibleOff && eligibleOn };
}

function isEligible(kind: ProvenanceRelationshipKind): boolean {
  return RELATED_SESSION_ELIGIBLE_KINDS.includes(kind);
}

export function absentEvidenceGroup(session: {
  hasEvidenceSnapshot: boolean;
  syncedAt: Date;
  hasCloudTranscript: boolean;
  /** Null when no receipt exists yet: every session predates receipts. */
  receiptsEpoch: Date | null;
}): AbsentEvidenceGroup {
  if (session.hasEvidenceSnapshot) {
    return AbsentEvidenceGroup.EvidenceSyncedNoClaim;
  }
  if (session.receiptsEpoch && session.syncedAt >= session.receiptsEpoch) {
    return AbsentEvidenceGroup.DesktopNotUpgraded;
  }
  return session.hasCloudTranscript
    ? AbsentEvidenceGroup.PredatesReceipts
    : AbsentEvidenceGroup.NoRetainedTranscript;
}

export type ComparisonSection = {
  links: {
    total: number;
    agree: number;
    disagree: number;
    addedByEvidence: number;
    droppedForReadOrReference: number;
    droppedForAbsentEvidence: number;
  };
  /** `flagOff->flagOn` to count; `none` when the flag-on side has no kind. */
  transitions: Record<string, number>;
  disagreements: {
    total: number;
    /** The first `DISAGREEMENT_SAMPLE` disagreements, with their evidence. */
    sample: {
      sessionId: string;
      targetId: string;
      flagOff: string;
      flagOn: string | null;
      evidence: ComparisonEvidence[];
    }[];
  };
  absentEvidenceSessions: Record<AbsentEvidenceGroup, number> & {
    /** The not-upgraded versus permanent line is an estimate. */
    splitIsEstimate: true;
  };
};

export const DISAGREEMENT_SAMPLE = 200;

export function emptySection(): ComparisonSection {
  return {
    links: {
      total: 0,
      agree: 0,
      disagree: 0,
      addedByEvidence: 0,
      droppedForReadOrReference: 0,
      droppedForAbsentEvidence: 0,
    },
    transitions: {},
    disagreements: { total: 0, sample: [] },
    absentEvidenceSessions: {
      [AbsentEvidenceGroup.EvidenceSyncedNoClaim]: 0,
      [AbsentEvidenceGroup.DesktopNotUpgraded]: 0,
      [AbsentEvidenceGroup.PredatesReceipts]: 0,
      [AbsentEvidenceGroup.NoRetainedTranscript]: 0,
      splitIsEstimate: true,
    },
  };
}

/** Adds one link's comparison to every section given (org and global). */
export function recordLink(
  sections: readonly ComparisonSection[],
  link: ComparisonLink,
  evidence: readonly ComparisonEvidence[],
  comparison: LinkComparison
): void {
  const transition = `${comparison.flagOff}->${comparison.flagOn ?? "none"}`;
  const disagrees = comparison.flagOff !== comparison.flagOn;
  for (const section of sections) {
    section.links.total += 1;
    section.links[disagrees ? "disagree" : "agree"] += 1;
    section.links.addedByEvidence += comparison.added ? 1 : 0;
    if (comparison.drop === "readOrReference") {
      section.links.droppedForReadOrReference += 1;
    } else if (comparison.drop === "absentEvidence") {
      section.links.droppedForAbsentEvidence += 1;
    }
    section.transitions[transition] =
      (section.transitions[transition] ?? 0) + 1;
    if (disagrees) {
      section.disagreements.total += 1;
      if (section.disagreements.sample.length < DISAGREEMENT_SAMPLE) {
        section.disagreements.sample.push({
          sessionId: link.sourceId,
          targetId: link.targetId,
          flagOff: comparison.flagOff,
          flagOn: comparison.flagOn,
          evidence: [...evidence],
        });
      }
    }
  }
}
