"use client";
import { PrototypeDetail } from "@repo/app/shell/v2/components/prototypes-preview/components/prototype-detail";
import { AvatarStack } from "@repo/app/shell/v2/components/prototypes-preview/components/prototype-people";
import {
  type PrototypeRow,
  prototypes,
} from "@repo/app/shell/v2/components/prototypes-preview/mock";
import { Button } from "@repo/design-system/components/ui/button";
import {
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@repo/design-system/components/ui/primitives/underline-tabs";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { Tabs } from "@repo/design-system/components/ui/tabs";
import { useMediaQuery } from "@repo/design-system/hooks/use-media-query";
import { PanelRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PrototypeStatus } from "@/lib/registry";
import { AppShell } from "./components/app-shell";
import { PrototypesTable } from "./components/prototypes-table";
export default function PrototypesPage() {
  const [prototypeRows, setPrototypeRows] = useState<PrototypeRow[]>([
    ...prototypes,
  ]);
  const [selected, setSelected] = useState<PrototypeRow | null>(null);
  const [commentsOpen, setCommentsOpen] = useState(true);
  const [activeTab, setActiveTab] = useState("preview");
  const constrainedReview = useMediaQuery("(max-width: 1279px)");
  const updatePrototype = useCallback((nextPrototype: PrototypeRow) => {
    setSelected(nextPrototype);
    setPrototypeRows((current) =>
      current.map((item) =>
        item.id === nextPrototype.id ? nextPrototype : item
      )
    );
  }, []);

  useEffect(() => {
    if (constrainedReview && selected) {
      setCommentsOpen(false);
    }
  }, [constrainedReview, selected]);

  if (!selected) {
    return (
      <AppShell breadcrumbs={[{ label: "Prototypes", isCurrent: true }]}>
        <PrototypeList items={prototypeRows} onOpen={setSelected} />
      </AppShell>
    );
  }

  return (
    <Tabs className="contents" onValueChange={setActiveTab} value={activeTab}>
      <AppShell
        actions={
          activeTab === "preview" ? (
            <Button
              aria-controls="prototype-comments-rail"
              aria-expanded={commentsOpen}
              aria-label="Toggle comments panel"
              onClick={() => setCommentsOpen((value) => !value)}
              size="icon-sm"
              variant="ghost"
            >
              <PanelRightIcon />
            </Button>
          ) : undefined
        }
        breadcrumbs={[
          { label: "Prototypes", onSelect: () => setSelected(null) },
          { label: selected.name, isCurrent: true },
        ]}
        subheader={
          <UnderlineTabsList className="w-full shrink-0 pt-0">
            <UnderlineTabsTrigger value="preview">
              Prototype
            </UnderlineTabsTrigger>
            <UnderlineTabsTrigger value="details">Details</UnderlineTabsTrigger>
            <div className="ml-auto flex items-center pl-4">
              <AvatarStack
                people={[selected.owner, ...selected.collaborators]}
              />
            </div>
          </UnderlineTabsList>
        }
      >
        <PrototypeDetail
          commentsOpen={commentsOpen}
          onCommentsOpenChange={setCommentsOpen}
          onPreviewRequested={() => setActiveTab("preview")}
          onPrototypeChange={updatePrototype}
          prototype={selected}
        />
      </AppShell>
    </Tabs>
  );
}

function PrototypeList({
  items,
  onOpen,
}: {
  items: PrototypeRow[];
  onOpen: (prototype: PrototypeRow) => void;
}) {
  const [sortBy, setSortBy] = useState("featured");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const visible = useMemo(() => {
    return [...items].sort((a, b) =>
      comparePrototypeRows(a, b, sortBy, sortDir)
    );
  }, [items, sortBy, sortDir]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <PrototypesTable
          items={visible}
          onOpenDetail={onOpen}
          onSort={(column, direction) => {
            setSortBy(column);
            setSortDir(direction);
          }}
          sortBy={sortBy}
          sortDir={sortDir}
        />
      </div>
    </div>
  );
}

function comparePrototypeRows(
  a: PrototypeRow,
  b: PrototypeRow,
  sortBy: string,
  sortDir: SortDirection
): number {
  if (sortBy === "featured") {
    return compareFeaturedPrototypes(a, b);
  }
  const aValue = prototypeSortValue(a, sortBy);
  const bValue = prototypeSortValue(b, sortBy);
  const direction = sortDir === "asc" ? 1 : -1;
  if (aValue < bValue) {
    return -1 * direction;
  }
  if (aValue > bValue) {
    return direction;
  }
  return 0;
}

function compareFeaturedPrototypes(a: PrototypeRow, b: PrototypeRow): number {
  if (a.id === "branches-v2") {
    return -1;
  }
  if (b.id === "branches-v2") {
    return 1;
  }
  return a.name.localeCompare(b.name);
}

function prototypeSortValue(
  item: PrototypeRow,
  sortBy: string
): string | number {
  switch (sortBy) {
    case "owner":
      return item.owner.name;
    case "tags":
      return item.tags.join(" ");
    case "status":
      return [
        PrototypeStatus.Draft,
        PrototypeStatus.InProgress,
        PrototypeStatus.ReadyForReview,
        PrototypeStatus.HandedOff,
      ].indexOf(item.status);
    case "version":
      return item.version;
    case "comments":
      return item.openComments;
    case "updated":
      return item.updatedAt;
    default:
      return item.name;
  }
}
