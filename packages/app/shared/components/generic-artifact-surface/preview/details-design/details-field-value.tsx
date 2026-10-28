"use client";

import { ArtifactPriority } from "@repo/app/shared/components/artifact-priority/artifact-priority";
import { ArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import {
  COLLABORATOR_AVATAR_SIZE_CLASS_NAME,
  Collaborators,
} from "@repo/app/shared/components/collaborators";
import { ArtifactPriorityVariant } from "@repo/app/shared/lib/artifact-priority-ownership";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { formatNumber } from "@repo/app/shared/lib/format-utils";
import { getInitials } from "@repo/app/shared/lib/user-utils";
import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";
import { TagList } from "../components/artifact-detail-sections";
import type {
  DetailsFieldValue,
  DetailsRowValue,
} from "./details-design-model";

/** Read-only values sit where the prototype's value buttons put their text. */
function Plain({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center px-1 py-1", className)}>
      {children}
    </span>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <Plain className="text-muted-foreground">{children}</Plain>;
}

function PeopleValue({
  value,
}: {
  value: Extract<DetailsFieldValue, { kind: "people" }>;
}) {
  if (value.people.length > 0) {
    // ISS-12273: the one shared widget, and no partial-list note beside it
    // (operator ruling, 2026-10-08).
    return (
      <Plain className="gap-2">
        <Collaborators people={value.people} />
      </Plain>
    );
  }
  // A list the producer read in full and found empty is not drawn at all
  // (`isDetailsValueEmpty`), so an empty list here is one the producer could
  // not read in full: unknown, which production draws as its unknown glyph.
  return <Muted>{DETAILS_EMPTY_VALUE}</Muted>;
}

/** The read-only cell for every value kind. */
export function FieldValue({ value }: { value: DetailsRowValue }) {
  switch (value.kind) {
    case "text":
      return value.text ? (
        <Plain className={cn(value.mono && "font-mono")}>
          <span className="truncate" title={value.text}>
            {value.text}
          </span>
        </Plain>
      ) : (
        <Muted>{DETAILS_EMPTY_VALUE}</Muted>
      );
    case "status":
      return (
        <ArtifactStatus
          variant={ArtifactStatusVariant.DetailField}
          view={value.view}
        />
      );
    case "priority":
      return (
        <ArtifactPriority
          priority={value.priority}
          variant={ArtifactPriorityVariant.DetailField}
        />
      );
    case "person":
      return (
        <Plain className="gap-2">
          <PersonAvatar
            avatarUrl={value.avatarUrl}
            className={COLLABORATOR_AVATAR_SIZE_CLASS_NAME}
            decorative
            fallbackClassName="text-[10px]"
            initials={getInitials(value.name)}
            name={value.name}
          />
          <span className="truncate">{value.name}</span>
        </Plain>
      );
    case "people":
      return <PeopleValue value={value} />;
    case "tags":
      return value.tags.length > 0 ? (
        <Plain>
          <TagList tags={value.tags} />
        </Plain>
      ) : (
        <Muted>{DETAILS_EMPTY_VALUE}</Muted>
      );
    case "date":
      return value.date ? (
        <Plain>{value.date}</Plain>
      ) : (
        <Muted>{DETAILS_EMPTY_VALUE}</Muted>
      );
    case "changes":
      return (
        <Plain className="font-mono tabular-nums">
          <span className="text-success-foreground">
            +{formatNumber(value.additions)}
          </span>
          &nbsp;
          <span className="text-destructive">
            −{formatNumber(value.deletions)}
          </span>
        </Plain>
      );
    case "custom":
      return <span className="min-w-0">{value.render()}</span>;
    case "self-saving":
      return (
        <span className={cn("min-w-0", value.fill && "flex-1")}>
          {value.render(false)}
        </span>
      );
    default: {
      const unhandled: never = value;
      return unhandled;
    }
  }
}

/** Production's unknown-value glyph (`GridEmptyValue`). */
export const DETAILS_EMPTY_VALUE = "—";
