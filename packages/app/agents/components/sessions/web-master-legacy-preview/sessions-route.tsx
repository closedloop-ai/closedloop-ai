"use client";

import { SessionsPrototypeDetailPreview } from "@repo/app/agents/components/sessions/sessions-prototype-preview";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { RefreshCcwIcon, StarIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PageChrome } from "../../../../shell/v2/components/web-master-preview/components/page-chrome"; // Cross-slice: mounted inside the Web Master preview shell (ISS-12938).
import { type SessionRow, sessionRows } from "./mock";
import {
  prototypeSessionIndex,
  toPrototypeSessionItem,
} from "./production-detail";
import { SessionsV2Surface } from "./sessions-v2-surface";

// Sessions as a subpage of the Web Master shell. The list is the shared
// Sessions surface fed the legacy mock, and the detail is the production
// `AgentSessionDetailView` app/p/sessions mounts, built from the same row.
export const WebMasterSessionsRoute = () => {
  const [selected, setSelected] = useState<SessionRow | null>(null);
  // One favorites source for the whole surface, so a star set in the grid reads
  // the same when the session is opened (and vice versa).
  const [favorites, setFavorites] = useState<Set<string>>(
    () =>
      new Set(sessionRows.filter((row) => row.isFavorite).map((row) => row.id))
  );
  const toggleFavorite = (id: string) =>
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  if (selected) {
    return (
      <PageChrome
        actions={<RefreshButton />}
        breadcrumbs={[
          { label: "Sessions", onSelect: () => setSelected(null) },
          { label: selected.name, isCurrent: true },
        ]}
        leadingAction={
          <FavoriteButton
            isFavorite={favorites.has(selected.id)}
            name={selected.name}
            onToggle={() => toggleFavorite(selected.id)}
          />
        }
      >
        <SessionsPrototypeDetailPreview
          backHref={WEB_MASTER_SESSIONS_PATH}
          index={prototypeSessionIndex(selected)}
          item={toPrototypeSessionItem(selected)}
        />
      </PageChrome>
    );
  }

  return (
    <PageChrome
      actions={<RefreshButton />}
      breadcrumbs={[{ label: "Sessions", isCurrent: true }]}
    >
      <SessionsV2Surface onOpenDetail={setSelected} />
    </PageChrome>
  );
};

// Mock refresh: brief spinning/disabled state so the control does something
// observable rather than being an enabled no-op (no real data to refetch here).
function RefreshButton() {
  const [refreshing, setRefreshing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    []
  );

  const onClick = () => {
    if (refreshing) {
      return;
    }
    setRefreshing(true);
    timer.current = setTimeout(() => setRefreshing(false), 900);
  };

  return (
    <Button
      disabled={refreshing}
      onClick={onClick}
      size="sm"
      type="button"
      variant="outline"
    >
      <RefreshCcwIcon
        className={cn("size-3.5", refreshing && "animate-spin")}
      />
      {refreshing ? "Refreshing…" : "Refresh"}
    </Button>
  );
}

function FavoriteButton({
  isFavorite,
  name,
  onToggle,
}: {
  isFavorite: boolean;
  name: string;
  onToggle: () => void;
}) {
  return (
    <Button
      aria-label={isFavorite ? `Unfavorite ${name}` : `Favorite ${name}`}
      aria-pressed={isFavorite}
      onClick={onToggle}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      <StarIcon
        className={cn("size-4", isFavorite && "fill-current text-warning")}
      />
    </Button>
  );
}

const WEB_MASTER_SESSIONS_PATH = "/p/web-master/sessions";
