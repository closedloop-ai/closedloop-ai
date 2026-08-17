"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { RefreshCcwIcon, StarIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SessionDetailView } from "@/app/p/sessions/components/session-detail";
import { SessionsList } from "@/app/p/sessions/components/sessions-list";
import { type SessionRow, sessionRows } from "@/app/p/sessions/mock";
import { buildSessionDetail } from "@/app/p/sessions/mock-detail";
import { PageChrome } from "../components/page-chrome";

// The blessed Sessions surface (app/p/sessions), hosted as a subpage of the
// Web Master shell: same list/detail components and mock data, with the
// page-level chrome rendered into the master layout instead of a private
// AppShell.
const WebMasterSessionsPage = () => {
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
    const detail = buildSessionDetail(selected);
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
        <SessionDetailView detail={detail} />
      </PageChrome>
    );
  }

  return (
    <PageChrome
      actions={<RefreshButton />}
      breadcrumbs={[{ label: "Sessions", isCurrent: true }]}
    >
      <SessionsList onOpenDetail={setSelected} />
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

export default WebMasterSessionsPage;
