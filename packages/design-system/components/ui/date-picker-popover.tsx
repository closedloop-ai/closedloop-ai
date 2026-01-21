"use client";

import * as React from "react";
import { CalendarIcon, XIcon } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@repo/design-system/lib/utils";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { Calendar } from "@repo/design-system/components/ui/calendar";

interface DatePickerPopoverProps {
  /** Currently selected date */
  value?: Date | null;
  /** Callback when date is selected */
  onSelect: (date: Date | null) => void;
  /** Placeholder text when no date is selected */
  placeholder?: string;
  /** Whether to show the trigger as just an icon (for inline use) */
  iconOnly?: boolean;
  /** Trigger element (optional, defaults to calendar icon button) */
  trigger?: React.ReactNode;
  /** Disable the popover */
  disabled?: boolean;
  /** Additional class name for trigger */
  className?: string;
  /** Date format string (default: "MMM d, yyyy") */
  dateFormat?: string;
  /** Disable dates before this date */
  fromDate?: Date;
  /** Disable dates after this date */
  toDate?: Date;
}

/**
 * DatePickerPopover provides a calendar dropdown for selecting a date
 * Can be used inline in tables with icon-only mode
 */
function DatePickerPopover({
  value,
  onSelect,
  placeholder = "Select date...",
  iconOnly = false,
  trigger,
  disabled = false,
  className,
  dateFormat = "MMM d, yyyy",
  fromDate,
  toDate,
}: DatePickerPopoverProps) {
  const [open, setOpen] = React.useState(false);

  const handleSelect = (date: Date | undefined) => {
    onSelect(date || null);
    setOpen(false);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(null);
  };

  const defaultTrigger = iconOnly ? (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-8 w-8 text-muted-foreground hover:text-foreground", className)}
      disabled={disabled}
    >
      <CalendarIcon className="h-4 w-4" />
      <span className="sr-only">{placeholder}</span>
    </Button>
  ) : (
    <Button
      variant="outline"
      role="combobox"
      aria-expanded={open}
      className={cn(
        "w-[200px] justify-start text-left font-normal",
        !value && "text-muted-foreground",
        className
      )}
      disabled={disabled}
    >
      <CalendarIcon className="mr-2 h-4 w-4" />
      {value ? (
        <div className="flex items-center justify-between flex-1">
          <span>{format(value, dateFormat)}</span>
          <XIcon
            className="h-4 w-4 opacity-50 hover:opacity-100"
            onClick={handleClear}
          />
        </div>
      ) : (
        <span>{placeholder}</span>
      )}
    </Button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger || defaultTrigger}</PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value || undefined}
          onSelect={handleSelect}
          initialFocus
          disabled={
            fromDate && toDate
              ? { before: fromDate, after: toDate }
              : fromDate
                ? { before: fromDate }
                : toDate
                  ? { after: toDate }
                  : undefined
          }
        />
        {value && (
          <div className="border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              onClick={() => {
                onSelect(null);
                setOpen(false);
              }}
            >
              Clear date
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export { DatePickerPopover };
export type { DatePickerPopoverProps };
