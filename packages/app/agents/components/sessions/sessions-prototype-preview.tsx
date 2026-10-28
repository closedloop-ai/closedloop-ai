"use client";

import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { AgentSessionDetailView } from "@repo/app/agents/components/detail/agent-session-detail-view";
import { SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { PrototypeShell } from "@repo/app/shell/v2/components/prototype-shell";
import {
  TableChoiceListCell,
  TableReferenceListCell,
} from "@repo/design-system/components/ui/table-cell-list-primitives";
import { usePath } from "@repo/navigation/use-path";
import { useMemo, useState } from "react";
import { renderSessionPriorityCell } from "./session-priority-cell";
import { renderSessionTagsCell } from "./session-tags-cell";
import { SessionsListSurfaceV2Preview } from "./sessions-list-surface-v2-demo";
import {
  createSessionsPrototypeApiRoutes,
  createSessionsPrototypeDetailFromItem,
  SESSIONS_PROTOTYPE_DETAILS,
  SESSIONS_PROTOTYPE_FAVORITE_IDS,
  SESSIONS_PROTOTYPE_ISSUES,
  SESSIONS_PROTOTYPE_PROJECTS,
  SESSIONS_PROTOTYPE_ROWS,
  SESSIONS_PROTOTYPE_TOTAL_ROWS,
  SESSIONS_PROTOTYPE_USAGE,
} from "./sessions-prototype-preview-fixtures";

const SESSIONS_PATH = "/sessions";

/** Production-bound Sessions prototype composed entirely from canonical surfaces. */
export function SessionsPrototypePreview() {
  const [apiRoutes] = useState(createSessionsPrototypeApiRoutes);
  return (
    <AppCoreStoryProviders
      apiRoutes={apiRoutes}
      enabledFlags={SESSIONS_PROTOTYPE_ENABLED_FLAGS}
    >
      <PrototypeShell
        activePath={SESSIONS_PATH}
        breadcrumbs={resolveSessionsPrototypeBreadcrumbs}
        contentClassName="overflow-hidden p-0"
      >
        <SessionsPrototypePreviewContent />
      </PrototypeShell>
    </AppCoreStoryProviders>
  );
}

function SessionsPrototypePreviewContent() {
  const currentPath = usePath();
  const selectedSession = resolveSessionsPrototypeDetail(currentPath);

  if (selectedSession) {
    return (
      <AgentSessionDetailView
        backHref={SESSIONS_PATH}
        isLoading={false}
        session={selectedSession}
      />
    );
  }

  return (
    <SessionsListSurfaceV2Preview
      initialFavoriteIds={SESSIONS_PROTOTYPE_FAVORITE_IDS}
      rows={SESSIONS_PROTOTYPE_ROWS}
      surfaceProps={{
        className: "min-h-0 flex-1",
        getSessionHref: (row) => `${SESSIONS_PATH}/${row.id}`,
        renderIssues: (row) => (
          <TableReferenceListCell
            references={SESSIONS_PROTOTYPE_ISSUES.get(row.id) ?? []}
          />
        ),
        // The same seams both production hosts supply, so the prototype
        // renders the Priority and Tags columns users get.
        renderPriority: renderSessionPriorityCell,
        renderProjects: (row) => (
          <TableChoiceListCell
            choices={SESSIONS_PROTOTYPE_PROJECTS.get(row.id) ?? []}
          />
        ),
        renderTags: renderSessionTagsCell,
      }}
      totalRows={SESSIONS_PROTOTYPE_TOTAL_ROWS}
      usage={SESSIONS_PROTOTYPE_USAGE}
    />
  );
}

function resolveSessionsPrototypeBreadcrumbs(currentPath: string) {
  const selectedSession = resolveSessionsPrototypeDetail(currentPath);
  if (!selectedSession) {
    return [{ isCurrent: true, label: "Sessions" }] as const;
  }
  return [
    { href: SESSIONS_PATH, label: "Sessions" },
    {
      isCurrent: true,
      label: selectedSession.name ?? selectedSession.id,
    },
  ] as const;
}

function resolveSessionsPrototypeDetail(currentPath: string) {
  const sessionId = currentPath.startsWith(`${SESSIONS_PATH}/`)
    ? currentPath.slice(SESSIONS_PATH.length + 1)
    : "";
  return SESSIONS_PROTOTYPE_DETAILS.get(sessionId);
}

/**
 * The production Session detail inside the prototype's fixture providers, for a
 * sandbox route that hosts its own list (Web Master). The detail is projected
 * from the caller's own list item, so the list and the detail stay one session.
 */
export function SessionsPrototypeDetailPreview({
  backHref,
  index,
  item,
}: Readonly<{
  backHref: string;
  index: number;
  item: SessionsPrototypeDetailItem;
}>) {
  const [apiRoutes] = useState(createSessionsPrototypeApiRoutes);
  const session = useMemo(
    () => createSessionsPrototypeDetailFromItem(item, index),
    [index, item]
  );
  return (
    <AppCoreStoryProviders apiRoutes={apiRoutes}>
      <AgentSessionDetailView
        backHref={backHref}
        isLoading={false}
        session={session}
      />
    </AppCoreStoryProviders>
  );
}

/** The list item a sandbox route hands {@link SessionsPrototypeDetailPreview}. */
export type SessionsPrototypeDetailItem = Partial<AgentSessionListItem> & {
  id: string;
};

/**
 * The prototype mounts the Tags seam both production hosts pass, and the column
 * only renders behind its gate, so the static preview adapter opens it.
 */
const SESSIONS_PROTOTYPE_ENABLED_FLAGS = [
  SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY,
] as const;
