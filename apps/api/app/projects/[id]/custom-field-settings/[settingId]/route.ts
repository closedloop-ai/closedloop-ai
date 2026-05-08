import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { makeCustomFieldSettingsHandlers } from "@/app/custom-fields/custom-field-settings-handlers";

const handlers = makeCustomFieldSettingsHandlers(CustomFieldEntityType.Project);

export const { DELETE } = handlers;
