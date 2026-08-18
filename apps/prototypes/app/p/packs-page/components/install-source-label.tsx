"use client";

import { Chip } from "@repo/design-system/components/ui/chip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { InstallSource, sourceMetaFor } from "../mock";

// The FEA-4090 label contract, rendered as icon + text (never color alone) so
// the source is legible without relying on hue. `Required` reads as the
// strongest claim; every other source is a plain muted chip so the surface
// stays calm and one accent isn't spent per row. The tooltip carries the plain
// gloss for what the source means.
type InstallSourceLabelProps = {
  readonly source: InstallSource | string;
};

export const InstallSourceLabel = ({ source }: InstallSourceLabelProps) => {
  const meta = sourceMetaFor(source);
  const Icon = meta.icon;
  const isRequired = source === InstallSource.Required;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* `interactive` + `tabIndex={0}` make the chip focusable so the
            tooltip gloss is reachable by keyboard, not mouse-only. The sr-only
            span carries the description to assistive tech, since a Chip renders
            a plain span whose aria-label a screen reader would otherwise drop. */}
        <Chip
          interactive
          tabIndex={0}
          variant={isRequired ? "accent" : "muted"}
        >
          <Icon aria-hidden="true" />
          {meta.label}
          <span className="sr-only">. {meta.description}</span>
        </Chip>
      </TooltipTrigger>
      <TooltipContent>{meta.description}</TooltipContent>
    </Tooltip>
  );
};
