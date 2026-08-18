"use client";

import {
  ChevronDownIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useResponsiveModal } from "../../hooks/use-responsive-modal";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Input } from "./input";
import { Label } from "./label";

/**
 * A named view surfaced by the switcher: just its id + display name — the
 * generic switcher is presentational and never touches the caller's opaque
 * arrangement payload (FEA-4180).
 */
export type SavedViewOption = {
  id: string;
  name: string;
};

export type TableSavedViewsSwitcherProps = Readonly<{
  /** The saved views to list, in display order. */
  views: readonly SavedViewOption[];
  /** Active view id, or `null` when on the default (unnamed) arrangement. */
  activeViewId: string | null;
  /**
   * Whether the live table arrangement has DIVERGED from the active view's
   * saved snapshot (a column hidden, a filter changed, the window moved). When
   * `true` and a view is active, the trigger shows a "modified" marker and the
   * menu offers an "Update <name>" item so the label never claims a state the
   * table is not in. Ignored on the default arrangement. Callers that do not
   * track divergence omit it (defaults to `false`).
   */
  modified?: boolean;
  /** Switch to a saved view, or to the default arrangement (`null`). */
  onSelectView: (id: string | null) => void;
  /** Save the CURRENT arrangement as a new named view. */
  onCreateView: (name: string) => void;
  /**
   * Overwrite the active view with the CURRENT arrangement (the "Update <name>"
   * action). Omit to hide the update item — a surface that only supports
   * save-as-new leaves it out and users still get create + rename + delete.
   */
  onUpdateView?: (id: string) => void;
  /** Rename the view with `id`. */
  onRenameView: (id: string, name: string) => void;
  /** Delete the view with `id`. */
  onDeleteView: (id: string) => void;
  /** Label for the default (no saved view) entry. Defaults to "Default view". */
  defaultViewLabel?: string;
  /** Accessible name for the trigger. Defaults to "Saved views". */
  triggerLabel?: string;
  /**
   * Short concept prefix the trigger leads with so it reads as the view
   * IDENTITY ("Views: Default") rather than as another filter chip sitting
   * beside a "View"/"Columns" control. Defaults to "Views"; pass `null` to
   * render only the active view / default label with no prefix.
   */
  triggerValueLabel?: string | null;
}>;

type NameDialogState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "rename"; id: string; initialName: string };

const DEFAULT_TRIGGER_LABEL = "Saved views";
const DEFAULT_VIEW_LABEL = "Default view";
const DEFAULT_TRIGGER_VALUE_LABEL = "Views";

/**
 * Generic, domain-agnostic switcher for NAMED, switchable table views
 * (FEA-4180). Presentational only: it lists the caller's views, marks the
 * active one, and raises create / update / rename / switch / delete intents —
 * the caller owns the arrangement payload, its persistence, whether the live
 * table has diverged from the active view (`modified`), and applying a switched
 * view to the table. Composes the design-system `DropdownMenu` (the switcher
 * menu + a radio group so the active view reads as selected), the responsive
 * modal (name entry — a `Dialog` on desktop, a bottom `Sheet` under `sm`), and
 * `AlertDialog` (delete confirm), so it drops into any `GridTable` toolbar
 * unchanged.
 *
 * Accessibility: the trigger carries an explicit accessible name and
 * `aria-expanded` (via the Radix trigger), the active view is a checked radio
 * item, per-view actions live behind one labelled kebab menu, delete is
 * confirmed through an `AlertDialog`, and the create/rename dialog is a labelled
 * form submitted by Enter or the Save button — the whole control is
 * keyboard-operable.
 */
