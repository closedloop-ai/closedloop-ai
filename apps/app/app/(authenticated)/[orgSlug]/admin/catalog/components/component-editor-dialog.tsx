"use client";

import type { CatalogItemDto } from "@repo/api/src/types/distribution";
import {
  useCreateCatalogItem,
  useUpdateCatalogItem,
} from "@repo/app/agents/hooks/use-catalog";
import {
  assembleComponentContent,
  COMPONENT_ANATOMY,
  COMPONENT_KINDS,
  type ComponentDraft,
  type ComponentKind,
  parseComponentContent,
} from "@repo/app/packs/lib/component-anatomy";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useCallback, useEffect, useMemo, useState } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pack this component belongs to (required on create). */
  parentPackId?: string;
  /** Existing component to edit; null/undefined creates a new one. */
  existing?: CatalogItemDto | null;
  onSaved: () => void;
};

const EMPTY_DRAFT: ComponentDraft = {
  name: "",
  description: "",
  fields: {},
  body: "",
};
type ComponentAnatomy = (typeof COMPONENT_ANATOMY)[ComponentKind];

/**
 * Kind-aware editor for an agentic component in a Pack. Renders the anatomy of
 * the selected kind (frontmatter/config form fields + a markdown body for
 * markdown kinds), assembles the canonical `content` on save (persisted as a
 * versioned CatalogItemVersion), and offers a raw-content escape hatch. Edit
 * mode parses the stored content back into fields.
 */
