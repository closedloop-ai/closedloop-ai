"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@repo/design-system/components/ui/primitives/underline-tabs";
import { Tabs } from "@repo/design-system/components/ui/tabs";
import { PanelRightIcon } from "lucide-react";
import { useState } from "react";
import { AppShell } from "./components/app-shell";
import {
  BranchDetailTab,
  type BranchDetailTab as BranchDetailTabValue,
  BranchDetailView,
} from "./components/branch-detail";
import { BranchesList } from "./components/branches-list";
import type { BranchRow } from "./mock";
import { buildBranchDetail } from "./mock-detail";

const SessionBranchCommentsPrototypePage = () => {
  const [selected, setSelected] = useState<BranchRow | null>(null);
  const [activeTab, setActiveTab] = useState<BranchDetailTabValue>(
    BranchDetailTab.Details
  );
  const [commentsCollapsed, setCommentsCollapsed] = useState(false);

  const openDetail = (branch: BranchRow) => {
    setActiveTab(BranchDetailTab.Details);
    setSelected(branch);
  };
  const detail = selected ? buildBranchDetail(selected) : null;

  return (
    <Tabs
      className="h-svh w-full gap-0"
      onValueChange={(value) => setActiveTab(value as BranchDetailTabValue)}
      value={activeTab}
    >
      <AppShell
        actions={
          selected ? (
            <CommentsToggle
              collapsed={commentsCollapsed}
              onToggle={() => setCommentsCollapsed((value) => !value)}
            />
          ) : undefined
        }
        breadcrumbs={
          selected
            ? [
                { label: "Branches", onSelect: () => setSelected(null) },
                { label: selected.branchName, isCurrent: true },
              ]
            : [{ label: "Branches", isCurrent: true }]
        }
        navigation={
          selected ? (
            <UnderlineTabsList>
              <UnderlineTabsTrigger value={BranchDetailTab.Details}>
                Branch details
              </UnderlineTabsTrigger>
              <UnderlineTabsTrigger value={BranchDetailTab.Sessions}>
                Sessions &amp; timeline
              </UnderlineTabsTrigger>
            </UnderlineTabsList>
          ) : undefined
        }
      >
        {detail ? (
          <BranchDetailView
            activeTab={activeTab}
            commentsCollapsed={commentsCollapsed}
            detail={detail}
            key={detail.id}
          />
        ) : (
          <BranchesList onOpenDetail={openDetail} />
        )}
      </AppShell>
    </Tabs>
  );
};

function CommentsToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const label = collapsed ? "Show comments rail" : "Hide comments rail";

  return (
    <Button
      aria-label={label}
      aria-pressed={!collapsed}
      onClick={onToggle}
      size="icon-sm"
      title={label}
      type="button"
      variant="ghost"
    >
      <PanelRightIcon aria-hidden />
    </Button>
  );
}

export default SessionBranchCommentsPrototypePage;
