"use client";

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@closedloop-ai/design-system/components/ui/tooltip";
import type { LucideIcon } from "lucide-react";
import {
  ArrowUpDownIcon,
  LayersIcon,
  PlusIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

/**
 * Toolbar affordances from the redesigned table mockups (Sort / Group / Options
 * / primary "New …") that have no backing implementation yet. Rendered dimmed +
 * disabled with a tooltip so the design direction is visible and flagged as
 * not-functional pending the wiring fast-follow. Data-agnostic and shared across
 * surfaces; pass a functional control (e.g. a Filter menu) via `leading`.
 */
export function TablePlaceholderActions({
  primaryLabel,
  leading,
}: {
  /** Label for the primary "New …" button. Omit to render no primary action. */
  primaryLabel?: string;
  /** Functional control(s) rendered before the placeholder buttons (e.g. a real
   * Filter menu). */
  leading?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {leading}
      <PlaceholderButton icon={ArrowUpDownIcon} label="Sort" />
      <PlaceholderButton icon={LayersIcon} label="Group" />
      <PlaceholderButton icon={SlidersHorizontalIcon} label="Options" />
      {primaryLabel ? (
        <PlaceholderButton
          icon={PlusIcon}
          label={primaryLabel}
          variant="default"
        />
      ) : null}
    </div>
  );
}

function PlaceholderButton({
  icon: Icon,
  label,
  variant = "outline",
}: {
  icon: LucideIcon;
  label: string;
  variant?: "default" | "outline";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Span receives hover events the disabled button suppresses. */}
        <span className="inline-flex">
          <Button
            className="opacity-60"
            disabled
            type="button"
            variant={variant}
          >
            <Icon className="size-4" />
            {label}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>Not yet wired up — coming soon</TooltipContent>
    </Tooltip>
  );
}
