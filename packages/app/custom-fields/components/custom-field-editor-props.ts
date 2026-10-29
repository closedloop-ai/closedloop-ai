import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { CustomFieldEntityType } from "@repo/api/src/types/custom-field";

/** What every detail-panel editor needs to name the row it writes to. */
export type BaseEditorProps = {
  fieldId: string;
  entityType: CustomFieldEntityType;
  entityId: string;
  surface?: ArtifactStatusEditSurface;
};
