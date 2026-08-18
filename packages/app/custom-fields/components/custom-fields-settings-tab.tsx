"use client";

import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import type { User } from "@repo/api/src/types/user";
import {
  useCustomFields,
  useDeleteCustomField,
} from "@repo/app/custom-fields/hooks/use-custom-fields";
import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";
import { UserLink } from "@repo/app/shared/components/user-link";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import {
  getUserDisplayName,
  getUserInitials,
} from "@repo/app/shared/lib/user-utils";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import type { Column } from "@repo/design-system/components/ui/data-table";
import { DataTable } from "@repo/design-system/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  ListPlusIcon,
  MoreHorizontalIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import { ENTITY_TYPE_LABELS, FIELD_TYPE_LABELS } from "./constants";
import { CreateCustomFieldDialog } from "./create-custom-field-dialog";

function CreatedByCell({
  createdById,
  user,
}: {
  createdById: string | null;
  user: User | undefined;
}) {
  if (!(createdById && user)) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }

  const name = getUserDisplayName(user);
  const initials = getUserInitials(user.firstName, user.lastName);

  return (
    <div className="flex items-center gap-2">
      <Avatar className="size-6">
        {user.avatarUrl ? (
          <AvatarImage alt={name} src={user.avatarUrl} />
        ) : null}
        <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
      </Avatar>
      <UserLink className="text-sm hover:underline" userId={user.id}>
        {name}
      </UserLink>
    </div>
  );
}

type ActionsMenuProps = {
  field: CustomFieldWithOptions;
  onEdit: (field: CustomFieldWithOptions) => void;
  onDelete: (field: CustomFieldWithOptions) => void;
};

function ActionsMenu({ field, onEdit, onDelete }: Readonly<ActionsMenuProps>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost">
          <MoreHorizontalIcon className="h-4 w-4" />
          <span className="sr-only">Open actions menu</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onEdit(field)}>Edit</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => onDelete(field)}
          variant="destructive"
        >
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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

  const columns: Column<CustomFieldWithOptions>[] = [
    {
      key: "name",
      header: "Name",
      render: (field) => <span className="font-medium">{field.name}</span>,
    },
    {
      key: "fieldType",
      header: "Type",
      render: (field) => (
        <Badge variant="secondary">{FIELD_TYPE_LABELS[field.fieldType]}</Badge>
      ),
    },
    {
      key: "entityTypes",
      header: "Used in",
      render: (field) => {
        if (!field.entityTypes || field.entityTypes.length === 0) {
          return <span className="text-muted-foreground text-sm">—</span>;
        }
        return (
          <div className="flex flex-wrap gap-1">
            {field.entityTypes.map((t) => (
              <Badge key={t} variant="outline">
                {ENTITY_TYPE_LABELS[t]}
              </Badge>
            ))}
          </div>
        );
      },
    },
    {
      key: "createdById",
      header: "Created by",
      render: (field) => (
        <CreatedByCell
          createdById={field.createdById}
          user={field.createdById ? userMap.get(field.createdById) : undefined}
        />
      ),
    },
    {
      key: "createdAt",
      header: "Created",
      render: (field) => (
        <span className="text-muted-foreground text-sm">
          {formatRelativeTime(field.createdAt)}
        </span>
      ),
    },
  ];

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
          <ActionsMenu
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
