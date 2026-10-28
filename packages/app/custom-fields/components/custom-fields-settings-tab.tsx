"use client";

import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import {
  useCustomFields,
  useDeleteCustomField,
} from "@repo/app/custom-fields/hooks/use-custom-fields";
import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
import { Button } from "@repo/design-system/components/ui/button";
import { DataTable } from "@repo/design-system/components/ui/data-table";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { ListPlusIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { CreateCustomFieldDialog } from "./create-custom-field-dialog";
import {
  buildCustomFieldColumns,
  CustomFieldActionsMenu,
} from "./custom-field-columns";

export function CustomFieldsSettingsTab() {
  const {
    data: fields = [],
    isLoading,
    isLoadingError,
    refetch,
  } = useCustomFields();
  const { data: users = [] } = useOrganizationUsers();
  const deleteCustomField = useDeleteCustomField();

  const userMap = new Map(users.map((u) => [u.id, u]));

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editField, setEditField] = useState<CustomFieldWithOptions | null>(
    null
  );
  const [deleteTarget, setDeleteTarget] =
    useState<CustomFieldWithOptions | null>(null);

  const handleEdit = (field: CustomFieldWithOptions) => {
    setEditField(field);
    setDialogOpen(true);
  };

  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setEditField(null);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) {
      return;
    }
    await deleteCustomField.mutateAsync(deleteTarget.id);
    setDeleteTarget(null);
  };

  const columns = buildCustomFieldColumns(userMap);

  // Only block the whole tab on an initial-load failure. When fields are
  // already cached, a background refetch error keeps the editable rows visible
  // (TanStack retains `data` and sets `isError`), so gate on `isLoadingError`.
  if (isLoadingError) {
    return (
      <div role="alert">
        <EmptyState
          action={
            <Button onClick={() => refetch()} size="sm" variant="outline">
              Try again
            </Button>
          }
          description="Something went wrong loading your custom fields."
          icon={TriangleAlertIcon}
          size="compact"
          title="Couldn't load custom fields"
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div aria-busy="true" aria-live="polite" className="flex flex-col gap-4">
        <span className="sr-only">Loading custom fields</span>
        <div className="flex items-center justify-between">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="overflow-hidden rounded-md border">
          {["a", "b", "c", "d"].map((key) => (
            <Skeleton
              className="h-12 w-full rounded-none border-border border-b last:border-b-0"
              key={key}
            />
          ))}
        </div>
      </div>
    );
  }

  if (fields.length === 0) {
    return (
      <>
        <EmptyState
          action={
            <Button onClick={() => setDialogOpen(true)} size="sm">
              <PlusIcon className="h-4 w-4" />
              Create field
            </Button>
          }
          description="Custom fields let you track extra information on projects and documents."
          icon={ListPlusIcon}
          size="compact"
          title="No custom fields yet"
        />

        <CreateCustomFieldDialog
          field={undefined}
          onOpenChange={handleDialogOpenChange}
          open={dialogOpen}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-end pb-4">
        <Button onClick={() => setDialogOpen(true)} size="sm">
          <PlusIcon className="h-4 w-4" />
          Create field
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={fields}
        emptyMessage="No custom fields found."
        renderRowActions={(field) => (
          <CustomFieldActionsMenu
            field={field}
            onDelete={setDeleteTarget}
            onEdit={handleEdit}
          />
        )}
        searchKey="name"
        searchPlaceholder="Search fields..."
      />

      <CreateCustomFieldDialog
        field={editField ?? undefined}
        onOpenChange={handleDialogOpenChange}
        open={dialogOpen}
      />

      <ConfirmationDialog
        confirmLabel="Delete"
        description={`Are you sure you want to delete the "${deleteTarget?.name}" field? This will remove all values stored for this field across all entities.`}
        isPending={deleteCustomField.isPending}
        onConfirm={handleDeleteConfirm}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
        open={deleteTarget !== null}
        title="Delete custom field"
        variant="destructive"
      />
    </>
  );
}
