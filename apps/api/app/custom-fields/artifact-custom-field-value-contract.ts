/** Expected artifact custom-field write failures exposed to route adapters. */
export const ArtifactCustomFieldValueErrorKind = {
  EntityNotFound: "entity_not_found",
  FieldNotFound: "field_not_found",
  InvalidValue: "invalid_value",
} as const;

export type ArtifactCustomFieldValueError = {
  kind:
    | typeof ArtifactCustomFieldValueErrorKind.EntityNotFound
    | typeof ArtifactCustomFieldValueErrorKind.FieldNotFound
    | typeof ArtifactCustomFieldValueErrorKind.InvalidValue;
  message: string;
};
