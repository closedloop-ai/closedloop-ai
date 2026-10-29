import { Checkbox } from "@closedloop-ai/design-system/components/ui/checkbox";
import { DropdownMenuItem } from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import type { TableFilterOption } from "@closedloop-ai/design-system/components/ui/table-filters";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { ReactNode } from "react";
import { OptionLeadingVisual } from "./filter-visuals";

/** Shared selectable row shell for v1 and v2 filter popovers. */
export function FilterRow({
  checked,
  children,
  onToggle,
}: Readonly<{
  checked: boolean;
  children: ReactNode;
  onToggle: () => void;
}>) {
  return (
    <DropdownMenuItem
      className="gap-2"
      onSelect={(event) => {
        event.preventDefault();
        onToggle();
      }}
    >
      <Checkbox
        checked={checked}
        className="[&_svg]:!text-current pointer-events-none"
      />
      {children}
    </DropdownMenuItem>
  );
}

/** Renders an option's custom body or label with an optional identity avatar. */
export function FilterOptionContent<TValue extends string>({
  checked,
  option,
}: Readonly<{
  checked: boolean;
  option: TableFilterOption<TValue>;
}>) {
  if (option.content) {
    return option.content;
  }
  return (
    <>
      <OptionLeadingVisual option={option} />
      <span
        className={cn("min-w-0 flex-1 truncate", checked && "font-medium")}
      >
        {option.label}
      </span>
    </>
  );
}
