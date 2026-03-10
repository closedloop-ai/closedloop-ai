"use client";

import type {
  CustomFieldEnumOption,
  CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
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
import { cn } from "@repo/design-system/lib/utils";
import { formatDate } from "@/lib/date-utils";
import { getUserDisplayName, getUserInitials } from "@/lib/user-utils";

const MAX_TEXT_LENGTH = 50;
const MAX_ENUM_BADGES = 2;
const MAX_PEOPLE_AVATARS = 3;

/**
 * Maps color names stored on enum options to Tailwind pill badge classes.
 * Each entry provides a light background, matching text color, and border.
 */
const ENUM_COLOR_STYLES: Record<
  string,
  { bg: string; text: string; border: string }
> = {
  red: {
    bg: "bg-red-50",
    text: "text-red-700",
    border: "border-red-200",
  },
  orange: {
    bg: "bg-orange-50",
    text: "text-orange-700",
    border: "border-orange-200",
  },
  yellow: {
    bg: "bg-yellow-50",
    text: "text-yellow-700",
    border: "border-yellow-200",
  },
  green: {
    bg: "bg-green-50",
    text: "text-green-700",
    border: "border-green-200",
  },
  teal: {
    bg: "bg-teal-50",
    text: "text-teal-700",
    border: "border-teal-200",
  },
  blue: {
    bg: "bg-blue-50",
    text: "text-blue-700",
    border: "border-blue-200",
  },
  purple: {
    bg: "bg-purple-50",
    text: "text-purple-700",
    border: "border-purple-200",
  },
  pink: {
    bg: "bg-pink-50",
    text: "text-pink-700",
    border: "border-pink-200",
  },
};

type CustomFieldCellProps = {
  value: CustomFieldValueDetail;
};

function EnumPill({ option }: Readonly<{ option: CustomFieldEnumOption }>) {
  const colorStyle = ENUM_COLOR_STYLES[option.color];
  if (colorStyle) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full border px-2.5 py-0.5 font-medium text-xs",
          colorStyle.bg,
          colorStyle.text,
          colorStyle.border
        )}
      >
        {option.name}
      </span>
    );
  }
  return <Badge variant="outline">{option.name}</Badge>;
}

function TextCell({ value }: Readonly<{ value: CustomFieldValueDetail }>) {
  const text = value.textValue ?? value.displayValue ?? "";
  if (!text) {
    return <span className="text-muted-foreground text-sm">&mdash;</span>;
  }
  if (text.length <= MAX_TEXT_LENGTH) {
    return <span className="text-sm">{text}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default text-sm">
          {text.slice(0, MAX_TEXT_LENGTH)}&hellip;
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs break-words">{text}</TooltipContent>
    </Tooltip>
  );
}

function NumberCell({ value }: Readonly<{ value: CustomFieldValueDetail }>) {
  const display = value.displayValue;
  if (!display) {
    return <span className="text-muted-foreground text-sm">&mdash;</span>;
  }
  return <span className="text-sm">{display}</span>;
}

function EnumCell({ value }: Readonly<{ value: CustomFieldValueDetail }>) {
  const enumVal = value.enumValue;
  if (!enumVal) {
    return <span className="text-muted-foreground text-sm">&mdash;</span>;
  }
  return <EnumPill option={enumVal} />;
}

function MultiEnumCell({ value }: Readonly<{ value: CustomFieldValueDetail }>) {
  const values = value.multiEnumValues;
  if (!values || values.length === 0) {
    if (value.displayValue) {
      return <span className="text-sm">{value.displayValue}</span>;
    }
    return <span className="text-muted-foreground text-sm">&mdash;</span>;
  }
  const visible = values.slice(0, MAX_ENUM_BADGES);
  const overflow = values.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((opt) => (
        <EnumPill key={opt.id} option={opt} />
      ))}
      {overflow > 0 && (
        <span className="text-muted-foreground text-xs">+{overflow}</span>
      )}
    </div>
  );
}

function DateCell({ value }: Readonly<{ value: CustomFieldValueDetail }>) {
  if (!value.dateValue) {
    return <span className="text-muted-foreground text-sm">&mdash;</span>;
  }
  return <span className="text-sm">{formatDate(value.dateValue)}</span>;
}

function PeopleCell({ value }: Readonly<{ value: CustomFieldValueDetail }>) {
  const people = value.peopleValues;
  if (!people || people.length === 0) {
    return <span className="text-muted-foreground text-sm">&mdash;</span>;
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
  return <span className="text-muted-foreground text-sm">&mdash;</span>;
}
