"use client";

import type {
  CatalogItemDto,
  CreateCatalogItemRequest,
} from "@repo/api/src/types/distribution";
import { useCreateCatalogItem } from "@repo/app/agents/hooks/use-catalog";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { useCallback, useState } from "react";
import { CatalogItemUpload } from "./catalog-item-upload";

type CreateFormState = {
  name: string;
  description: string;
  coaching: boolean;
};

const DEFAULT_FORM: CreateFormState = {
  name: "",
  description: "",
  coaching: false,
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created Pack so the caller can open it to add components. */
  onCreated?: (pack: CatalogItemDto) => void;
};

/**
 * Admin "New Pack" dialog — creates the Pack container (targetKind "pack"), then
 * reveals its zip/logo upload. Components are added afterward from the Pack
 * detail via the kind-aware component editor (or imported from a zip / repo).
 */
export function CreatePackDialog({ open, onOpenChange, onCreated }: Props) {
  const createItem = useCreateCatalogItem();
  const [form, setForm] = useState<CreateFormState>(DEFAULT_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CatalogItemDto | null>(null);

  const reset = useCallback(() => {
    setForm(DEFAULT_FORM);
    setFormError(null);
    setCreated(null);
  }, []);

  const handleCreate = useCallback(async () => {
    setFormError(null);
    if (!form.name.trim()) {
      setFormError("Name is required.");
      return;
    }
    const request: CreateCatalogItemRequest = {
      targetKind: "pack",
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      coaching: form.coaching || undefined,
    };
    try {
      const item = await createItem.mutateAsync(request);
      setCreated(item);
      onCreated?.(item);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to create Pack."
      );
    }
  }, [form, createItem, onCreated]);

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          reset();
        }
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Pack</DialogTitle>
          <DialogDescription>
            Create a Pack, then add components (skills, commands, agents, hooks,
            plugins, MCPs) — or import them from a zip / repo.
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              Created <span className="font-medium">{created.name}</span>.
              Optionally upload a bundle and logo:
            </p>
            <div className="flex flex-wrap gap-4">
              <CatalogItemUpload catalogItemId={created.id} fileType="zip" />
              <CatalogItemUpload catalogItemId={created.id} fileType="logo" />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label className="text-sm" htmlFor="pack-name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="pack-name"
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="e.g. Platform Standards"
                value={form.name}
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label className="text-sm" htmlFor="pack-desc">
                Description
              </Label>
              <Input
                id="pack-desc"
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                placeholder="What does this Pack bundle?"
                value={form.description}
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                checked={form.coaching}
                className="h-4 w-4 cursor-pointer rounded border-input accent-primary"
                id="pack-coaching"
                onChange={(e) =>
                  setForm((f) => ({ ...f, coaching: e.target.checked }))
                }
                type="checkbox"
              />
              <Label
                className="cursor-pointer font-normal text-sm"
                htmlFor="pack-coaching"
              >
                Coaching pack{" "}
                <span className="text-muted-foreground text-xs">
                  — carries signals[] rubric
                </span>
              </Label>
            </div>

            {formError ? (
              <p className="text-destructive text-sm">{formError}</p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {created ? (
            <Button
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              Done
            </Button>
          ) : (
            <Button disabled={createItem.isPending} onClick={handleCreate}>
              {createItem.isPending ? "Creating…" : "Create Pack"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
