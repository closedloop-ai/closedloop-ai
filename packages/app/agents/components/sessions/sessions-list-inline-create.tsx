"use client";

import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import type { GridTableV2Group } from "@repo/design-system/components/ui/grid-table-v2";
import { toast } from "@repo/design-system/components/ui/sonner";
import { TableInlineCreateRow } from "@repo/design-system/components/ui/table-inline-create-row";
import { useState } from "react";
import type {
  SessionsInlineCreateContext,
  SessionsInlineCreateController,
} from "./sessions-list-interactions";

export function useSessionsInlineCreate({
  controller,
  gridTemplateColumns,
  isGrouped,
}: {
  controller?: SessionsInlineCreateController;
  gridTemplateColumns: string;
  isGrouped: boolean;
}) {
  const [context, setContext] = useState<SessionsInlineCreateContext | null>(
    null
  );
  const renderRow = (rowContext: SessionsInlineCreateContext) => (
    <SessionsInlineCreateRow
      activeContext={context}
      context={rowContext}
      controller={controller}
      gridTemplateColumns={gridTemplateColumns}
      onActiveContextChange={setContext}
    />
  );
  return {
    renderAfterGroup: controller
      ? (group: GridTableV2Group<SessionTableRow>) =>
          renderRow({ groupKey: group.key })
      : undefined,
    renderAfterRows: controller && !isGrouped ? renderRow({}) : undefined,
  } as const;
}

function SessionsInlineCreateRow({
  activeContext,
  context,
  controller,
  gridTemplateColumns,
  onActiveContextChange,
}: {
  activeContext: SessionsInlineCreateContext | null;
  context: SessionsInlineCreateContext;
  controller?: SessionsInlineCreateController;
  gridTemplateColumns: string;
  onActiveContextChange: (context: SessionsInlineCreateContext | null) => void;
}) {
  if (!controller) {
    return null;
  }
  return (
    <TableInlineCreateRow
      // `activeContext !== null` FIRST: the ungrouped row's context is `{}`, so
      // optional chaining off a null active context compared `undefined ===
      // undefined` on both halves and reported the row active before anything
      // was activated — the input replaced the "Add session" affordance on first
      // paint and there was no way back to it.
      active={
        activeContext !== null && activeContext.groupKey === context.groupKey
      }
      gridTemplateColumns={gridTemplateColumns}
      label={controller.label ?? "Add session"}
      onActivate={() => onActiveContextChange(context)}
      onCancel={() => onActiveContextChange(null)}
      onCommit={(name) => {
        Promise.resolve(controller.onCreate(name, context)).catch(() =>
          toast.error("Couldn't create session")
        );
      }}
      placeholder={controller.placeholder ?? "Session name"}
    />
  );
}
