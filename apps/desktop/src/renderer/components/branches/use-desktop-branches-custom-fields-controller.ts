import { useBranchesCustomFieldsController } from "@repo/app/branches/hooks/use-branches-custom-fields-controller";
import type { BranchRow } from "@repo/app/branches/lib/branch-row";
import type { EntityListCustomFieldsController } from "@repo/app/custom-fields/hooks/use-entity-list-custom-fields-controller";
import { useMemo } from "react";
import { withoutCustomFieldDefinitionWrites } from "../../shared/without-custom-field-definition-writes";

/**
 * ISS-12663: the desktop Branches list's half of the custom-field columns, the
 * same "mode, not surface" opt-in the desktop Sessions list uses
 * (`useDesktopSessionsCustomFieldsController`).
 *
 * Cloud mode's HTTP source carries `customFields` on every row; the local
 * store's rows carry none. Field-DEFINITION writes stay off on Desktop for the
 * reason the Sessions half gives: ISS-12455 left "should Add Field be offered on
 * Desktop?" an open question for a human, so this list does not decide it
 * differently from the Sessions list beside it. Values stay editable.
 */
export function useDesktopBranchesCustomFieldsController(
  isCloudMode: boolean,
  rows: readonly BranchRow[]
): EntityListCustomFieldsController | undefined {
  const controller = useBranchesCustomFieldsController(rows, {
    enabled: isCloudMode,
  });
  return useMemo(
    () =>
      controller ? withoutCustomFieldDefinitionWrites(controller) : undefined,
    [controller]
  );
}
