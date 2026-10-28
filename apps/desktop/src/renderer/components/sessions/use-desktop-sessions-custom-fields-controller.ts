import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import type { SessionsCustomFieldsController } from "@repo/app/agents/components/sessions/sessions-list-custom-fields";
import { useSessionsCustomFieldsController } from "@repo/app/agents/hooks/use-sessions-custom-fields-controller";
import { useMemo } from "react";
import { withoutCustomFieldDefinitionWrites } from "../../shared/without-custom-field-definition-writes";

/**
 * ISS-12455: the desktop Sessions list's half of the custom-field columns.
 *
 * The opt-in follows the selected rows' `customFields` operand. A mixed
 * composite page may contain cloud and local rows, so app mode alone cannot
 * establish that the column has data to render.
 *
 * Field-DEFINITION writes stay off even in cloud mode: the bridge admits
 * `POST /custom-fields` and `PUT /custom-fields/[id]` (for Documents'
 * custom-field-settings surface — `cloud-api-fetch-document-routes.ts`, and
 * the path-only allowlist has no notion of which surface issued the request),
 * so this is NOT a path the gateway refuses. It stays off because ISS-12455
 * left "should Add Field be offered on Desktop?" an open question for a human
 * to decide, not because the write would fail. Stripping `onCreateField` (and
 * the two inputs only it feeds) is what makes `resolveAddFieldAction` drop the
 * "Add field" affordance until that's decided.
 */
export function useDesktopSessionsCustomFieldsController(
  hasCustomFieldOperands: boolean,
  items: readonly AgentSessionListItem[]
): SessionsCustomFieldsController | undefined {
  const controller = useSessionsCustomFieldsController(items, {
    enabled: hasCustomFieldOperands,
  });
  return useMemo(
    () =>
      controller ? withoutCustomFieldDefinitionWrites(controller) : undefined,
    [controller]
  );
}
