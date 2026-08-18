"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { PanelRightIcon } from "lucide-react";
import { useState } from "react";
import { AppShell } from "./components/app-shell";
import { SessionDetailView } from "./components/session-detail";
import { SessionsList } from "./components/sessions-list";
import type { SessionRow } from "./mock";
import { buildSessionDetail } from "./mock-detail";

const SessionsPrototypePage = () => {
  const [selected, setSelected] = useState<SessionRow | null>(null);
  const [commentsCollapsed, setCommentsCollapsed] = useState(false);
  if (selected) {
    const detail = buildSessionDetail(selected);
    return (
      <AppShell
        actions={
          <Button
            aria-label={
              commentsCollapsed ? "Show comments panel" : "Hide comments panel"
            }
            aria-pressed={!commentsCollapsed}
            onClick={() => setCommentsCollapsed((value) => !value)}
            size="icon-sm"
            title={
              commentsCollapsed ? "Show comments panel" : "Hide comments panel"
            }
            type="button"
            variant="ghost"
          >
            <PanelRightIcon aria-hidden />
          </Button>
        }
        breadcrumbs={[
          { label: "Sessions", onSelect: () => setSelected(null) },
          { label: selected.name, isCurrent: true },
        ]}
      >
        <SessionDetailView
          commentsCollapsed={commentsCollapsed}
          detail={detail}
        />
      </AppShell>
    );
  }

  return (
    <AppShell breadcrumbs={[{ label: "Sessions", isCurrent: true }]}>
      <SessionsList onOpenDetail={setSelected} />
    </AppShell>
  );
};

export default SessionsPrototypePage;
