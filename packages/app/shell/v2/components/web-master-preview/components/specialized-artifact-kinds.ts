import type { DetailTab } from "@repo/app/shared/components/generic-artifact-surface/preview/components/generic-artifact-detail-shell";

export type SpecializedArtifactKind =
  | "documents"
  | "issues"
  | "issues-v2"
  | "agents"
  | "prototypes"
  | "sessions";

export const typeConfig: Record<
  SpecializedArtifactKind,
  { label: string; singular: string; tabs: readonly DetailTab[] }
> = {
  agents: {
    label: "Agentic Components",
    singular: "agentic component",
    tabs: ["artifact", "details", "sessions"],
  },
  documents: {
    label: "Documents",
    singular: "document",
    tabs: ["artifact", "details", "sessions"],
  },
  issues: {
    label: "Issues",
    singular: "issue",
    tabs: ["artifact", "details", "sessions"],
  },
  "issues-v2": {
    label: "Issues v2",
    singular: "issue",
    tabs: ["artifact", "details", "sessions"],
  },
  prototypes: {
    label: "Prototypes",
    singular: "prototype",
    tabs: ["artifact", "details", "sessions"],
  },
  sessions: {
    label: "Sessions",
    singular: "session",
    tabs: ["details", "sessions", "activity"],
  },
};
