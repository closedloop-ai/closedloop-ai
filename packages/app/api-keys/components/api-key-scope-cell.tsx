"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { InfoIcon } from "lucide-react";
import type { ApiKeyScopeDisplay } from "../lib/api-key-scope-display";

/**
 * The Scope cell, shared by the legacy Settings panel and the Settings v2 API
 * Keys panel.
 *
 * Routine scope sets read as plain text alongside the Created and Last used
 * cells; the pill is spent on the states a reader should stop on, so the pill
 * itself is the signal rather than the tone. A state whose meaning needs an
 * explanation gets the design-system Tooltip on a focusable trigger, with a
 * visible info affordance — a native `title` needs a mouse, waits about a
 * second, and never appears for keyboard or touch.
 *
 * Lives beside `getApiKeyScopeDisplay` rather than in either panel: the label
 * half and the rendering half are one concern, and extracting only the label
 * would have left the two panels free to draw the same `Unknown` scope
 * differently — the exact drift the extraction was meant to close.
 */
export function ApiKeyScopeCell({
  scope,
}: Readonly<{ scope: ApiKeyScopeDisplay }>) {
  if (scope.variant === null) {
    return <span className="text-muted-foreground text-sm">{scope.label}</span>;
  }
  if (scope.tooltip === undefined) {
    return <Badge variant={scope.variant}>{scope.label}</Badge>;
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          aria-label={`${scope.label} scope — what this means`}
          className={`cursor-help rounded-full ${CHIP_FOCUS_RING_CLASS}`}
          type="button"
        >
          <Badge variant={scope.variant}>
            {scope.label}
            <InfoIcon aria-hidden="true" />
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{scope.tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
