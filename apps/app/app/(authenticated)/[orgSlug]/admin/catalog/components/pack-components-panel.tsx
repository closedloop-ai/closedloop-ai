"use client";

import type { CatalogItemDto } from "@repo/api/src/types/distribution";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  FileArchiveIcon,
  GitBranchIcon,
  PencilIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";
import { ImportRepoDialog } from "./import-repo-dialog";
import { ImportZipDialog } from "./import-zip-dialog";

type Props = {
  packId: string;
  components: CatalogItemDto[];
  /** Admin-only authoring controls for creating/importing components. */
  canCreateComponents: boolean;
  /** Per-item edit gate for existing components. */
  canEditComponent: (component: CatalogItemDto) => boolean;
  onAdd: () => void;
  onEdit: (component: CatalogItemDto) => void;
  /** Called after a zip import creates components (refetch the Pack detail). */
  onImported: () => void;
};

/**
 * Admin components manager for a Pack — the editable replacement for the shared
 * read-only Contents tab. Lists the Pack's child agentic components and drives
 * add/edit through the kind-aware ComponentEditorDialog.
 */
export function PackComponentsPanel({
  packId,
  components,
  canCreateComponents,
  canEditComponent,
  onAdd,
  onEdit,
  onImported,
}: Props) {
  const [importOpen, setImportOpen] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          Skills, commands, agents, hooks, plugins, and MCPs bundled in this
          Pack.
        </p>
        {canCreateComponents ? (
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Button
              className="gap-1.5"
              onClick={() => setRepoOpen(true)}
              size="sm"
              variant="outline"
            >
              <GitBranchIcon className="size-4" />
              Import from repo
            </Button>
            <Button
              className="gap-1.5"
              onClick={() => setImportOpen(true)}
              size="sm"
              variant="outline"
            >
              <FileArchiveIcon className="size-4" />
              Import from zip
            </Button>
            <Button className="gap-1.5" onClick={onAdd} size="sm">
              <PlusIcon className="size-4" />
              Add component
            </Button>
          </div>
        ) : null}
      </div>

      <ImportZipDialog
        onImported={onImported}
        onOpenChange={setImportOpen}
        open={importOpen}
        packId={packId}
      />
      <ImportRepoDialog
        onImported={onImported}
        onOpenChange={setRepoOpen}
        open={repoOpen}
        packId={packId}
      />

      {components.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No components yet.{" "}
          {canCreateComponents ? "Add one, or import from a zip / repo." : null}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {components.map((component) => {
            const canEdit = canEditComponent(component);
            return (
              <li
                className="flex items-center justify-between gap-3 px-4 py-2.5"
                key={component.id}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium text-sm">
                    {component.name}
                  </span>
                  <Badge className="shrink-0 text-xs" variant="secondary">
                    {component.targetKind}
                  </Badge>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    v{component.version}
                  </span>
                </div>
                {canEdit ? (
                  <Button
                    className="gap-1.5"
                    onClick={() => onEdit(component)}
                    size="sm"
                    variant="ghost"
                  >
                    <PencilIcon className="size-3.5" />
                    Edit
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
