"use client";

import { SettingsDomainId } from "@repo/api/src/types/settings-domain";
import type { Tag, TagColor } from "@repo/api/src/types/tag";
import { TAG_COLORS, TAG_NAME_MAX_LENGTH } from "@repo/api/src/types/tag";
import { TagColorPicker } from "@repo/app/shared/components/tag-color-picker";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { DataTable } from "@repo/design-system/components/ui/data-table";
import { Input } from "@repo/design-system/components/ui/input";
import { PlusIcon, TagsIcon } from "lucide-react";
import { useState } from "react";
import { ConfirmationDialog } from "../../../../shared/components/confirmation-dialog";
import {
  buildTagColumns,
  TagRowActions,
} from "../../../../tags/components/tag-columns";
import {
  useCreateTag,
  useDeleteTag,
  useTags,
  useUpdateTag,
} from "../../../../tags/hooks/use-tags";
import { SettingsPanelDataStateView } from "../../components/settings-panel-data-state-view";
import { SettingsPanelSection } from "../../components/settings-panel-section";
import { SettingsWriteOutcomeAlert } from "../../components/settings-write-outcome-alert";
import { useSettingsDomainAccess } from "../../hooks/use-settings-view-model";
import {
  classifySettingsPanelError,
  classifySettingsPanelRead,
  SettingsPanelDataState,
} from "../../lib/settings-panel-data-state";

const TAGS_SUBJECT = "tags";

const SUPPRESS_SHARED_TOAST = { suppressDefaultErrorToast: true } as const;

/**
 * Settings v2 → Labs → **Tags** (ISS-8367).
 *
 * WHAT THIS PANEL FIXES, and it is the whole reason the legacy tab is not just
 * mounted here: that tab reads `const { data: tags = [] } = useTags()`, so a
 * still-loading read, a genuinely empty organization, a refusal and an outage
 * all render as the same empty table. Four different facts, one screen. Here
 * the read is classified and each outcome gets its own screen.
 */
