import type {
  ArtifactStatusEditSurface,
  ArtifactStatusProvenance,
} from "./artifact-status-contract.js";
import type { JsonValue } from "./common.js";

/** Fields classified by the shared receipt and analytics contracts. */
export const ArtifactFieldEditField = {
  Status: "status",
  AssigneeId: "assigneeId",
  ApproverId: "approverId",
  Priority: "priority",
  Title: "title",
  DueDate: "dueDate",
  ProjectId: "projectId",
  Tag: "tag",
  Name: "name",
  /** Analytics-only today; custom-field writes intentionally add no feed row. */
  CustomField: "customField",
} as const;
export type ArtifactFieldEditField =
  (typeof ArtifactFieldEditField)[keyof typeof ArtifactFieldEditField];

/** Value-safe categories persisted on receipts and emitted to analytics. */
export const ArtifactFieldEditValueClassification = {
  Absent: "absent",
  Enumerated: "enumerated",
  Reference: "reference",
  Date: "date",
  Content: "content",
} as const;
export type ArtifactFieldEditValueClassification =
  (typeof ArtifactFieldEditValueClassification)[keyof typeof ArtifactFieldEditValueClassification];

/** The only result persisted on an activity row: refused writes have no row. */
export const ArtifactFieldEditReceiptResult = {
  Committed: "committed",
} as const;
export type ArtifactFieldEditReceiptResult =
  (typeof ArtifactFieldEditReceiptResult)[keyof typeof ArtifactFieldEditReceiptResult];

/** Bounded server outcomes used by aggregate edit analytics. */
export const ArtifactFieldEditOutcome = {
  Committed: ArtifactFieldEditReceiptResult.Committed,
  NoChange: "no_change",
  ValidationFailed: "validation_failed",
  Conflict: "conflict",
  RolledBack: "rolled_back",
} as const;
export type ArtifactFieldEditOutcome =
  (typeof ArtifactFieldEditOutcome)[keyof typeof ArtifactFieldEditOutcome];

/** Optional authoritative context for one committed field edit. */
export type ArtifactFieldEditReceiptContext = Readonly<{
  provenance?: ArtifactStatusProvenance;
  /** The grouped commit reversed by this write, when the server knows it. */
  undoOfCommitGroupId?: string;
}>;

/** Additive receipt metadata accepted by legacy `{ field, value }` readers. */
export type ArtifactFieldEditSnapshot = Readonly<{
  field: ArtifactFieldEditField;
  value: JsonValue;
  valueClassification: ArtifactFieldEditValueClassification;
  /** Present only when the raw value was deliberately withheld. */
  valueOmitted?: true;
  surface?: ArtifactStatusEditSurface;
  result?: ArtifactFieldEditReceiptResult;
  commitGroupId?: string;
  undoOfCommitGroupId?: string;
}>;

/**
 * Build value-safe before/after snapshots for one committed edit.
 *
 * Artifact titles and session names are authorized activity-feed content.
 * Dynamic custom-field content keeps its classification but stores no raw value.
 * Provenance and lineage are copied only when supplied by an authoritative
 * route or mutation result; missing context remains omitted.
 */
export function buildArtifactFieldEditSnapshots(params: {
  field: ArtifactFieldEditField;
  before: JsonValue;
  after: JsonValue;
  context?: ArtifactFieldEditReceiptContext;
}): { before: ArtifactFieldEditSnapshot; after: ArtifactFieldEditSnapshot } {
  const before = buildValueSnapshot(params.field, params.before);
  const afterValue = buildValueSnapshot(params.field, params.after);
  const provenance = params.context?.provenance;
  const commitGroupId = provenance?.commitGroupId;
  const undoOfCommitGroupId =
    commitGroupId === undefined
      ? undefined
      : params.context?.undoOfCommitGroupId;

  return {
    before,
    after: {
      ...afterValue,
      ...(provenance === undefined ? {} : { surface: provenance.surface }),
      result: ArtifactFieldEditReceiptResult.Committed,
      ...(commitGroupId === undefined ? {} : { commitGroupId }),
      ...(undoOfCommitGroupId === undefined ? {} : { undoOfCommitGroupId }),
    },
  };
}

/** Return the value-safe classification for a field/value pair. */
export function classifyArtifactFieldEditValue(
  field: ArtifactFieldEditField,
  value: JsonValue
): ArtifactFieldEditValueClassification {
  if (value === null) {
    return ArtifactFieldEditValueClassification.Absent;
  }
  return FIELD_VALUE_CLASSIFICATION[field];
}

function buildValueSnapshot(
  field: ArtifactFieldEditField,
  value: JsonValue
): ArtifactFieldEditSnapshot {
  const valueClassification = classifyArtifactFieldEditValue(field, value);
  const omitValue =
    field === ArtifactFieldEditField.CustomField &&
    valueClassification === ArtifactFieldEditValueClassification.Content;

  return {
    field,
    value: omitValue ? null : value,
    valueClassification,
    ...(omitValue ? { valueOmitted: true as const } : {}),
  };
}

const FIELD_VALUE_CLASSIFICATION = {
  [ArtifactFieldEditField.Status]:
    ArtifactFieldEditValueClassification.Enumerated,
  [ArtifactFieldEditField.AssigneeId]:
    ArtifactFieldEditValueClassification.Reference,
  [ArtifactFieldEditField.ApproverId]:
    ArtifactFieldEditValueClassification.Reference,
  [ArtifactFieldEditField.Priority]:
    ArtifactFieldEditValueClassification.Enumerated,
  [ArtifactFieldEditField.Title]: ArtifactFieldEditValueClassification.Content,
  [ArtifactFieldEditField.DueDate]: ArtifactFieldEditValueClassification.Date,
  [ArtifactFieldEditField.ProjectId]:
    ArtifactFieldEditValueClassification.Reference,
  [ArtifactFieldEditField.Tag]: ArtifactFieldEditValueClassification.Reference,
  [ArtifactFieldEditField.Name]: ArtifactFieldEditValueClassification.Content,
  [ArtifactFieldEditField.CustomField]:
    ArtifactFieldEditValueClassification.Content,
} as const satisfies Readonly<
  Record<ArtifactFieldEditField, ArtifactFieldEditValueClassification>
>;
