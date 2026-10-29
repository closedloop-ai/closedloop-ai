import type {
  DetailsField,
  DetailsFieldId,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import { automaticField } from "@repo/app/shared/lib/details-field-constructors";

/** The Branch Details host's field constructors (ISS-12197). */

export function automaticTextField(
  id: DetailsFieldId,
  label: string,
  text: string | null | undefined,
  mono = false
): DetailsField<DetailsFieldId> {
  return automaticField(id, label, { kind: "text", mono, text: text ?? "" });
}
