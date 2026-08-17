import {
  ArtifactKind,
  type ArtifactStatus,
  type GenericArtifact,
} from "../mock";

const NAME_PARTS_PATTERN = /\s+/;

export type ArtifactCreationField = {
  description?: string;
  id: string;
  label: string;
  options?: readonly string[];
  placeholder?: string;
  required?: boolean;
  type: "date" | "multi-select" | "number" | "select" | "text" | "textarea";
};

export type ArtifactCreationConfig = {
  description: string;
  fields?: readonly ArtifactCreationField[];
  includeRepository?: boolean;
  kind: ArtifactKind;
  noun: string;
  slugPrefix: string;
};

export type ArtifactCreationValues = {
  collaborators: string[];
  customValues: Record<string, string | number | readonly string[] | null>;
  linkedArtifacts: string[];
  owner: string;
  project: string | null;
  repository: string | null;
  status: ArtifactStatus;
  summary: string;
  tags: string[];
  title: string;
};

export type ArtifactCreationSubmissionOptions = {
  draft?: boolean;
  openAfterCreate?: boolean;
};

export const defaultArtifactCreationConfig: ArtifactCreationConfig = {
  description:
    "Create an artifact with the shared metadata available across artifact types.",
  fields: [
    {
      id: "artifact-type",
      label: "Artifact type",
      options: ["Document", "Issue", "Agentic Component", "Prototype"],
      required: true,
      type: "select",
    },
  ],
  includeRepository: true,
  kind: ArtifactKind.Document,
  noun: "artifact",
  slugPrefix: "ART",
};

export function buildCreatedArtifact({
  config,
  nextNumber,
  values,
}: {
  config: ArtifactCreationConfig;
  nextNumber: number;
  values: ArtifactCreationValues;
}): GenericArtifact {
  const requestedKind = values.customValues["artifact-type"];
  let kind = config.kind;
  if (requestedKind === "Agentic Component") {
    kind = ArtifactKind.Agent;
  } else if (
    Object.values(ArtifactKind).includes(requestedKind as ArtifactKind)
  ) {
    kind = requestedKind as ArtifactKind;
  }
  const ownerInitials = values.owner
    .split(NAME_PARTS_PATTERN)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return {
    activityCount: 0,
    aiSpend: 0,
    collaborators: values.collaborators,
    commentCount: 0,
    createdAgoDays: 0,
    creationValues: {
      ...values.customValues,
      linkedArtifacts: values.linkedArtifacts,
    },
    currentVersion: "1",
    id: `artifact-${Date.now()}`,
    kind,
    outcomeScore: 0,
    owner: values.owner,
    ownerInitials,
    project: values.project,
    relationshipCount: 0,
    repository: values.repository,
    slug: `${config.slugPrefix}-${String(nextNumber).padStart(3, "0")}`,
    status: values.status,
    // An omitted description is meaningful. In particular, title-only issue
    // creation must open a genuinely bodyless artifact instead of inventing
    // placeholder copy that the user never authored.
    summary: values.summary,
    tags: values.tags,
    timeToReadyMinutes: 0,
    title: values.title,
    updated: "just now",
    updatedAgoMinutes: 0,
  };
}