export function TagsPanel() {
  const tags = useTags();
  const access = useSettingsDomainAccess(SettingsDomainId.Tags);
  // This panel renders its own sentence for every failed write, so the shared
  // client's generic toast would be a second, conflicting message on the same
  // outcome. Suppressing it here obliges the alert to speak for ALL of them,
  // including a plain failure — silence would be worse than a duplicate.
  const createTag = useCreateTag(SUPPRESS_SHARED_TOAST);
  const updateTag = useUpdateTag(SUPPRESS_SHARED_TOAST);
  const deleteTag = useDeleteTag(SUPPRESS_SHARED_TOAST);

  const [deleteTarget, setDeleteTarget] = useState<Tag | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState<TagColor>(TAG_COLORS[0]);
  const [writeOutcome, setWriteOutcome] =
    useState<SettingsPanelDataState | null>(null);

  const tagList = tags.data ?? [];

  const dataState = classifySettingsPanelRead({
    error: tags.error,
    hasData: tags.data !== undefined,
    isEmpty: tagList.length === 0,
    isPending: tags.isPending,
  });

  // Every role holds `edit` on this domain today — there is no admin gate
  // anywhere in `apps/api/app/tags`. Reading the grant rather than assuming it
  // is what makes a future policy change move the UI without a second edit.
  const canManage = access.status === "settled" && access.grants.edit;

  const reportWriteError = (error: unknown) => {
    setWriteOutcome(classifySettingsPanelError(error));
  };

  const handleCreate = () => {
    const name = newTagName.trim();
    if (!name) {
      return;
    }
    setWriteOutcome(null);
    createTag.mutate(
      { name, color: newTagColor },
      {
        onError: reportWriteError,
        onSuccess: () => {
          setNewTagName("");
          setNewTagColor(TAG_COLORS[(tagList.length + 1) % TAG_COLORS.length]);
          setIsCreating(false);
        },
      }
    );
  };

  const handleRename = (tag: Tag, name: string) => {
    const next = name.trim();
    if (next && next !== tag.name) {
      setWriteOutcome(null);
      updateTag.mutate(
        { id: tag.id, name: next },
        { onError: reportWriteError }
      );
    }
  };

  const handleRecolor = (tag: Tag, color: TagColor) => {
    if (color !== tag.color) {
      setWriteOutcome(null);
      updateTag.mutate({ id: tag.id, color }, { onError: reportWriteError });
    }
  };

  const handleDelete = () => {
    if (deleteTarget === null) {
      return;
    }
    setWriteOutcome(null);
    deleteTag.mutate(deleteTarget.id, {
      onError: (error) => {
        reportWriteError(error);
        setDeleteTarget(null);
      },
      onSuccess: () => {
        setDeleteTarget(null);
      },
    });
  };

  const startCreating = () => {
    setNewTagColor(TAG_COLORS[tagList.length % TAG_COLORS.length]);
    setWriteOutcome(null);
    setIsCreating(true);
  };

  const createTagButton = (
    <Button disabled={isCreating} onClick={startCreating} size="sm">
      <PlusIcon className="h-4 w-4" />
      Create tag
    </Button>
  );

  // Handed the editing handlers ONLY when the grant is established. Without
  // this the inline name editor and the colour picker stayed live while the
  // panel's own alert said no editing controls were offered — two of the three
  // write affordances contradicting the sentence above them.
  const columns = buildTagColumns(
    canManage ? { onRecolor: handleRecolor, onRename: handleRename } : undefined
  );

  return (
    <SettingsPanelSection
      description="Create organization-wide labels for grouping and filtering work."
      title="Tags"
    >
      <div className="space-y-4">
        {access.status === "error" ? (
          <Alert variant="error">
            <AlertDescription>
              We couldn&apos;t check what you&apos;re allowed to change here, so
              no editing controls are offered. This isn&apos;t a refusal — try
              again in a moment.
            </AlertDescription>
          </Alert>
        ) : null}
        {/*
          No `forbiddenMessage` override, deliberately: the alert's neutral
          default is the correct sentence here. A 403 on a tag write cannot mean
          "ask an admin" — there is no admin gate anywhere in
          `apps/api/app/tags` and `SETTINGS_DOMAIN_ACCESS_POLICY[Tags]` grants
          `edit` to every role — so naming one would send the user after a
          permission nobody holds (ISS-8367 review, bha_p0_f3).
        */}
        <SettingsWriteOutcomeAlert state={writeOutcome} />

        {/*
          Mounted ABOVE the read branch, not inside its ready arm. An
          organization with no tags classifies as `Empty`, so a create row that
          only rendered under `Ready` left the empty state's own "Create tag"
          action setting a flag nothing acted on — and, because the button
          disables itself while `isCreating`, a brand-new organization could not
          create its first tag at all. Hoisting it also stops a background
          refetch that flips the read out of `Ready` from discarding a
          half-typed name.

          Still gated on `canManage`, though: an access refetch that fails or
          loses `edit` while the row is open would otherwise leave a live name
          field and Create button standing under an alert saying no editing
          controls are offered.
        */}
        {canManage && isCreating ? (
          <TagCreateRow
            color={newTagColor}
            isSaving={createTag.isPending}
            name={newTagName}
            onCancel={() => setIsCreating(false)}
            onColorChange={setNewTagColor}
            onNameChange={setNewTagName}
            onSubmit={handleCreate}
          />
        ) : null}

        {dataState === SettingsPanelDataState.Ready ? (
          <>
            {canManage ? (
              <div className="flex items-center justify-end">
                {createTagButton}
              </div>
            ) : null}
            <DataTable
              columns={columns}
              data={tagList}
              emptyMessage="No tags found."
              renderRowActions={
                canManage
                  ? (tag) => (
                      <TagRowActions onDelete={setDeleteTarget} tag={tag} />
                    )
                  : undefined
              }
              searchKey="name"
              searchPlaceholder="Search tags..."
            />
          </>
        ) : (
          <SettingsPanelDataStateView
            empty={{
              // Suppressed while the create row is open, so the empty screen
              // does not sit under a greyed-out button whose job the row above
              // is already doing.
              action: canManage && !isCreating ? createTagButton : undefined,
              description:
                "Tags group and filter work across sessions, branches, and artifacts.",
              icon: TagsIcon,
              title: "No tags yet",
            }}
            onRetry={() => {
              tags.refetch();
            }}
            state={dataState}
            subject={TAGS_SUBJECT}
          />
        )}
      </div>

      <ConfirmationDialog
        confirmLabel="Delete"
        description={`This will remove the tag "${deleteTarget?.name}" from all artifacts it's applied to. This action cannot be undone.`}
        isPending={deleteTag.isPending}
        onConfirm={handleDelete}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
        open={deleteTarget !== null}
        title="Delete tag"
        variant="destructive"
      />
    </SettingsPanelSection>
  );
}

type TagCreateRowProps = {
  color: TagColor;
  name: string;
  isSaving: boolean;
  onColorChange: (color: TagColor) => void;
  onNameChange: (name: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
};

function TagCreateRow({
  color,
  name,
  isSaving,
  onColorChange,
  onNameChange,
  onSubmit,
  onCancel,
}: Readonly<TagCreateRowProps>) {
  // ONE predicate for both entry points. Enter used to call `onSubmit` with no
  // guard while the button carried its own `disabled`, so a second press during
  // an in-flight create fired a duplicate request and the user got a
  // duplicate-name error for a tag they asked for once.
  const canSubmit = name.trim().length > 0 && !isSaving;

  return (
    <div className="flex items-center gap-2 rounded-lg border p-3">
      <TagColorPicker onChange={onColorChange} value={color} />
      <Input
        aria-label="New tag name"
        autoFocus
        className="h-8 max-w-xs"
        maxLength={TAG_NAME_MAX_LENGTH}
        onChange={(event) => onNameChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && canSubmit) {
            onSubmit();
          }
          if (event.key === "Escape") {
            onCancel();
          }
        }}
        placeholder="Tag name"
        value={name}
      />
      <Button disabled={!canSubmit} onClick={onSubmit} size="sm">
        Create
      </Button>
      <Button onClick={onCancel} size="sm" variant="ghost">
        Cancel
      </Button>
    </div>
  );
}
