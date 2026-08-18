import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import {
  ToneLabel,
  toneTextClass,
} from "@closedloop-ai/design-system/components/ui/tone-label";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import {
  CircleHelpIcon,
  CloudIcon,
  CloudOffIcon,
  CloudUploadIcon,
  type LucideIcon,
  RefreshCwIcon,
  ShieldIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  SYNC_FOOTNOTE_LABELS,
  SYNC_FOOTNOTE_TONES,
  SyncFootnoteState,
} from "./sync-footnote-state";

/**
 * `Record`-keyed alongside the label and tone maps, so a new state cannot ship
 * without deciding all three.
 */
const SYNC_FOOTNOTE_ICONS: Record<SyncFootnoteState, LucideIcon> = {
  // Unused — `Loading` renders a skeleton and `Unavailable` renders nothing at
  // all, so neither reaches an icon+label row. Present so the map stays
  // exhaustive over the union: a new state must still choose an icon here.
  [SyncFootnoteState.Loading]: CircleHelpIcon,
  [SyncFootnoteState.Unavailable]: CircleHelpIcon,
  [SyncFootnoteState.Disabled]: CloudOffIcon,
  [SyncFootnoteState.Inactive]: ShieldIcon,
  [SyncFootnoteState.NotConnected]: CloudOffIcon,
  [SyncFootnoteState.Failed]: TriangleAlertIcon,
  [SyncFootnoteState.Uploading]: CloudUploadIcon,
  [SyncFootnoteState.Queued]: CloudIcon,
  [SyncFootnoteState.Retrying]: RefreshCwIcon,
  [SyncFootnoteState.Enabled]: CloudIcon,
};

/**
 * ISS-4716: the import-splash footer's sync line.
 *
 * ISS-5348: this ships unconditionally. It was built behind a default-off Labs
 * flag (now retired), whose off-path returned the previous hardcoded
 * node — "Computed on this device · 0 bytes uploaded" — byte for byte. That is
 * a safe rollout shape and is exactly why nobody noticed the fix never rolled
 * out: three tickets "fixed" that string and every user on defaults still saw
 * it. The flag and its legacy branch are gone, so the literal is unreachable.
 *
 * Note what this does NOT do: it never shows a byte figure. The only available
 * source is a 100-row, mtime-ordered sample, so any total computed from it
 * would be a *sample* dressed up as a total — swapping a hardcoded lie for a
 * computed one that looks authoritative. See `sync-footnote-state.ts` for the
 * two honesty rules the states encode.
 */
export function SyncFootnote({ state }: { state: SyncFootnoteState }) {
  if (state === SyncFootnoteState.Loading) {
    // A skeleton, never text: copy that appears and is then replaced is a
    // reflow, and a placeholder string invites reading a not-yet-resolved status
    // as a settled one — the conflation this whole change exists to remove.
    // `h-4` matches the settled row exactly: `ToneLabel` is `text-xs`, whose
    // 1rem line box is taller than the 0.875rem icon beside it. A shorter
    // skeleton would grow the footer the moment the read lands, and in Scanning,
    // Ready and Failed there is no sibling line holding the row open, so that
    // would shift the whole splash.
    return <Skeleton aria-label="Loading upload status" className="h-4 w-52" />;
  }
  if (state === SyncFootnoteState.Unavailable) {
    // ISS-5348 (review): render NOTHING. This state says our own read failed —
    // it is not a fact about the user's uploads, and a boot splash is no place
    // to volunteer a non-answer to a question they did not ask. The footer's
    // other content simply takes the row.
    return null;
  }
  const tone = SYNC_FOOTNOTE_TONES[state];
  const Icon = SYNC_FOOTNOTE_ICONS[state];
  return (
    <span className="flex items-center gap-1.5">
      {/* The icon takes the row's tone from the same map the label does. Pinning
          it muted left the one state the tone map calls a real problem drawing
          its alert triangle in the calm colour beside warning-coloured text. */}
      <Icon
        aria-hidden="true"
        className={cn("size-3.5 shrink-0", toneTextClass(tone))}
      />
      <ToneLabel variant={tone}>{SYNC_FOOTNOTE_LABELS[state]}</ToneLabel>
    </span>
  );
}
