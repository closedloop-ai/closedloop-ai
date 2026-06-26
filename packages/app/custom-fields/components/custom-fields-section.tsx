"use client";

import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
// biome-ignore lint/style/useImportType: runtime value used by callers and child components
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { useCustomFieldsForEntityType } from "@repo/app/custom-fields/hooks/use-custom-fields";
import { CollapsibleSection } from "@repo/design-system/components/ui/collapsible-section";
import { useState } from "react";
import { CustomFieldValueEditor } from "./custom-field-value-editor";

type CustomFieldsSectionProps = {
  entityType: CustomFieldEntityType;
  entityId: string;
  /** Resolved custom field values from the entity detail query. */
  values?: CustomFieldValueDetail[];
};

export function CustomFieldsSection({
  entityType,
  entityId,
  values,
}: Readonly<CustomFieldsSectionProps>) {
  const [open, setOpen] = useState(false);
  const { data: fields } = useCustomFieldsForEntityType(entityType);

  if (fields.length === 0) {
    return null;
  }

  const valueMap = new Map((values ?? []).map((v) => [v.customFieldId, v]));

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
            customField: field,
          }}
          value={valueMap.get(field.id)}
        />
      ))}
    </CollapsibleSection>
  );
}
