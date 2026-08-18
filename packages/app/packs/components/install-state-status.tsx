"use client";

import {
  INSTALL_STATE_LABEL,
  type InstallStateTreatment,
  installStateTreatment,
  type PackInstallState,
  UNKNOWN_INSTALL_STATE_LABEL,
} from "@repo/app/packs/lib/install-state";
import {
  FilledStatusCircle,
  StatusRing,
} from "@repo/design-system/components/ui/status-icon-primitives";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

type InstallStateStatusProps = {
  readonly state: PackInstallState;
  /** Icon size in pixels (default 16), matching the DS status-icon sizes. */
  readonly size?: 16 | 20;
  readonly className?: string;
};

/**
 * Renders an install state with its ONE canonical treatment: the single DS
 * `status-icon` glyph/ring from `installStateTreatment` plus the single label
 * from `INSTALL_STATE_LABEL`, said once (icon SHAPE + words, never icon + badge +
 * word). The glyph is `aria-hidden`; the label carries the meaning, so the state
 * reads without color perception. Every packs surface renders an install state
 * through this component so they all read identically. Faithful to the reviewed
 * install-matrix prototype's `CELL_STATUS` treatment.
 */
export const InstallStateStatus = ({
  state,
  size = 16,
  className,
}: InstallStateStatusProps) => {
  const treatment = installStateTreatment(state);
  // INSTALL_STATE_LABEL is exhaustive over the union; the `?? UNKNOWN_STATE_LABEL`
  // is the last-resort net for an unknown wire string a boundary cast to
  // PackInstallState — pairs with installStateTreatment's neutral fallback so an
  // unknown state renders muted, never as an undefined label.
  const label = INSTALL_STATE_LABEL[state] ?? UNKNOWN_INSTALL_STATE_LABEL;
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-sm",
        treatment.emphatic ? "text-foreground" : "text-muted-foreground",
        className
      )}
    >
      {renderTreatmentGlyph(treatment, label, size)}
      {label}
    </span>
  );
};

/**
 * The status-icon glyph for a treatment. The glyph is decorative
 * (`aria-hidden`) — the adjacent text label is the accessible name — so the
 * state is announced exactly once.
 */
function renderTreatmentGlyph(
  treatment: InstallStateTreatment,
  label: string,
  size: 16 | 20
): ReactNode {
  if (treatment.kind === "glyph") {
    return (
      <FilledStatusCircle
        aria-hidden="true"
        fill={treatment.fill}
        glyph={treatment.glyph}
        label={label}
        size={size}
      />
    );
  }
  return (
    <StatusRing
      aria-hidden="true"
      color={treatment.color}
      dashed={treatment.dashed}
      label={label}
      percentage={treatment.thinking ? 45 : 0}
      ringStrokeWidth={treatment.ringStrokeWidth}
      size={size}
      thinking={treatment.thinking}
      trackColor={treatment.trackColor}
    />
  );
}
