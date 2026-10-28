"use client";

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { CustomFieldDetailsRowsScope } from "@repo/app/custom-fields/components/custom-field-details-rows-scope";
import type { DetailsField } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import type { ReactNode } from "react";
import {
  AgentSessionCapability,
  agentSessionSourceSupports,
} from "../../data-source/agent-sessions-data-source";
import { useAgentSessionsDataSourceOptional } from "../../data-source/provider";
import { sessionTitle } from "../../lib/session-title";

/**
 * The Session Details tab's custom-field rows (ISS-12302), read through the
 * active source's optional `customFieldValues`. Desktop Local mode's source
 * has none, so it draws no Custom fields section and reads nothing.
 */
export function SessionShellCustomFieldRows({
  children,
  session,
}: Readonly<{
  children: (rows: readonly DetailsField[]) => ReactNode;
  session: AgentSessionDetail;
}>) {
  const source = useAgentSessionsDataSourceOptional();
  const readValues =
    source &&
    agentSessionSourceSupports(
      source,
      session.id,
      AgentSessionCapability.CustomFieldValues
    )
      ? source.customFieldValues
      : undefined;
  return (
    <CustomFieldDetailsRowsScope
      entityId={session.id}
      entityType={CustomFieldEntityType.Session}
      itemLabel={sessionTitle(session)}
      readValues={readValues}
    >
      {children}
    </CustomFieldDetailsRowsScope>
  );
}
