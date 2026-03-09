"use client";

import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { formatDate } from "@/lib/date-utils";
import { getUserDisplayName, getUserInitials } from "@/lib/user-utils";

const MAX_TEXT_LENGTH = 50;
const MAX_ENUM_BADGES = 2;
const MAX_PEOPLE_AVATARS = 3;

type CustomFieldCellProps = {
  value: CustomFieldValueDetail;
};

const FALLBACK_DOT_COLOR = "#9ca3af";

function ColorDot({ color }: Readonly<{ color: string }>) {
  const resolvedColor = !color || color === "none" ? FALLBACK_DOT_COLOR : color;
  return (
    <span
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: resolvedColor }}
    />
  );
}

function TextCell({ value }: Readonly<{ value: CustomFieldValueDetail }>) {
  const text = value.textValue ?? value.displayValue ?? "";
  if (!text) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }
  if (text.length <= MAX_TEXT_LENGTH) {
    return <span className="text-sm">{text}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default text-sm">
          {text.slice(0, MAX_TEXT_LENGTH)}…
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs break-words">{text}</TooltipContent>
    </Tooltip>
  );
}

function NumberCell({ value }: Readonly<{ value: CustomFieldValueDetail }>) {
  const display = value.displayValue;
  if (!display) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }
  return <span className="text-sm">{display}</span>;
}

function EnumCell({ value }: Readonly<{ value: CustomFieldValueDetail }>) {
  const enumVal = value.enumValue;
  if (!enumVal) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }
  return (
    <Badge className="flex items-center gap-1" variant="outline">
      <ColorDot color={enumVal.color} />
      <span>{enumVal.name}</span>
    </Badge>
  );
}

function MultiEnumCell({ value }: Readonly<{ value: CustomFieldValueDetail }>) {
  const values = value.multiEnumValues;
  if (!values || values.length === 0) {
    if (value.displayValue) {
      return <span className="text-sm">{value.displayValue}</span>;
    }
    return <span className="text-muted-foreground text-sm">—</span>;
  }
  const visible = values.slice(0, MAX_ENUM_BADGES);
  const overflow = values.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((opt) => (
        <Badge
          className="flex items-center gap-1"
          key={opt.id}
          variant="outline"
        >
          <ColorDot color={opt.color} />
          <span>{opt.name}</span>
        </Badge>
      ))}
      {overflow > 0 && (
        <span className="text-muted-foreground text-xs">+{overflow}</span>
      )}
    </div>
  );
}

function DateCell({ value }: Readonly<{ value: CustomFieldValueDetail }>) {
  if (!value.dateValue) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }
  return <span className="text-sm">{formatDate(value.dateValue)}</span>;
}

function PeopleCell({ value }: Readonly<{ value: CustomFieldValueDetail }>) {
  const people = value.peopleValues;
  if (!people || people.length === 0) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }
  const visible = people.slice(0, MAX_PEOPLE_AVATARS);
  const overflow = people.length - visible.length;
  return (
    <div className="flex items-center">
      <div className="flex -space-x-1">
        {visible.map((user) => {
          const initials = getUserInitials(user.firstName, user.lastName);
          const name = getUserDisplayName(user);
          return (
            <Tooltip key={user.id}>
              <TooltipTrigger asChild>
                <Avatar className="size-6 border-2 border-background">
                  {user.avatarUrl ? (
                    <AvatarImage alt={name} src={user.avatarUrl} />
                  ) : null}
                  <AvatarFallback className="text-[10px]">
                    {initials}
                  </AvatarFallback>
                </Avatar>
              </TooltipTrigger>
              <TooltipContent>{name}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      {overflow > 0 && (
        <span className="ml-1 text-muted-foreground text-xs">+{overflow}</span>
      )}
    </div>
  );
}

export function CustomFieldCell({ value }: Readonly<CustomFieldCellProps>) {
  if (value.fieldType === CustomFieldType.Text) {
    return <TextCell value={value} />;
  }
  if (value.fieldType === CustomFieldType.Number) {
    return <NumberCell value={value} />;
  }
  if (value.fieldType === CustomFieldType.Enum) {
    return <EnumCell value={value} />;
  }
  if (value.fieldType === CustomFieldType.MultiEnum) {
    return <MultiEnumCell value={value} />;
  }
  if (value.fieldType === CustomFieldType.Date) {
    return <DateCell value={value} />;
  }
  if (value.fieldType === CustomFieldType.People) {
    return <PeopleCell value={value} />;
  }
  return <span className="text-muted-foreground text-sm">—</span>;
}
