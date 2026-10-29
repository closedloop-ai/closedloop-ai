import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { makeCustomFieldValuesHandlers } from "@/app/custom-fields/custom-field-values-handlers";

const handlers = makeCustomFieldValuesHandlers(CustomFieldEntityType.Session);

export const { PUT, DELETE } = handlers;
