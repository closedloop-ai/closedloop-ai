"use client";

import {
  FilledStatusCircle,
  StatusRing,
} from "@repo/design-system/components/ui/status-icon-primitives";
import type { ReactNode } from "react";
import { CellState } from "../mock";

// One status per cell (Parker: say it once). Each state maps to exactly one
// status-icon-primitive glyph/ring plus a text label, never icon + badge + word
// for the same state. Status is carried by icon SHAPE and LABEL, not by color
// alone (a check glyph, an x glyph, a swap glyph, a dashed ring), so it reads
// without color perception. Color is a redundant reinforcement, not the signal.

type CellStatusConfig = {
  label: string;
  // Verb-first accessible name fragment used inside the cell's aria label.
  render: (size: 16 | 20) => ReactNode;
  // Muted-foreground text is the default; a state that needs attention lifts to
  // full foreground weight so the eye lands on it. Never color-only.
  emphatic: boolean;
};

export const CELL_STATUS: Record<CellState, CellStatusConfig> = {
  [CellState.Installed]: {
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
  [CellState.Updatable]: {
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
  [CellState.Converting]: {
    label: "Installing",
    emphatic: true,
    render: (size) => (
      <StatusRing
        aria-hidden="true"
        color="var(--progress-foreground)"
        label="Installing"
        percentage={45}
        size={size}
        thinking
      />
    ),
  },
  [CellState.NotInstalled]: {
    label: "Not installed",
    emphatic: false,
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
  [CellState.OfflineUnknown]: {
    label: "Target offline",
    emphatic: false,
    render: (size) => (
      <StatusRing
        aria-hidden="true"
        color="var(--muted-foreground)"
        label="Target offline"
        percentage={0}
        ringStrokeWidth={1.5}
        size={size}
        trackColor="var(--muted-foreground)"
      />
    ),
  },
  [CellState.Unsupported]: {
    label: "Not supported",
    emphatic: false,
    render: (size) => (
      <FilledStatusCircle
        aria-hidden="true"
        fill="var(--muted-foreground)"
        glyph="x"
        label="Not supported"
        size={size}
      />
    ),
  },
  [CellState.Failed]: {
    label: "Install failed",
    emphatic: true,
    render: (size) => (
      <FilledStatusCircle
        aria-hidden="true"
        fill="var(--destructive)"
        glyph="exclamation"
        label="Install failed"
        size={size}
      />
    ),
  },
};
