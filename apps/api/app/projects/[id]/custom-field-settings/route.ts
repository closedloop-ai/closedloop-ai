import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { makeCustomFieldSettingsHandlers } from "@/app/custom-fields/custom-field-settings-handlers";

const handlers = makeCustomFieldSettingsHandlers(CustomFieldEntityType.Project);

/**
 * Attaching to a Project cascades the field to every child feature document —
 * a paged write bounded by `CASCADE_TX_TIMEOUT_MS` and retried on a
 * serialization conflict. The platform default ceiling is well under that
 * budget, so without this the function is terminated before the transaction
 * window it was raised to use, and the large tenants the paging fix targets
 * trade a P2028 for a 504. The Document route does not cascade.
 */
export const maxDuration = 300;

export const { POST, GET } = handlers;
