"use client";

import { toast } from "@repo/design-system/components/ui/sonner";
import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import {
  TableChangeCell,
  TableCountCell,
  TableDateCell,
  TableNumberCell,
  TableVersionCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import {
  TableModelCell,
  TableRepositoryCell,
} from "@repo/design-system/components/ui/table-cell-semantic-primitives";
import { MessageSquareIcon } from "lucide-react";
import { CustomFieldCell } from "./custom-field-cells";
import {
  EditableOwnerTableCell,
  EditablePeopleTableCell,
  EditableStatusTableCell,
  EditableTagsTableCell,
} from "./editable-cells";
import { type ArtifactRow, artifactPeople, tagOptions } from "./fixtures";
import { RelatedSessionsTableCell } from "./related-sessions-table-cell";
import { EditablePriorityTableCell } from "./semantic-cells";

export function ArtifactCell({
  artifact,
  columnId,
  customFields,
  onArtifactChange,
}: {
  artifact: ArtifactRow;
  columnId: string;
  customFields: readonly CustomFieldDefinition[];
  onArtifactChange: (
    artifactId: string,
    patch: Partial<ArtifactRow>,
    message?: string
  ) => void;
}) {
  const customField = customFields.find((field) => field.id === columnId);
  if (customField) {
    return (
      <CustomFieldCell
        artifact={artifact}
        field={customField}
        onArtifactChange={onArtifactChange}
      />
    );
  }
  switch (columnId) {
    case "owner":
      return (
        <EditableOwnerTableCell
          onChange={(owner) =>
            onArtifactChange(artifact.id, { owner }, "Owner updated")
          }
          options={artifactPeople}
          owner={artifact.owner}
        />
      );
    case "collaborators":
      return (
        <EditablePeopleTableCell
          onChange={(collaborators) =>
            onArtifactChange(artifact.id, { collaborators })
          }
          options={artifactPeople}
          people={artifact.collaborators}
        />
      );
    case "status":
      return (
        <EditableStatusTableCell
          artifact={artifact}
          onChange={(status) =>
            onArtifactChange(
              artifact.id,
              { status, statusRaw: undefined },
              "Status updated"
            )
          }
        />
      );
    case "priority":
      return (
        <EditablePriorityTableCell
          onChange={(priority) =>
            onArtifactChange(artifact.id, { priority }, "Priority updated")
          }
          priority={artifact.priority}
        />
      );
    case "relatedSessions":
      return <RelatedSessionsTableCell items={artifact.relatedSessions} />;
    case "comments":
      return (
        <TableCountCell
          ariaLabel={`${artifact.comments} comments`}
          count={artifact.comments}
          icon={MessageSquareIcon}
          onClick={() => toast.info(`Opened comments for ${artifact.slug}`)}
        />
      );
    case "updated":
      return <TableDateCell value={artifact.updated} />;
    case "currentVersion":
      return (
        <TableVersionCell
          ariaLabel={`Open version ${artifact.currentVersion}`}
          onClick={() =>
            toast.info(
              `Opened version ${artifact.currentVersion} for ${artifact.slug}`
            )
          }
          value={artifact.currentVersion}
        />
      );
    case "tags":
      return (
        <EditableTagsTableCell
          onChange={(labels) =>
            onArtifactChange(
              artifact.id,
              {
                tags: labels.map(
                  (label) =>
                    tagOptions.find((tag) => tag.label === label) ?? {
                      id: label,
                      label,
                    }
                ),
              },
              "Tags updated"
            )
          }
          optionLabels={tagOptions.map((tag) => tag.label)}
          tags={artifact.tags.map((tag) => tag.label)}
        />
      );
    case "repository":
      return (
        <TableRepositoryCell
          fullName={artifact.repository ?? undefined}
          label={artifact.repository?.split("/").at(-1)}
          onSelect={
            artifact.repository
              ? () => toast.info(`Opened ${artifact.repository}`)
              : undefined
          }
        />
      );
    case "model":
      return (
        <TableModelCell
          indicatorClassName={artifact.modelIndicatorClassName}
          model={artifact.model}
          providerLabel={artifact.modelProvider}
        />
      );
    case "creationCost":
      return (
        <TableNumberCell
          value={
            artifact.creationCost == null
              ? null
              : `$${artifact.creationCost.toFixed(2)}`
          }
        />
      );
    case "lineChanges":
      return (
        <TableChangeCell
          additions={artifact.additions}
          deletions={artifact.deletions}
        />
      );
    default:
      return null;
  }
}
