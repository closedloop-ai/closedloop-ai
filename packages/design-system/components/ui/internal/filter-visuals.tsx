import { PersonAvatar } from "@closedloop-ai/design-system/components/ui/person-avatar";
import type { TableFilterOption } from "@closedloop-ai/design-system/components/ui/table-filters";
import { avatarInitial } from "../avatar";

export function OptionLeadingVisual({
  option,
}: Readonly<{ option: TableFilterOption }>) {
  if (option.avatarUrl) {
    return (
      <PersonAvatar
        avatarUrl={option.avatarUrl}
        className="size-5"
        fallbackClassName="text-[10px]"
        initials={getInitials(option.label)}
        name={option.label}
      />
    );
  }

  return null;
}

export function TagVisual({ option }: Readonly<{ option: TableFilterOption }>) {
  return (
    <div className="inline-flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-full border"
        style={{ backgroundColor: option.color, borderColor: option.color }}
      />
    </div>
  );
}

export function OptionCount({ count }: Readonly<{ count?: number }>) {
  if (count === undefined) {
    return null;
  }

  return <span className="text-muted-foreground text-xs">{count}</span>;
}

/** One initial on every avatar (Nerys, 2026-10-22); "?" for a blank name. */
export function getInitials(name: string): string {
  return avatarInitial(name, "?");
}
