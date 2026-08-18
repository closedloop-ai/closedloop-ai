"use client";

import { ArrowUpRightIcon, EyeOffIcon } from "lucide-react";

/**
 * Whether a data line is synced to the cloud or kept on the device. Shared by
 * onboarding's sync-consent step and the desktop Settings "Data & Sync" tab so
 * both surfaces tell the same "what leaves the machine vs. what stays local"
 * story from ONE component (FEA-4055). The per-level copy that supplies these
 * lines lives alongside this type in `@repo/app/shared/lib/data-sync-copy` — the
 * ONE copy source both surfaces render from — so there is no second `DataLine`
 * union to keep in sync.
 */
export type DataLineKind = "sync" | "local";

/** One "leaves the device vs. stays local" line for a data-sync tier/level. */
export type DataLine = {
  /** Human-readable data category, e.g. "Prompts & completions". */
  label: string;
  /** Whether this category is uploaded (`sync`) or kept on-device (`local`). */
  kind: DataLineKind;
};

type DataLineRowProps = DataLine & {
  /**
   * Render as an inline `<span>` instead of a `<div>`. Onboarding nests these
   * inside a `<label>`'s span subtree, where a block element is invalid DOM
   * nesting; the desktop Settings card renders them as blocks.
   */
  as?: "div" | "span";
};

// The Lucide glyph is decorative (`aria-hidden`), so the egress status has to be
// carried by real text or screen-reader users get only the category label and
// lose the per-line consent information this row exists to convey. Sighted users
// read the status from the icon (up-and-out arrow vs. muted eye-off) and its
// color; an `sr-only` suffix hands the same signal to assistive tech without
// adding a second visible column that would crowd these already-tall cards.
function egressStatusLabel(kind: DataLineKind): string {
  return kind === "sync" ? "syncs to cloud" : "stays on this device";
}

/**
 * A single data-category row: an icon + the category label + an `sr-only` egress
 * status.
 *
 * A "sync" line means this data LEAVES the device, so it must not read as the
 * reassuring success-green a check implies. A neutral up-and-out arrow says
 * "uploaded" without the all-clear tone; green stays reserved for what stays
 * local. The local line keeps the muted eye-off ("kept private").
 */
export function DataLineRow({ label, kind, as = "div" }: DataLineRowProps) {
  const Wrapper = as;
  const isSync = kind === "sync";
  return (
    <Wrapper className="flex items-center gap-2 text-xs">
      {isSync ? (
        <ArrowUpRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-foreground"
        />
      ) : (
        <EyeOffIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      )}
      <span className={isSync ? "text-foreground" : "text-muted-foreground"}>
        {label}
        <span className="sr-only"> — {egressStatusLabel(kind)}</span>
      </span>
    </Wrapper>
  );
}
