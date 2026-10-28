import {
  GenericArtifactStatus,
  genericArtifactStatusOptions,
} from "../../generic-artifact-status";
import {
  ArtifactKind,
  type ArtifactStatus,
  type GenericArtifact,
} from "../fixtures";

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
  /**
   * Project preselected in the creation dialog. A project-scoped surface names
   * itself here so a new artifact is not filed under the shared default; absent
   * keeps the dialog's own default.
   */
  defaultProject?: string;
  description: string;
  fields?: readonly ArtifactCreationField[];
  includeRepository?: boolean;
  kind: ArtifactKind;
  noun: string;
  slugPrefix: string;
};

export type ArtifactCreationValues = {
  /** File names selected in the creation dialog's attachment picker. */
  attachments: string[];
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
  const kind = artifactKindForCreation(config, values.customValues);
  const status = genericArtifactStatusOptions(kind).includes(values.status)
    ? values.status
    : genericArtifactDefaultStatus(kind);
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
      attachments: values.attachments,
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
    status,
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

/** Resolve the selected kind before deriving any kind-bound creation value. */
export function artifactKindForCreation(
  config: ArtifactCreationConfig,
  customValues: ArtifactCreationValues["customValues"]
): ArtifactKind {
  const requestedKind = customValues["artifact-type"];
  if (requestedKind === "Agentic Component") {
    return ArtifactKind.Agent;
  }
  if (Object.values(ArtifactKind).includes(requestedKind as ArtifactKind)) {
    return requestedKind as ArtifactKind;
  }
  return config.kind;
}

/** A kind-valid neutral creation default. */
export function genericArtifactDefaultStatus(
  kind: ArtifactKind
): ArtifactStatus {
  switch (kind) {
    case ArtifactKind.Document:
      return GenericArtifactStatus.Draft;
    case ArtifactKind.Issue:
      return GenericArtifactStatus.Backlog;
    case ArtifactKind.Branch:
    case ArtifactKind.Session:
      return GenericArtifactStatus.Active;
    case ArtifactKind.Agent:
    case ArtifactKind.Prototype:
      return GenericArtifactStatus.Todo;
    default:
      return GenericArtifactStatus.Todo;
  }
}