export function TableSavedViewsSwitcher({
  views,
  activeViewId,
  modified = false,
  onSelectView,
  onCreateView,
  onUpdateView,
  onRenameView,
  onDeleteView,
  defaultViewLabel = DEFAULT_VIEW_LABEL,
  triggerLabel = DEFAULT_TRIGGER_LABEL,
  triggerValueLabel = DEFAULT_TRIGGER_VALUE_LABEL,
}: TableSavedViewsSwitcherProps) {
  const [dialog, setDialog] = useState<NameDialogState>({ mode: "closed" });
  const [pendingDelete, setPendingDelete] = useState<SavedViewOption | null>(
    null
  );

  const activeView = views.find((view) => view.id === activeViewId) ?? null;
  const activeName = activeView ? activeView.name : defaultViewLabel;
  // Only a NAMED active view can be "modified" — the default arrangement has no
  // saved snapshot to diverge from.
  const isModified = modified && activeView !== null;
  // Lead the trigger with the concept ("Views: Default") so it reads as the
  // view identity rather than as another filter chip next to the columns menu.
  const triggerText = triggerValueLabel
    ? `${triggerValueLabel}: ${activeName}`
    : activeName;

  const handleSubmitName = (name: string) => {
    if (dialog.mode === "create") {
      onCreateView(name);
    } else if (dialog.mode === "rename") {
      onRenameView(dialog.id, name);
    }
    setDialog({ mode: "closed" });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={triggerLabel} asChild>
          <Button className="h-8 shadow-none" size="sm" variant="outline">
            <span className="max-w-48 truncate">{triggerText}</span>
            {isModified ? (
              // A quiet "modified" dot + word so the label never claims the
              // table is exactly on the saved view once the user has diverged.
              <span className="text-muted-foreground text-xs">• Modified</span>
            ) : null}
            <ChevronDownIcon className="size-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>{triggerLabel}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value) =>
              onSelectView(value === "" ? null : value)
            }
            value={activeViewId ?? ""}
          >
            <DropdownMenuRadioItem value="">
              {defaultViewLabel}
            </DropdownMenuRadioItem>
            {views.map((view) => (
              <SwitcherViewRow
                key={view.id}
                onDelete={() => setPendingDelete(view)}
                onRename={() =>
                  setDialog({
                    mode: "rename",
                    id: view.id,
                    initialName: view.name,
                  })
                }
                view={view}
              />
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          {isModified && activeView && onUpdateView ? (
            <DropdownMenuItem onSelect={() => onUpdateView(activeView.id)}>
              <PencilIcon />
              Update “{activeView.name}”
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => setDialog({ mode: "create" })}>
            <PlusIcon />
            Save as new view…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <SavedViewNameDialog
        onCancel={() => setDialog({ mode: "closed" })}
        onSubmit={handleSubmitName}
        state={dialog}
      />

      <DeleteViewConfirm
        onCancel={() => setPendingDelete(null)}
        onConfirm={(id) => {
          onDeleteView(id);
          setPendingDelete(null);
        }}
        view={pendingDelete}
      />
    </>
  );
}

function SwitcherViewRow({
  view,
  onRename,
  onDelete,
}: Readonly<{
  view: SavedViewOption;
  onRename: () => void;
  onDelete: () => void;
}>) {
  return (
    <div className="group/row flex items-center gap-1">
      {/* The radio item carries the active-view indicator (a filled dot) on its
          own, so the row shows the selected state once - no second checkmark. */}
      <DropdownMenuRadioItem className="min-w-0 flex-1" value={view.id}>
        <span className="min-w-0 flex-1 truncate">{view.name}</span>
      </DropdownMenuRadioItem>
      {/* One kebab per row, revealed on hover/focus, so the row name gets the
          menu width and the destructive delete sits behind a confirm — instead
          of two always-on icon buttons a click away from the switch target. */}
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={`Actions for ${view.name}`} asChild>
          <Button
            className="size-7 shrink-0 opacity-0 focus-visible:opacity-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
            size="icon"
            variant="ghost"
          >
            <MoreHorizontalIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onRename}>
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onDelete} variant="destructive">
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function DeleteViewConfirm({
  view,
  onConfirm,
  onCancel,
}: Readonly<{
  view: SavedViewOption | null;
  onConfirm: (id: string) => void;
  onCancel: () => void;
}>) {
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
      open={view !== null}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this view?</AlertDialogTitle>
          <AlertDialogDescription>
            {view
              ? `“${view.name}” will be removed. This can't be undone.`
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (view) {
                onConfirm(view.id);
              }
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function SavedViewNameDialog({
  state,
  onSubmit,
  onCancel,
}: Readonly<{
  state: NameDialogState;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}>) {
  const { Root, Content, Header, Footer, Title, Description } =
    useResponsiveModal();
  const [name, setName] = useState("");
  const isOpen = state.mode !== "closed";
  const isRename = state.mode === "rename";

  // Seed the field from the view being renamed (or clear for a create) each
  // time the dialog opens, keyed off the current state.
  useEffect(() => {
    if (state.mode === "rename") {
      setName(state.initialName);
    } else if (state.mode === "create") {
      setName("");
    }
  }, [state]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name.trim().length === 0) {
      return;
    }
    onSubmit(name);
  };

  return (
    <Root
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
      open={isOpen}
    >
      <Content className="sm:max-w-sm">
        {/* The gap-4 grid lives on the form so DialogContent's own grid isn't
            broken by the wrapper — no mt-* nudges needed between the field and
            the footer. */}
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <Header>
            <Title>{isRename ? "Rename view" : "Save view"}</Title>
            <Description>
              {isRename
                ? "Give this saved view a new name."
                : "Save the current column layout, sort, filters, and time window as a named view you can switch back to."}
            </Description>
          </Header>
          <div className="grid gap-2">
            <Label htmlFor="saved-view-name">View name</Label>
            <Input
              autoFocus
              id="saved-view-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="View name"
              value={name}
            />
          </div>
          <Footer>
            <Button onClick={onCancel} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={name.trim().length === 0} type="submit">
              Save
            </Button>
          </Footer>
        </form>
      </Content>
    </Root>
  );
}
