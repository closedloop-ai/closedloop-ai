"use client";

// Grid Table Toolbar v2 promotion candidate, derived from the approved Generic
// Artifact prototype's list controls.

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@closedloop-ai/design-system/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import { Input } from "@closedloop-ai/design-system/components/ui/input";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { BookmarkIcon, CheckIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import {
  type TableSavedView,
  TableSavedViewScope,
} from "./table-toolbar-model";

/** The scope sections, in the order the menu lists them. */
const SAVED_VIEW_SCOPE_SECTIONS: readonly {
  label: string;
  scope: TableSavedViewScope;
}[] = [
  { scope: TableSavedViewScope.Personal, label: "Personal views" },
  { scope: TableSavedViewScope.Team, label: "Team views" },
  { scope: TableSavedViewScope.Project, label: "Project views" },
];

/**
 * The toolbar's saved-views control: apply a named view, or save the current
 * filter / sort / grouping / column configuration as a new one.
 *
 * The trigger shows the ACTIVE view's name rather than a static "Views", so the
 * toolbar answers "what am I looking at" without being opened — the single most
 * useful thing a saved-views control can do, and the reason it sits in the
 * toolbar rather than a page menu.
 *
 * A scope section with no views renders nothing at all, so an organization that
 * only uses personal views never sees two empty headings.
 *
 * This is the prototype's lighter apply-or-save menu: it has no update,
 * rename, delete or modified indicator. The select-shaped switcher that had
 * those lost its last mounts, in both Branches toolbars, in ISS-10209 (#7257)
 * and was deleted by ISS-11562, so this menu is the only saved-views control.
 */
export function TableSavedViewsMenu({
  activeViewId,
  align = "end",
  onApply,
  onSave,
  views,
}: {
  /** Currently applied view, or `null` when the configuration is unsaved. */
  activeViewId: string | null;
  align?: "start" | "center" | "end";
  onApply: (viewId: string) => void;
  onSave: (name: string) => void;
  views: readonly TableSavedView[];
}) {
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const nameInputId = useId();
  const activeName = views.find((view) => view.id === activeViewId)?.name;
  const trimmedName = name.trim();

  const closeSaveDialog = () => {
    setName("");
    setSaveOpen(false);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            <BookmarkIcon />
            {activeName ?? "Views"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-64 p-2">
          {SAVED_VIEW_SCOPE_SECTIONS.map((section, index) => {
            const scopedViews = views.filter(
              (view) => view.scope === section.scope
            );
            if (scopedViews.length === 0) {
              return null;
            }
            return (
              <div key={section.scope}>
                {index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel className="text-muted-foreground">
                  {section.label}
                </DropdownMenuLabel>
                {scopedViews.map((view) => (
                  <DropdownMenuItem
                    className="gap-2"
                    key={view.id}
                    onSelect={() => onApply(view.id)}
                  >
                    {/* Always rendered, only faded when inactive: a checkmark
                        that appears and disappears shifts every label in the
                        list sideways as the selection moves. */}
                    <CheckIcon
                      className={cn(
                        "size-3.5",
                        view.id === activeViewId ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="truncate">{view.name}</span>
                  </DropdownMenuItem>
                ))}
              </div>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSaveOpen(true)}>
            <PlusIcon />
            Save current view
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        onOpenChange={(open) => (open ? setSaveOpen(true) : closeSaveDialog())}
        open={saveOpen}
      >
        <DialogContent className="gap-0 p-0 sm:max-w-md">
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>Save current view</DialogTitle>
            <DialogDescription>
              Save filters, sorting, grouping, metrics, and columns as a
              personal view.
            </DialogDescription>
          </DialogHeader>
          <div className="px-5 py-5">
            <label className="space-y-2 text-sm" htmlFor={nameInputId}>
              <span className="font-medium">View name</span>
              <Input
                id={nameInputId}
                onChange={(event) => setName(event.target.value)}
                placeholder="My view"
                value={name}
              />
            </label>
          </div>
          <DialogFooter className="border-t px-5 py-3">
            <Button onClick={closeSaveDialog} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={trimmedName.length === 0}
              onClick={() => {
                onSave(trimmedName);
                closeSaveDialog();
              }}
            >
              Save view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
