"use client";

import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import type { User } from "@repo/api/src/types/user";
import { UserLink } from "@repo/app/shared/components/user-link";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import {
  getUserDisplayName,
  getUserInitials,
} from "@repo/app/shared/lib/user-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import type { Column } from "@repo/design-system/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { MoreHorizontalIcon } from "lucide-react";
import { ENTITY_TYPE_LABELS, FIELD_TYPE_LABELS } from "./constants";

/**
 * @file custom-field-columns.tsx
 * @description How a custom-field row RENDERS, extracted from
 * `custom-fields-settings-tab.tsx` so the legacy Settings tab and the Settings
 * v2 Custom Fields panel (ISS-8367) present one identical table instead of two
 * that drift.
 *
 * Presentation only: no data hook, no mutation, no authorization. The two
 * callers differ in exactly those three things, which is why the split falls
 * here.
 */

/**
 * How the org-users lookup is going. FOUR author outcomes come out of it and
 * the em-dash belongs to exactly one of them:
 *
 * - no `createdById` — the field genuinely has no author. "—".
 * - author resolved — their name and avatar.
 * - author unresolved, lookup still running — a skeleton. Not "—": a read in
 *   flight is not an answer.
 * - author unresolved, lookup settled — "Unknown" when it succeeded and the
 *   author simply is not in the org any more, "Unavailable" when it failed.
 *
 * The first version of this cell collapsed the middle two into the em-dash and
 * claimed in a comment to keep them apart, which is how a still-loading column
 * and a former colleague both read as "nobody created this" (#6638 review).
 */
export const CustomFieldAuthorLookup = {
  Ready: "ready",
  Pending: "pending",
  Unavailable: "unavailable",
} as const;

export type CustomFieldAuthorLookup =
  (typeof CustomFieldAuthorLookup)[keyof typeof CustomFieldAuthorLookup];

const UNRESOLVED_AUTHOR_LABEL: Record<CustomFieldAuthorLookup, string> = {
  [CustomFieldAuthorLookup.Ready]: "Unknown",
  [CustomFieldAuthorLookup.Pending]: "",
  [CustomFieldAuthorLookup.Unavailable]: "Unavailable",
};

function CreatedByCell({
  createdById,
  user,
  authorLookup,
}: {
  createdById: string | null;
  user: User | undefined;
  authorLookup: CustomFieldAuthorLookup;
}) {
  if (createdById === null) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }
  if (!user) {
    if (authorLookup === CustomFieldAuthorLookup.Pending) {
      return <Skeleton className="h-4 w-24" />;
    }
    return (
      <span className="text-muted-foreground text-sm">
        {UNRESOLVED_AUTHOR_LABEL[authorLookup]}
      </span>
    );
  }

  const name = getUserDisplayName(user);
  const initials = getUserInitials(user.firstName, user.lastName);

  return (
    <div className="flex items-center gap-2">
      <PersonAvatar
        avatarUrl={user.avatarUrl}
        className="size-6"
        fallbackClassName="text-[10px]"
        imageAlt={name}
        initials={initials}
        name={name}
      />
      <UserLink className="text-sm hover:underline" userId={user.id}>
        {name}
      </UserLink>
    </div>
  );
}

export type CustomFieldActionsMenuProps = {
  field: CustomFieldWithOptions;
  onEdit: (field: CustomFieldWithOptions) => void;
  onDelete: (field: CustomFieldWithOptions) => void;
};

export function CustomFieldActionsMenu({
  field,
  onEdit,
  onDelete,
}: Readonly<CustomFieldActionsMenuProps>) {
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

export type BuildCustomFieldColumnsOptions = {
  /**
   * How the org-users read is going. Only the Settings v2 panel passes it; the
   * legacy tab folds both a pending and an errored read into an empty list and
   * cannot tell any of the three apart, so it defaults to `Ready`.
   */
  authorLookup?: CustomFieldAuthorLookup;
};

export function buildCustomFieldColumns(
  userMap: ReadonlyMap<string, User>,
  {
    authorLookup = CustomFieldAuthorLookup.Ready,
  }: Readonly<BuildCustomFieldColumnsOptions> = {}
): Column<CustomFieldWithOptions>[] {
  return [
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
          authorLookup={authorLookup}
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
}
