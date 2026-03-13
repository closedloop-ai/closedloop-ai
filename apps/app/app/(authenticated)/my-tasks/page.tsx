"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { LayoutGridIcon, ListIcon } from "lucide-react";
import { Header } from "@/app/(authenticated)/components/header";
import { useCurrentUser } from "@/hooks/queries/use-users";
import { useLocalStorageState } from "@/hooks/use-local-storage-state";
import { MyTasksKanban } from "./components/my-tasks-kanban";
import { MyTasksList } from "./components/my-tasks-list";

const VIEW_KEY = "my-tasks-view";

export default function MyTasksPage() {
  const { data: currentUser, isLoading: isUserLoading } = useCurrentUser();
  const [view, setView] = useLocalStorageState<"list" | "card">(
    VIEW_KEY,
    "list"
  );

  const isListView = view === "list";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header breadcrumbs={[{ label: "My Tasks" }]} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="font-semibold text-lg tracking-tight">Pending Work</h2>
          <Button
            aria-label={
              isListView ? "Switch to card view" : "Switch to list view"
            }
            className="border border-input bg-transparent"
            onClick={() => setView(isListView ? "card" : "list")}
            variant="ghost"
          >
            {isListView ? (
              <>
                <LayoutGridIcon className="size-4" />
                <span className="hidden sm:inline">Card</span>
              </>
            ) : (
              <>
                <ListIcon className="size-4" />
                <span className="hidden sm:inline">List</span>
              </>
            )}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {view === "list" ? (
            <MyTasksList
              assigneeId={currentUser?.id ?? null}
              isUserLoading={isUserLoading}
            />
          ) : (
            <MyTasksKanban
              assigneeId={currentUser?.id ?? null}
              isUserLoading={isUserLoading}
            />
          )}
        </div>
      </div>
    </div>
  );
}
