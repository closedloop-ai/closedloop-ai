"use client";

import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type {
  CustomFieldEntityType,
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { isDurationFormattedField } from "@repo/app/custom-fields/lib/duration-field";
import { CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { ScalarCustomFieldType } from "@repo/lib/custom-fields/custom-field-editor";
import { dateValueAsDate } from "@repo/lib/custom-fields/date-value";
import type { ReactNode } from "react";
import { useFeatureFlagEnabledOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import {
  DateFieldEditor,
  DurationFieldEditor,
  NumberFieldEditor,
  TextFieldEditor,
} from "./custom-field-scalar-value-editors";

/**
 * Which control each scalar type is edited with. Exhaustive over
 * {@link ScalarCustomFieldType} rather than over the three literals, so
 * promoting a field type to `Scalar` fails `tsc` here until this panel has a
 * control for it — the registry alone would have sent it to a `switch` that
 * silently rendered nothing.
 */
const SCALAR_CONTROL = {
  [CustomFieldType.Text]: "text",
  [CustomFieldType.Number]: "number",
  [CustomFieldType.Date]: "date",
} as const satisfies Record<ScalarCustomFieldType, string>;

type ScalarControl = (typeof SCALAR_CONTROL)[ScalarCustomFieldType];

const SCALAR_CONTROL_BY_FIELD_TYPE: Record<string, ScalarControl> =
  Object.assign(Object.create(null), SCALAR_CONTROL);

export type ScalarEditorRenderArgs = {
  customField: CustomFieldWithOptions;
  entityId: string;
  entityType: CustomFieldEntityType;
  surface?: ArtifactStatusEditSurface;
  /** The Details tab's save behavior (ISS-12302); absent on the Issue page. */
  inlineCommit?: boolean;
  isDurationField: boolean;
  value?: CustomFieldValueDetail;
};

/** The one TEXT / NUMBER / DATE / duration dispatch, for every panel. */
export function renderScalarCustomFieldEditor({
  customField,
  entityId,
  entityType,
  surface,
  inlineCommit,
  isDurationField,
  value,
}: ScalarEditorRenderArgs): ReactNode {
  if (isDurationField) {
    return (
      <DurationFieldEditor
        entityId={entityId}
        entityType={entityType}
        fieldId={customField.id}
        fieldName={customField.name}
        inlineCommit={inlineCommit}
        surface={surface}
        value={value}
      />
    );
  }

  const control = SCALAR_CONTROL_BY_FIELD_TYPE[customField.fieldType];
  switch (control) {
    case "text":
      return (
        <TextFieldEditor
          entityId={entityId}
          entityType={entityType}
          fieldId={customField.id}
          fieldName={customField.name}
          inlineCommit={inlineCommit}
          surface={surface}
          value={value}
        />
      );
    case "number":
      return (
        <NumberFieldEditor
          customLabel={customField.customLabel}
          customLabelPosition={customField.customLabelPosition}
          entityId={entityId}
          entityType={entityType}
          fieldId={customField.id}
          fieldName={customField.name}
          inlineCommit={inlineCommit}
          numberFormat={customField.numberFormat}
          precision={customField.precision}
          surface={surface}
          value={value}
        />
      );
    case "date":
      return (
        <DateFieldEditor
          entityId={entityId}
          entityType={entityType}
          fieldId={customField.id}
          initialValue={dateValueAsDate(value)}
          inlineCommit={inlineCommit}
          surface={surface}
        />
      );
    default:
      return assertNoUnhandledScalarControl(control);
  }
}

/**
 * A scalar field's editor as a component that reads the ISS-8213 duration
 * flag itself, for a host that renders one field rather than the Issue page's
 * panel (the Details tab, ISS-12302).
 */
export function CustomFieldScalarEditor({
  customField,
  entityId,
  entityType,
  surface,
  inlineCommit,
  value,
}: Readonly<Omit<ScalarEditorRenderArgs, "isDurationField">>) {
  const durationFormatEnabled = useFeatureFlagEnabledOptional(
    CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY
  );
  return renderScalarCustomFieldEditor({
    customField,
    entityId,
    entityType,
    surface,
    inlineCommit,
    isDurationField:
      durationFormatEnabled === true && isDurationFormattedField(customField),
    value,
  });
}

/** The scalar half of the editor-registry guard: a fourth control. */
function assertNoUnhandledScalarControl(control: never): never {
  throw new Error(`Unhandled scalar custom-field control: ${String(control)}`);
}
