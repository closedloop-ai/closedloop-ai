"use client";

import {
  FilledStatusCircle,
  StatusRing,
} from "@repo/design-system/components/ui/status-icon-primitives";
import type { ReactNode } from "react";
import { InstallState } from "../mock";

// One status per component (Parker: say it once). Each install state maps to
// exactly one status-icon-primitives glyph plus a text label, never icon + badge
// + word for the same state. Status is carried by icon SHAPE and LABEL, not by
// color alone (check / swap glyphs, dashed ring), so it reads without color
// perception. These glyphs match the admin install-matrix's cell-status exactly
// (check = installed, swap = update available, dashed ring = not installed) so
// the same data reads the same way on both surfaces — a filled x / exclamation
// means something WRONG over there, so this member view never reuses them for a
// benign state.

type ComponentStatusConfig = {
  label: string;
  render: (size: 16 | 20) => ReactNode;
  // Not-installed and update-available lift to full foreground weight so the eye
  // lands on what needs action; installed stays muted.
  emphatic: boolean;
};

export const COMPONENT_STATUS: Record<InstallState, ComponentStatusConfig> = {
  [InstallState.Installed]: {
    label: "Installed",
    emphatic: false,
    render: (size) => (
      <FilledStatusCircle
        aria-hidden="true"
        fill="var(--success)"
        glyph="check"
        label="Installed"
        size={size}
      />
    ),
  },
  [InstallState.Updatable]: {
    label: "Update available",
    emphatic: true,
    render: (size) => (
      <FilledStatusCircle
        aria-hidden="true"
        fill="var(--progress-foreground)"
        glyph="swap"
        label="Update available"
        size={size}
      />
    ),
  },
  [InstallState.NotInstalled]: {
    label: "Not installed",
    emphatic: true,
    render: (size) => (
      <StatusRing
        aria-hidden="true"
        color="var(--progress)"
        dashed
        label="Not installed"
        percentage={0}
        size={size}
      />
    ),
  },
};
