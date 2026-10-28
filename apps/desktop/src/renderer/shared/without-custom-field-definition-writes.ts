/**
 * ISS-12455: the one rule both desktop list controllers apply — field-DEFINITION
 * writes stay off on Desktop while "should Add Field be offered on Desktop?" is
 * an open question for a human, and value edits stay wired. Shared by the
 * Sessions and Branches lists (ISS-12663) so the two cannot answer it
 * differently.
 *
 * The bridge actually admits `POST /custom-fields` and `PUT /custom-fields/[id]`
 * (for Documents), so this is a product choice left to a human, not a route the
 * gateway would refuse. Stripping `onCreateField` (and the two inputs only it
 * feeds) is what drops the Add field affordance.
 */
export function withoutCustomFieldDefinitionWrites<
  T extends {
    availableFields?: unknown;
    onAddExistingField?: unknown;
    onCreateField?: unknown;
  },
>(
  controller: T
): Omit<T, "availableFields" | "onAddExistingField" | "onCreateField"> {
  const { onCreateField, onAddExistingField, availableFields, ...rest } =
    controller;
  return rest;
}
