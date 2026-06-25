import {
  CompatibilityMappingField,
  type CompatibilityMappingField as CompatibilityMappingFieldName,
} from "../scripts/check-schema-update-gates";

export type CompatibilityAttributesSourceOptions = {
  includeNewAttribute: boolean;
  includeExistingMapping?: boolean;
  existingMappingFields?: CompatibilityMappingFields;
  mappingFields?: CompatibilityMappingFields;
};

type CompatibilityMappingFields = Record<CompatibilityMappingFieldName, string>;

const DefaultExistingMappingFields = {
  [CompatibilityMappingField.Producer]: "apps/api/lib/route-utils.ts",
  [CompatibilityMappingField.SourceField]: "duration_ms",
  [CompatibilityMappingField.Reason]: "Existing route telemetry producer.",
} as const satisfies CompatibilityMappingFields;

export function compatibilityAttributesSource(
  options: CompatibilityAttributesSourceOptions
): string {
  const existingMappingFields =
    options.existingMappingFields ?? DefaultExistingMappingFields;
  const existingMapping =
    options.includeExistingMapping === false
      ? ""
      : `
  [TelemetryAttribute.DurationMs]: {
    ${CompatibilityMappingField.Producer}: "${existingMappingFields[CompatibilityMappingField.Producer]}",
    ${CompatibilityMappingField.SourceField}: "${existingMappingFields[CompatibilityMappingField.SourceField]}",
    ${CompatibilityMappingField.Reason}: "${existingMappingFields[CompatibilityMappingField.Reason]}",
  },`;
  const newAttributeValue = options.includeNewAttribute
    ? '  NewAttribute: "closedloop.new_attribute",'
    : "";
  const compatibilityValue = options.includeNewAttribute
    ? "  NewAttribute: TelemetryAttribute.NewAttribute,"
    : "";
  const newMapping = options.mappingFields
    ? `
  [TelemetryAttribute.NewAttribute]: {
    ${CompatibilityMappingField.Producer}: "${options.mappingFields[CompatibilityMappingField.Producer]}",
    ${CompatibilityMappingField.SourceField}: "${options.mappingFields[CompatibilityMappingField.SourceField]}",
    ${CompatibilityMappingField.Reason}: "${options.mappingFields[CompatibilityMappingField.Reason]}",
  },`
    : "";

  return `
export const TelemetryAttribute = {
  DurationMs: "duration_ms",
${newAttributeValue}
} as const;

export const ClosedLoopCompatibilityAttribute = {
  DurationMs: TelemetryAttribute.DurationMs,
${compatibilityValue}
} as const;

export const CompatibilityAttributeProducerMapping = {${existingMapping}${newMapping}
} as const satisfies Record<string, { ${CompatibilityMappingField.Producer}: string; ${CompatibilityMappingField.SourceField}: string; ${CompatibilityMappingField.Reason}: string }>;
`;
}
