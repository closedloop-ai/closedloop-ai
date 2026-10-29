import type {
  DetailsField,
  DetailsFieldId,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import {
  automaticField,
  readOnlyField,
} from "@repo/app/shared/lib/details-field-constructors";

/** The Session Details host's field constructors (ISS-12197). */

export function textField(
  id: DetailsFieldId,
  label: string,
  text: string | null | undefined
): DetailsField<DetailsFieldId> {
  return readOnlyField(id, label, { kind: "text", text: text ?? "" });
}

export function derivedTextField(
  id: DetailsFieldId,
  label: string,
  text: string | null | undefined,
  mono = false
): DetailsField<DetailsFieldId> {
  return automaticField(id, label, { kind: "text", mono, text: text ?? "" });
}
