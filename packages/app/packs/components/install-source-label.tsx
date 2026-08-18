"use client";

/**
 * @file install-source-label.tsx
 * @description Shared, non-color-only source indicator for the Packs surfaces
 * (FEA-4090). Renders "how did I get this pack" — pushed / opted-in / self /
 * required — as a plain text label with an accessible description, never color
 * alone (WCAG 1.4.1). Any Packs surface (web member/admin, desktop) reuses this
 * one component so the source signal reads the same everywhere and no surface
 * re-declares source strings or styling.
 *
 * Provenance is metadata, not status: all sources render in the neutral `muted`
 * tone so a packs list is not a column of four competing colors for something
 * the member cannot act on — the text carries the meaning (non-color-only), and
 * the tone is uniform. Labels reuse the vocabulary the Distribution tab already
 * ships (`MODE_LABEL` in pack-detail.tsx: "Auto-install" / "Opted in") so an
 * admin and a member read the same words for the same state.
 *
 * An unknown / legacy `InstallSource` value falls back to a generic "Installed"
 * label rather than rendering blank or guessing (compat-safe, mirrors the
 * `kindMeta` unknown-kind fallback).
 */

import type { InstallSourceInput } from "@repo/api/src/types/install-source";
import {
  InstallSource,
  resolveInstallSource,
} from "@repo/api/src/types/install-source";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";

type InstallSourceMeta = {
  /** Short label rendered as the visible text (also the accessible name stem). */
  label: string;
  /** Longer accessible name explaining the provenance. */
  description: string;
};

const INSTALL_SOURCE_META: Record<InstallSource, InstallSourceMeta> = {
  [InstallSource.Pushed]: {
    label: "Auto-installed",
    description: "Auto-installed by your organization.",
  },
  [InstallSource.OptedIn]: {
    label: "Opted in",
    description: "Offered by your organization, you opted in.",
  },
  [InstallSource.Self]: {
    label: "Self-installed",
    description: "You installed this yourself.",
  },
  [InstallSource.Required]: {
    label: "Required",
    description: "Required by your organization, cannot be removed.",
  },
  [InstallSource.Unknown]: {
    label: "Installed",
    description: "Installed.",
  },
};

function installSourceMeta(source: InstallSource): InstallSourceMeta {
  // Object.hasOwn (not `?? fallback`) so an inherited property name on a
  // poisoned key can never bypass the generic "Installed" fallback — which is
  // the canonical Unknown entry, so an unmapped source and an explicit Unknown
  // source read identically.
  return Object.hasOwn(INSTALL_SOURCE_META, source)
    ? INSTALL_SOURCE_META[source]
    : INSTALL_SOURCE_META[InstallSource.Unknown];
}

/**
 * Non-color-only source indicator: a plain text label in the neutral `muted`
 * tone. The text carries the meaning (WCAG 1.4.1 — never color alone); the
 * fuller provenance is exposed as the label's accessible name via `title` so it
 * is available to assistive tech.
 */
export function InstallSourceLabel({
  source,
  className,
}: {
  source: InstallSource;
  className?: string;
}) {
  const meta = installSourceMeta(source);
  return (
    <ToneLabel className={className} title={meta.description} variant="muted">
      {meta.label}
    </ToneLabel>
  );
}

/**
 * Convenience wrapper: resolve the {@link InstallSource} and render the label in
 * one step, for call sites that hold the raw {@link InstallSourceInput} (a
 * durable recorded origin, or — for pre-origin packs — the legacy policy fields)
 * rather than an already-resolved source.
 */
export function ResolvedInstallSourceLabel({
  className,
  ...input
}: InstallSourceInput & { className?: string }) {
  return (
    <InstallSourceLabel
      className={className}
      source={resolveInstallSource(input)}
    />
  );
}
