import type { LinkIcon } from "lucide-react";
import {
  type ArtifactSessionTrace,
  type GenericArtifact,
  genericArtifactSessionTrace,
} from "../fixtures";
import { ArtifactTypeIcons } from "./artifact-icons";

export type ReferenceOption = {
  icon: typeof LinkIcon;
  id: string;
  lastInteractionAt?: string;
  lastInteractionDate?: string;
  lastInteractionTraceRow?: number;
  ownerInitials?: string;
  ownerName?: string;
  relationship?: "commented" | "wrote";
  slug: string;
  status?: "active" | "completed";
  title: string;
};

const REFERENCE_TIME_PATTERN = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i;

export function relatedSessionOptions(
  artifact: GenericArtifact,
  trace: ArtifactSessionTrace
): ReferenceOption[] {
  const artifactKey = artifact.slug.split("-").at(-1) ?? artifact.slug;
  return trace.sessions
    .map((session, index) => ({
      icon: ArtifactTypeIcons.Session,
      id: session.id,
      lastInteractionAt: session.lastInteractionAt ?? session.startedAt,
      lastInteractionDate: session.lastInteractionDate,
      lastInteractionTraceRow: session.lastInteractionTraceRow,
      ownerInitials: session.contributorInitials,
      ownerName: session.contributor,
      relationship:
        session.relationship ??
        (session.title.toLowerCase().includes("comment")
          ? "commented"
          : "wrote"),
      slug: `SES-${artifactKey}-${index + 1}`,
      status:
        session.status ??
        (index === trace.sessions.length - 1 ? "active" : "completed"),
      title: session.title,
    }))
    .sort(compareRelatedSessionsByRecency);
}

export const defaultRelatedSessionsForArtifact = () =>
  genericArtifactSessionTrace;

function compareRelatedSessionsByRecency(
  left: ReferenceOption,
  right: ReferenceOption
): number {
  const recencyDifference =
    relatedSessionSortValue(right) - relatedSessionSortValue(left);
  if (recencyDifference !== 0) {
    return recencyDifference;
  }
  if (left.status === right.status) {
    return 0;
  }
  return left.status === "active" ? -1 : 1;
}

function relatedSessionSortValue(option: ReferenceOption): number {
  const timeMatch = option.lastInteractionAt
    ?.trim()
    .match(REFERENCE_TIME_PATTERN);
  if (!timeMatch) {
    return 0;
  }
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const period = timeMatch[3]?.toLowerCase();
  if (period === "pm" && hour !== 12) {
    hour += 12;
  } else if (period === "am" && hour === 12) {
    hour = 0;
  }
  const today = new Date();
  const day = option.lastInteractionDate
    ? Date.parse(`${option.lastInteractionDate}T00:00:00`)
    : new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate()
      ).getTime();
  return (Number.isNaN(day) ? 0 : day) + (hour * 60 + minute) * 60_000;
}
