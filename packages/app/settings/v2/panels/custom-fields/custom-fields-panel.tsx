"use client";

import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import { SettingsDomainId } from "@repo/api/src/types/settings-domain";
import type { User } from "@repo/api/src/types/user";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { DataTable } from "@repo/design-system/components/ui/data-table";
import { ListPlusIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { CreateCustomFieldDialog } from "../../../../custom-fields/components/create-custom-field-dialog";
import {
  buildCustomFieldColumns,
  CustomFieldActionsMenu,
  CustomFieldAuthorLookup,
} from "../../../../custom-fields/components/custom-field-columns";
import {
  useCustomFields,
  useDeleteCustomField,
} from "../../../../custom-fields/hooks/use-custom-fields";
import { ConfirmationDialog } from "../../../../shared/components/confirmation-dialog";
import { useOrganizationUsers } from "../../../../users/hooks/use-users";
import { SettingsPanelDataStateView } from "../../components/settings-panel-data-state-view";
import { SettingsPanelSection } from "../../components/settings-panel-section";
import { SettingsWriteOutcomeAlert } from "../../components/settings-write-outcome-alert";
import { useSettingsDomainAccess } from "../../hooks/use-settings-view-model";
import {
  classifySettingsPanelError,
  classifySettingsPanelRead,
  SettingsPanelDataState,
} from "../../lib/settings-panel-data-state";

const CUSTOM_FIELDS_SUBJECT = "custom fields";

/**
 * Here the admin wording is EARNED: `POST`/`PUT`/`DELETE /custom-fields` all
 * call `isOrgAdmin`, so a 403 on this domain really does mean an admin is
 * needed. Panels whose routes carry no such gate keep the alert's neutral
 * default rather than inventing a policy (ISS-8367 review, bha_p0_f3).
 */
const CUSTOM_FIELDS_FORBIDDEN_MESSAGE =
  "That change needs an organization admin. Nothing was changed.";

/**
 * Settings v2 → Labs → **Custom Fields** (ISS-8367).
 *
 * READ IS OPEN TO EVERY MEMBER and that is the policy speaking, not a loosening
 * invented here: `SETTINGS_DOMAIN_ACCESS_POLICY[CustomFields]` grants `read` to
 * every role because `GET /custom-fields` does, and grants `edit` to admins and
 * owners because `POST`/`PUT`/`DELETE` all call `isOrgAdmin`. The legacy tab
 * hides the whole surface behind one browser-side `isAdmin`, which withholds a
 * read the server has always allowed.
 *
 * The write controls therefore gate on the `admin` rung INSIDE the body, which
 * is where a per-control gate belongs — a member sees the fields their
 * organization uses and is offered no button whose route would answer 403.
 * Hiding a control is not the boundary; the route is.
 */
export function CustomFieldsPanel() {
  const fields = useCustomFields();
  const users = useOrganizationUsers();
  const access = useSettingsDomainAccess(SettingsDomainId.CustomFields);
  // Own alert, so the shared client's generic toast would double up on the same
  // outcome. See the Tags panel for the same trade and the obligation it
  // carries: every failed write still gets exactly one sentence.
  const deleteCustomField = useDeleteCustomField({
    suppressDefaultErrorToast: true,
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editField, setEditField] = useState<CustomFieldWithOptions | null>(
    null
  );
  const [deleteTarget, setDeleteTarget] =
    useState<CustomFieldWithOptions | null>(null);
  const [writeOutcome, setWriteOutcome] =
    useState<SettingsPanelDataState | null>(null);

  const dataState = classifySettingsPanelRead({
    error: fields.error,
    hasData: fields.data !== undefined,
    isEmpty: (fields.data?.length ?? 0) === 0,
    isPending: fields.isPending,
  });

  // `edit`, not `admin`. They coincide for this domain today —
  // `SETTINGS_DOMAIN_ACCESS_POLICY[CustomFields].edit` is ADMIN_AND_OWNER — but
  // `edit` is the DOMAIN's rung while `admin` is a role fact that merely tracks
  // it, so loosening that policy row to follow a route change would move Tags
  // and leave this panel behind. A pending or errored capability read yields no
  // write controls, and the errored case says so below rather than passing for
  // a denial.
  const canManage = access.status === "settled" && access.grants.edit;

  const openCreate = () => {
    setEditField(null);
    setWriteOutcome(null);
    setDialogOpen(true);
  };

  const handleEdit = (field: CustomFieldWithOptions) => {
    setEditField(field);
    setWriteOutcome(null);
    setDialogOpen(true);
  };

  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setEditField(null);
    }
  };

  const handleDeleteConfirm = async () => {
    if (deleteTarget === null) {
      return;
    }
    setWriteOutcome(null);
    try {
      await deleteCustomField.mutateAsync(deleteTarget.id);
    } catch (error) {
      // A rejected delete must not close silently as though the field were
      // gone. The dialog closes either way; the outcome alert is what tells
      // the user which of the two happened.
      setWriteOutcome(classifySettingsPanelError(error));
    }
    setDeleteTarget(null);
  };

  const createFieldButton = (
    <Button onClick={openCreate} size="sm">
      <PlusIcon className="h-4 w-4" />
      Create field
    </Button>
  );

  return (
    <SettingsPanelSection
      description="Define reusable fields for artifacts across your organization."
      title="Custom Fields"
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
        <SettingsWriteOutcomeAlert
          forbiddenMessage={CUSTOM_FIELDS_FORBIDDEN_MESSAGE}
          state={writeOutcome}
        />
        {users.isError ? (
          <Alert variant="error">
            <AlertDescription>
              We couldn&apos;t load your teammates, so field authors show as
              unavailable.
            </AlertDescription>
          </Alert>
        ) : null}
        {dataState === SettingsPanelDataState.Ready && fields.data ? (
          <CustomFieldsTable
            authorLookup={authorLookupOf(users)}
            canManage={canManage}
            createAction={createFieldButton}
            fields={fields.data}
            onDelete={setDeleteTarget}
            onEdit={handleEdit}
            users={users.data ?? []}
          />
        ) : (
          <SettingsPanelDataStateView
            empty={{
              action: canManage ? createFieldButton : undefined,
              description:
                "Custom fields let you track extra information on projects and documents.",
              icon: ListPlusIcon,
              title: "No custom fields yet",
            }}
            onRetry={() => {
              fields.refetch();
            }}
            state={dataState}
            subject={CUSTOM_FIELDS_SUBJECT}
          />
        )}
      </div>

      {/*
        Both dialogs are gated on `canManage` as well as their own open state:
        an access refetch that fails or loses `edit` while one is open would
        otherwise leave a live submit path standing under an alert saying no
        editing controls are offered.
      */}
      <CreateCustomFieldDialog
        field={editField ?? undefined}
        onOpenChange={handleDialogOpenChange}
        open={dialogOpen && canManage}
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
        open={deleteTarget !== null && canManage}
        title="Delete custom field"
        variant="destructive"
      />
    </SettingsPanelSection>
  );
}

