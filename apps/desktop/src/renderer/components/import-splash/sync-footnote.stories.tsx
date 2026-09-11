import type { ReactNode } from "react";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
  TranscriptSyncStatus,
  type TranscriptSyncStatusCounts,
  type TranscriptSyncStatusSnapshot,
} from "../../../shared/transcript-sync-status-contract";
import { SyncFootnote } from "./sync-footnote";
import {
  deriveSyncFootnoteState,
  SYNC_FOOTNOTE_LABELS,
  SyncFootnoteState,
  type TranscriptSyncStatusRead,
} from "./sync-footnote-state";

// ISS-4716 / ISS-5348: the import-splash footer's sync line, every state at once.
// This line replaced a hardcoded "Computed on this device · 0 bytes uploaded"
// that rendered identically under every sync tier — it could not tell a user who
// had never connected apart from one whose uploads were dead-lettering. What
// replaced it is a ten-state matrix with ten icons, ten strings, a skeleton, and
// exactly one coloured tone, and until this file existed nothing mounted it, so
// nobody could eyeball the tone and copy consistency the whole ticket is about.
// Two things the canvas is here to make visible:
// 1. **Only a genuine problem is coloured, and no state is green.** A success
//    tone is what made the original copy read as a privacy guarantee it had not
//    earned. `Failed` is the single warning row, and its icon carries the tone
//    too — a warning string beside a muted alert triangle reads as a mistake.
// 2. **Two states render no text at all.** `Loading` is a skeleton sized to the
//    settled row so the read landing does not shift the splash, and
//    `Unavailable` renders nothing: a failed read is a fact about us, not an
//    answer about the user's uploads.
/**
 * A one line footer in the import splash reporting honest transcript sync
 * status, never a fabricated byte count or a spinner standing in for the
 * truth.
 */
const meta = {
  title: "Composites/App Shell/Import Splash Sync Footnote",
  component: SyncFootnote,
  tags: ["autodocs"],
  // `Matrix` already renders every member of the union and each row supplies its
  // own state, so a control here would edit an arg no render function reads.
  argTypes: {
    state: { control: false },
  },
  parameters: {
    layout: "centered",
  },
};

export default meta;

/** Every state, in derivation order, with what each one actually means. */
export const Matrix = {
  render: () => (
    <div className="flex min-w-md flex-col gap-4">
      {STATE_NOTES.map(({ state, note }) => (
        <div className="flex flex-col gap-1" key={state}>
          <div className="flex min-h-4 items-center">
            <SyncFootnote state={state} />
          </div>
          <p className="text-muted-foreground text-xs">
            <span className="font-medium text-foreground">{state}</span> ·{" "}
            {note}
          </p>
        </div>
      ))}
    </div>
  ),
};

/**
 * The states that render NO text, next to a settled row for scale. The skeleton
 * is `h-4` on purpose: `ToneLabel` is `text-xs`, whose 1rem line box is taller
 * than the 0.875rem icon beside it, so a shorter skeleton would grow the footer
 * the moment the read lands — and in Scanning, Ready and Failed no sibling line
 * holds the row open, so that 4px would move the whole splash.
 */
export const WordlessStates = {
  render: () => (
    <div className="flex min-w-md flex-col gap-4">
      {renderScenario({
        caption:
          "Loading - a skeleton, never a placeholder string. Copy that appears and is then replaced is a reflow, and it invites reading a pending status as a settled one.",
        state: SyncFootnoteState.Loading,
      })}
      {renderScenario({
        caption:
          "Unavailable - renders nothing. The read did not land; a boot splash is no place to volunteer a non-answer to a question nobody asked.",
        state: SyncFootnoteState.Unavailable,
      })}
      {renderScenario({
        caption:
          "Enabled - a settled row, for height comparison. The swap from the skeleton above must not move anything.",
        state: SyncFootnoteState.Enabled,
      })}
    </div>
  ),
};

/**
 * The states fed through the REAL derivation rather than named directly, so what
 * the canvas shows is what the running app would decide — not a copy of it.
 *
 * The unresolved-policy case is the ISS-5348 fix: the egress gate fails closed
 * on an org policy that has not resolved, and this splash renders at boot, which
 * is exactly when that window is open. It used to print "Transcript upload isn't
 * active" as settled fact and then flip a poll later.
 */
