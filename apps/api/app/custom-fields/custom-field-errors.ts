/** Raised when a custom-field entity is missing or outside the organization. */
export class EntityNotFoundError extends Error {
  constructor(entityType: string, entityId: string) {
    super(`${entityType} with id "${entityId}" not found.`);
    this.name = "EntityNotFoundError";
  }
}

/** Raised when a custom field does not belong to the organization. */
export class FieldNotFoundError extends Error {
  constructor(fieldId: string) {
    super(`Custom field with id "${fieldId}" not found.`);
    this.name = "FieldNotFoundError";
  }
}