/**
 * Which author outcome the org-users read licenses. The fields list can land
 * first, so the table often renders while this read is still in flight — and a
 * read in flight must not be drawn as an authorless field.
 */
function authorLookupOf(
  users: Readonly<{ isPending: boolean; isError: boolean }>
): CustomFieldAuthorLookup {
  if (users.isPending) {
    return CustomFieldAuthorLookup.Pending;
  }
  return users.isError
    ? CustomFieldAuthorLookup.Unavailable
    : CustomFieldAuthorLookup.Ready;
}

type CustomFieldsTableProps = {
  fields: CustomFieldWithOptions[];
  users: User[];
  authorLookup: CustomFieldAuthorLookup;
  canManage: boolean;
  createAction: React.ReactNode;
  onEdit: (field: CustomFieldWithOptions) => void;
  onDelete: (field: CustomFieldWithOptions) => void;
};

function CustomFieldsTable({
  fields,
  users,
  authorLookup,
  canManage,
  createAction,
  onEdit,
  onDelete,
}: Readonly<CustomFieldsTableProps>) {
  const userMap = new Map(users.map((user) => [user.id, user]));
  const columns = buildCustomFieldColumns(userMap, { authorLookup });

  return (
    <>
      {canManage ? (
        <div className="flex items-center justify-end">{createAction}</div>
      ) : null}
      <DataTable
        columns={columns}
        data={fields}
        emptyMessage="No custom fields found."
        renderRowActions={
          canManage
            ? (field) => (
                <CustomFieldActionsMenu
                  field={field}
                  onDelete={onDelete}
                  onEdit={onEdit}
                />
              )
            : undefined
        }
        searchKey="name"
        searchPlaceholder="Search fields..."
      />
    </>
  );
}