export const DerivedFromSnapshots = {
  render: () => (
    <div className="flex min-w-md flex-col gap-4">
      {renderDerived({
        caption:
          "Org policy has not resolved yet, online - pending, not a denial. This is the state the boot splash used to get wrong.",
        read: readyRead({ tierGate: TranscriptEgressGate.Unresolved }),
      })}
      {renderDerived({
        caption:
          "Same unresolved policy, but offline - the settled truth wins. `Unknown` never times out, so holding the skeleton here would be a spinner that never lands.",
        read: readyRead({
          online: false,
          tierGate: TranscriptEgressGate.Unresolved,
        }),
      })}
      {renderDerived({
        caption:
          "A terminally dead-lettered transcript - the one warning row. It outranks going offline, because `dead` can only have been written while the lane WAS running.",
        read: readyRead({ statusCounts: census(TranscriptSyncStatus.Dead) }),
      })}
      {renderDerived({
        caption:
          "The user's own toggle is off - attributed, unlike the two denials they cannot fix.",
        read: readyRead({ enabled: false }),
      })}
    </div>
  ),
};

type FootnoteScenario = {
  /** What this row is showing, for the reader of the canvas. */
  caption: string;
  state: SyncFootnoteState;
};

type DerivedScenario = {
  caption: string;
  read: TranscriptSyncStatusRead;
};

/** One row per state, in the order `deriveSyncFootnoteState` decides them. */
const STATE_NOTES: ReadonlyArray<{ state: SyncFootnoteState; note: string }> = [
  {
    state: SyncFootnoteState.Loading,
    note: "the read has not resolved yet, or the org policy is still in flight",
  },
  {
    state: SyncFootnoteState.Unavailable,
    note: "the read failed, the bridge is absent, or the database is not up",
  },
  {
    state: SyncFootnoteState.Disabled,
    note: "their own toggle - the only one of the three negatives they can undo",
  },
  {
    state: SyncFootnoteState.Inactive,
    note: "a settled consent-tier or org-policy denial, cause not attributable",
  },
  {
    state: SyncFootnoteState.NotConnected,
    note: "no compute target or sign-in, so the drain cannot tick",
  },
  {
    state: SyncFootnoteState.Failed,
    note: "terminally dead-lettered - the only warning tone in the matrix",
  },
  {
    state: SyncFootnoteState.Uploading,
    note: "claimed for upload; pending-framed, since a crash strands rows here",
  },
  { state: SyncFootnoteState.Queued, note: "queued behind the drain" },
  { state: SyncFootnoteState.Retrying, note: "failed transiently, will retry" },
  {
    state: SyncFootnoteState.Enabled,
    note: "configured and operative - configuration, never a completion claim",
  },
];

/** A census with one row in each named status, and zero everywhere else. */
function census(
  ...statuses: TranscriptSyncStatus[]
): TranscriptSyncStatusCounts {
  const counts = emptyTranscriptStatusCounts();
  for (const status of statuses) {
    counts[status] += 1;
  }
  return counts;
}

/** A fully-permitted, operative lane; each scenario overrides one dimension. */
function readyRead(
  overrides: Partial<TranscriptSyncStatusSnapshot> = {}
): TranscriptSyncStatusRead {
  return {
    state: "ready",
    snapshot: {
      enabled: true,
      online: true,
      tierGate: TranscriptEgressGate.Allowed,
      storeReady: true,
      statusCounts: emptyTranscriptStatusCounts(),
      ...overrides,
    },
  };
}

function renderScenario({ caption, state }: FootnoteScenario): ReactNode {
  return (
    <div className="flex flex-col gap-1" key={caption}>
      {/* `min-h-4` so the wordless states still occupy the settled row's
          height here, making the no-shift claim visible rather than asserted. */}
      <div className="flex min-h-4 items-center">
        <SyncFootnote state={state} />
      </div>
      <p className="text-muted-foreground text-xs">{caption}</p>
    </div>
  );
}

function renderDerived({ caption, read }: DerivedScenario): ReactNode {
  const state = deriveSyncFootnoteState(read);
  const label = SYNC_FOOTNOTE_LABELS[state];
  return (
    <div className="flex flex-col gap-1" key={caption}>
      <div className="flex min-h-4 items-center">
        <SyncFootnote state={state} />
      </div>
      <p className="text-muted-foreground text-xs">
        <span className="font-medium text-foreground">{state}</span>
        {label ? "" : " (renders no text)"} · {caption}
      </p>
    </div>
  );
}
