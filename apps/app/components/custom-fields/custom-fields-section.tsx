"use client";

// biome-ignore lint/style/useImportType: runtime value used by callers and child components
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { useState } from "react";
import { CollapsibleSection } from "@/components/artifact-editor/collapsible-section";
import { useCustomFieldsForEntityType } from "@/hooks/queries/use-custom-fields";
import { CustomFieldValueEditor } from "./custom-field-value-editor";

type CustomFieldsSectionProps = {
  entityType: CustomFieldEntityType;
  entityId: string;
};

export function CustomFieldsSection({
  entityType,
  entityId,
}: Readonly<CustomFieldsSectionProps>) {
  const [open, setOpen] = useState(false);
  const { data: fields } = useCustomFieldsForEntityType(entityType);

  if (fields.length === 0) {
    return null;
  }

  return (
    <CollapsibleSection
      onOpenChange={setOpen}
      open={open}
      title="Custom Fields"
    >
      {fields.map((field) => (
        <CustomFieldValueEditor
          entityId={entityId}
          entityType={entityType}
          key={field.id}
          setting={{
            id: field.id,
            customFieldId: field.id,
            entityType,
            entityId,
            isImportant: false,
            isRequired: false,
            sortOrder: 0,
            createdAt: field.createdAt,
            customField: { ...field, enumOptions: [] },
          }}
        />
      ))}
    </CollapsibleSection>
  );
}
