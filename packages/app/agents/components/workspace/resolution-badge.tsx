/**
 * FEA-3704 — the ONE resolution badge for the agents workspace, shared across
 * web and desktop (both consume `@repo/app`). Renders the shared resolution
 * DISPLAY model (`deriveResolutionDisplay` + `COMPONENT_RESOLUTION_LABELS` from
 * `@repo/api`) as a truthful Chip: the human label carries the meaning, a
 * tone-mapped variant + glyph carry the severity at a glance, and the honest
 * description reads through the design-system Tooltip like every other hover on
 * the agents surface. No local copy of the states, labels, or severity lives
 * here — this component is purely presentational over the shared model, so web
 * and desktop can never drift.
 */

import type { ComponentResolvedState } from "@repo/api/src/types/agent-component";
import {
  type ComponentResolutionLabel,
  resolutionLabel,
} from "@repo/api/src/types/component-resolution";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import {
  AlertTriangleIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleSlashIcon,
} from "lucide-react";
import type { ComponentType } from "react";

// Surface-neutral tone → design-system Chip variant. The tone lives in the
// shared model (`ComponentResolutionLabel.tone`); this map is the ONE place the
// agents surface binds it to a concrete Chip variant.
const TONE_VARIANT: Record<
  ComponentResolutionLabel["tone"],
  "success" | "muted" | "warning" | "destructive"
> = {
  positive: "success",
  neutral: "muted",
  warning: "warning",
  danger: "destructive",
};

// One glyph per TONE, not per state: the text label already names the state, so
// six distinct icons were noise (and indistinguishable at sm/12px). The glyph is
// a redundant severity cue, mapped from the same shared tone that drives the Chip
// variant, and marked aria-hidden — the label is the non-color a11y channel.
// Exhaustive `Record` so a new tone fails to compile until it is given a glyph.
const TONE_ICON: Record<
  ComponentResolutionLabel["tone"],
  ComponentType<{ className?: string }>
> = {
  positive: CircleCheckIcon,
  neutral: CircleHelpIcon,
  warning: AlertTriangleIcon,
  danger: CircleSlashIcon,
};

/**
 * Render the resolution badge for a component. Accepts the raw resolution
 * metadata the component APIs already ship; derivation + labeling come entirely
 * from the shared model. Optional fingerprint fields are honored when present
 * (stale-definition / contract-mismatch) and ignored when absent, so an older
 * desktop client that only supplies `resolvedState` still renders the correct
 * base state.
 */
export function ResolutionBadge({
  resolvedState,
  observedDefinitionHash,
  currentDefinitionHash,
  normalizerContractVersion,
  className,
}: {
  resolvedState: ComponentResolvedState | string | null | undefined;
  observedDefinitionHash?: string | null;
  currentDefinitionHash?: string | null;
  normalizerContractVersion?: number | null;
  className?: string;
}) {
  const input = {
    resolvedState,
    observedDefinitionHash,
    currentDefinitionHash,
    normalizerContractVersion,
  };
  const meta = resolutionLabel(input);
  const Icon = TONE_ICON[meta.tone];

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {/*
            The trigger is a non-interactive Chip (a <span>), so it is not
            keyboard-focusable by default and a keyboard user could never reach
            the honest description in the tooltip. `interactive` + `tabIndex={0}`
            put it in the tab order and give it a visible focus ring, so the
            description is reachable by keyboard, not just by pointer hover.
          */}
          <Chip
            className={className}
            interactive
            size="sm"
            tabIndex={0}
            variant={TONE_VARIANT[meta.tone]}
          >
            <Icon aria-hidden="true" />
            {meta.label}
          </Chip>
        </TooltipTrigger>
        <TooltipContent>
          <p className="max-w-xs text-xs">{meta.description}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