export function ComponentEditorDialog({
  open,
  onOpenChange,
  parentPackId,
  existing,
  onSaved,
}: Props) {
  const isEdit = Boolean(existing);
  const supportsContentEdit = existing
    ? isComponentKind(existing.targetKind)
    : true;
  const createItem = useCreateCatalogItem();
  const updateItem = useUpdateCatalogItem();

  const [kind, setKind] = useState<ComponentKind>("skill");
  const [draft, setDraft] = useState<ComponentDraft>(EMPTY_DRAFT);
  const [rawMode, setRawMode] = useState(false);
  const [rawContent, setRawContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Seed state whenever the dialog opens (edit → parse existing; create → reset).
  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    setRawMode(false);
    if (existing) {
      if (isComponentKind(existing.targetKind)) {
        const existingKind = existing.targetKind;
        setKind(existingKind);
        const parsed = parseComponentContent(existingKind, existing.content);
        setDraft({
          ...parsed,
          name: parsed.name || existing.name,
          description: parsed.description || existing.description || "",
        });
        setRawContent(existing.content ?? "");
      } else {
        setKind("skill");
        setDraft({
          ...EMPTY_DRAFT,
          name: existing.name,
          description: existing.description ?? "",
        });
        setRawContent("");
      }
    } else {
      setKind("skill");
      setDraft(EMPTY_DRAFT);
      setRawContent("");
    }
  }, [open, existing]);

  const anatomy = COMPONENT_ANATOMY[kind];
  const assembled = useMemo(
    () => assembleComponentContent(kind, draft),
    [kind, draft]
  );

  const setField = useCallback((key: string, value: string) => {
    setDraft((prev) => ({ ...prev, fields: { ...prev.fields, [key]: value } }));
  }, []);

  const handleSave = useCallback(async () => {
    setError(null);
    const validationError = getSaveValidationError({
      anatomy,
      draft,
      existing,
      parentPackId,
      rawMode,
      supportsContentEdit,
    });
    if (validationError) {
      setError(validationError);
      return;
    }
    const content = rawMode ? rawContent : assembled;
    const name = draft.name.trim();
    const trimmedDescription = draft.description.trim();
    const description = existing
      ? trimmedDescription
      : trimmedDescription || undefined;
    try {
      if (existing) {
        await updateItem.mutateAsync({
          id: existing.id,
          name,
          description,
          ...(supportsContentEdit && { content }),
        });
      } else {
        await createItem.mutateAsync({
          targetKind: kind,
          name,
          description,
          parentPackId: getRequiredParentPackId(parentPackId),
          content,
        });
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save component."
      );
    }
  }, [
    draft,
    anatomy,
    rawMode,
    rawContent,
    assembled,
    existing,
    supportsContentEdit,
    kind,
    parentPackId,
    createItem,
    updateItem,
    onSaved,
    onOpenChange,
  ]);

  const pending = createItem.isPending || updateItem.isPending;
  const title = getDialogTitle({ isEdit, supportsContentEdit });
  const description = supportsContentEdit
    ? `${anatomy.label} - authored as a versioned artifact in this Pack.`
    : "Update this catalog item's name and description.";
  const saveLabel = supportsContentEdit ? "Save component" : "Save item";
  const showRawEditor = supportsContentEdit && rawMode;
  const showFormEditor = supportsContentEdit && !rawMode;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {isEdit ? null : (
            <div className="flex flex-col gap-1">
              <Label className="text-sm" htmlFor="ce-kind">
                Kind
              </Label>
              <Select
                onValueChange={(value) => setKind(value as ComponentKind)}
                value={kind}
              >
                <SelectTrigger id="ce-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPONENT_KINDS.map((componentKind) => (
                    <SelectItem key={componentKind} value={componentKind}>
                      {COMPONENT_ANATOMY[componentKind].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <Label className="text-sm" htmlFor="ce-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="ce-name"
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, name: e.target.value }))
              }
              placeholder="e.g. code-reviewer"
              value={draft.name}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-sm" htmlFor="ce-desc">
              Description
            </Label>
            <Input
              id="ce-desc"
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, description: e.target.value }))
              }
              placeholder="What does this component do?"
              value={draft.description}
            />
          </div>

          {showRawEditor ? (
            <div className="flex flex-col gap-1">
              <Label className="text-sm" htmlFor="ce-raw">
                Raw content
              </Label>
              <Textarea
                className="min-h-[240px] font-mono text-xs"
                id="ce-raw"
                onChange={(e) => setRawContent(e.target.value)}
                value={rawContent}
              />
            </div>
          ) : null}

          {showFormEditor ? (
            <>
              {anatomy.fields.map((field) => (
                <div className="flex flex-col gap-1" key={field.key}>
                  <Label className="text-sm" htmlFor={`ce-${field.key}`}>
                    {field.label}
                    {field.required ? (
                      <span className="text-destructive"> *</span>
                    ) : null}
                  </Label>
                  <Input
                    id={`ce-${field.key}`}
                    onChange={(e) => setField(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    value={draft.fields[field.key] ?? ""}
                  />
                  {field.help ? (
                    <p className="text-muted-foreground text-xs">
                      {field.help}
                    </p>
                  ) : null}
                </div>
              ))}

              {anatomy.bodyMode === "markdown" ? (
                <div className="flex flex-col gap-1">
                  <Label className="text-sm" htmlFor="ce-body">
                    {anatomy.bodyLabel ?? "Body"}
                  </Label>
                  <Textarea
                    className="min-h-[200px] font-mono text-xs"
                    id="ce-body"
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, body: e.target.value }))
                    }
                    placeholder="Markdown instructions / prompt…"
                    value={draft.body}
                  />
                </div>
              ) : null}
            </>
          ) : null}

          {error ? <p className="text-destructive text-sm">{error}</p> : null}
        </div>

        <DialogFooter className="sm:justify-between">
          {supportsContentEdit ? (
            <Button
              onClick={() => {
                if (!rawMode) {
                  setRawContent(assembled);
                }
                setRawMode((prev) => !prev);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              {rawMode ? "Use form fields" : "Edit raw"}
            </Button>
          ) : (
            <span />
          )}
          <Button disabled={pending} onClick={handleSave}>
            {pending ? "Saving…" : saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isComponentKind(value: string): value is ComponentKind {
  return COMPONENT_KINDS.some((componentKind) => componentKind === value);
}

function getDialogTitle({
  isEdit,
  supportsContentEdit,
}: {
  isEdit: boolean;
  supportsContentEdit: boolean;
}): string {
  if (!isEdit) {
    return "Add component";
  }
  if (supportsContentEdit) {
    return "Edit component";
  }
  return "Edit item";
}

function getSaveValidationError({
  anatomy,
  draft,
  existing,
  parentPackId,
  rawMode,
  supportsContentEdit,
}: {
  anatomy: ComponentAnatomy;
  draft: ComponentDraft;
  existing?: CatalogItemDto | null;
  parentPackId?: string;
  rawMode: boolean;
  supportsContentEdit: boolean;
}): string | null {
  if (!draft.name.trim()) {
    return "Name is required.";
  }
  if (!(existing || parentPackId)) {
    return "Pack is required.";
  }
  if (supportsContentEdit && !rawMode) {
    const missing = anatomy.fields.find(
      (field) => field.required && !draft.fields[field.key]?.trim()
    );
    if (missing) {
      return `${missing.label} is required.`;
    }
  }
  return null;
}

function getRequiredParentPackId(parentPackId?: string): string {
  if (!parentPackId) {
    throw new Error("Pack is required.");
  }
  return parentPackId;
}
