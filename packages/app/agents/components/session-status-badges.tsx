"use client";

import {
  DISPLAYED_SESSION_STATUS,
  type DisplayedSessionStatus,
  isDisplayOnlySessionStatus,
  normalizeDisplayedSessionStatus,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import {
  SESSION_STALE_TOOLTIP,
  SESSION_STATUS_LABELS,
  SESSION_UNKNOWN_TOOLTIP,
} from "@repo/api/src/types/session-status-display";
import {
  CloudSyncDisclosure,
  getCloudSyncDisclosureCopy,
} from "@repo/app/agents/components/sessions/cloud-sync-state-badge";
import { resolveHarnessDisplayConfig } from "@repo/app/agents/lib/harness-labels";
import {
  SESSION_STATUS_SYNC_BADGE_TEST_ID,
  SessionSyncPresentation,
} from "@repo/app/agents/lib/session-sync-presentation";
import type {
  AgentStatus,
  Harness,
  SessionStatus,
} from "@repo/app/agents/lib/session-types";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import type { Tone } from "@repo/design-system/components/ui/types";

type StatusBadgeConfig = {
  label: string;
  tone: Tone;
  pulse?: boolean;
  /** Hover copy explaining a pill whose label is a hedge rather than a state. */
  tooltip?: string;
  /** Set whenever `tooltip` is, since the tooltip is hover-only. */
  ariaLabel?: string;
};

// Labels come from the canonical SESSION_STATUS_LABELS vocabulary (SSOT) so the
// list badge, the detail view, and the legacy `failed` alias all render the same
// text for equivalent states (e.g. ERROR is "Failed", never "Error"). Only the
// presentation (tone/pulse) is owned here.
const sessionStatusConfig: Record<DisplayedSessionStatus, StatusBadgeConfig> = {
  [SESSION_STATUS.ACTIVE]: {
    label: SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE],
    tone: "success",
    pulse: true,
  },
  // ISS-4586: the terminal-but-not-failed state (supersedes completed/abandoned).
  [SESSION_STATUS.INACTIVE]: {
    label: SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE],
    tone: "muted",
  },
  [SESSION_STATUS.ERROR]: {
    label: SESSION_STATUS_LABELS[SESSION_STATUS.ERROR],
    tone: "danger",
  },
  // ISS-4586: `waiting` is not a stored status — it is the DISPLAY value
  // `normalizeDisplayedSessionStatus` preserves for a row awaiting input, so it
  // needs a tone. ISS-4654 removed the `completed`/`abandoned` entries that used
  // to sit here: both are retired from the vocabulary and their rows were
  // collapsed to `inactive`, whose tone is already defined above.
  [DISPLAYED_SESSION_STATUS.WAITING]: {
    label: SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.WAITING],
    tone: "accent",
    pulse: true,
  },
  // ISS-4997 / ISS-4998: the two honest non-claims. Deliberately the quietest
  // treatment in the set — `muted`, no pulse. Neither must read as an outcome
  // (`danger` would claim a failure that may not have happened) and neither must
  // read as liveness (the pulse is this file's one signal that a run is alive,
  // and these are the absence of that claim).
  //
  // Both carry a tooltip AND an aria-label (#4324 review). A bare "Unknown" or
  // "Stale" pill leaves the reader worse off than the wrong "Active" did: the
  // old badge was at least a claim they could act on, whereas an unexplained
  // one-word hedge invites the question it refuses to answer. Same shape as the
  // sync presentation below — the aria-label LEADS with the visible label (WCAG
  // 2.5.3 Label in Name) because a hover-only tooltip is unreachable for
  // keyboard and touch users.
  [DISPLAYED_SESSION_STATUS.UNKNOWN]: {
    label: SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.UNKNOWN],
    tone: "muted",
    tooltip: SESSION_UNKNOWN_TOOLTIP,
    ariaLabel: `${SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.UNKNOWN]}, ${SESSION_UNKNOWN_TOOLTIP}`,
  },
  [DISPLAYED_SESSION_STATUS.STALE]: {
    label: SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.STALE],
    tone: "muted",
    tooltip: SESSION_STALE_TOOLTIP,
    ariaLabel: `${SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.STALE]}, ${SESSION_STALE_TOOLTIP}`,
  },
};

const agentStatusConfig: Record<AgentStatus, StatusBadgeConfig> = {
  working: { label: "Working", tone: "success", pulse: true },
  waiting: { label: "Waiting", tone: "accent", pulse: true },
  completed: { label: "Completed", tone: "muted" },
  error: { label: "Error", tone: "danger" },
  idle: { label: "Idle", tone: "default" },
};

function resolveStatusConfig(
  status: string,
  config: Record<string, StatusBadgeConfig>
): StatusBadgeConfig {
  if (status in config) {
    return config[status];
  }

  // ISS-5592 deleted the `failed` special case with the alias it served. It was
  // session vocabulary living on the agent path — `AgentStatus` never had the
  // member — and the fallback below already renders an unrecognized spelling in
  // the same danger tone, so removing it changes only the label's casing on a
  // path no producer reaches.
  return {
    label: status.replace(/[-_]/g, " "),
    tone: "danger",
  };
}

export function SessionStatusBadge({
  status,
  syncPresentation,
}: {
  status: SessionStatus | string;
  /**
   * ISS-4774 / ISS-5036 / ISS-5279: how this row's transport state modulates the
   * Status pill. Set by the shared row mapper (`toSessionTableRowWithSyncFold`)
   * when the displayed run status is Active; absent otherwise, which keeps an
   * unmarked row byte-identical to the plain run-status pill. (The
   * `sessions-status-pill-sync-state` gate that used to guard this was retired
   * ON by ISS-5366.)
   *
   * It never REPLACES the pill's label — that is ISS-5279's whole point. The
   * lifecycle word stays, and sync rides on the pill's presentation (a pulse, a
   * tooltip, an accessible name). See {@link SessionSyncPresentation} for why
   * "not syncing" has two meanings and only one of them is finished.
   */
  syncPresentation?: SessionSyncPresentation;
}) {
  // ISS-4586: fold to the DISPLAY vocabulary before the config lookup, so a
  // recognized alias reuses its canonical tone instead of rendering a red
  // raw-string badge. `waiting` survives the fold on purpose — it is the
  // awaiting-input sub-state the list projects and it needs its own tone.
  // The mapping itself is `normalizeDisplayedSessionStatus`; do not restate it
  // here (ISS-6581 — the sentence that used to, claiming an `abandoned` row
  // renders muted "Inactive", outlived the fold that made it true).
  //
  // ISS-4997: an UNRECOGNIZED value still degrades to the in-flight "Active"
  // here — the legacy fail-open default this batch dark-launches a replacement
  // for.
  //
  // The DISPLAY-ONLY members (`unknown`, `stale`) are matched BEFORE that fold,
  // never through it (#4324): `normalizeSessionStatus` deliberately fail-opens
  // them to `active` for its other consumers, so routing them through it here
  // would render the row mapper's honest "Stale" as a pulsing green "Active" —
  // the exact lie the mapper just removed. Since ISS-5366 retired the
  // `sessions-honest-unknown-states` gate ON, the mapper writes these values
  // onto `status` for every user, so this branch is live, not dark.
  const displayedStatus = isDisplayOnlySessionStatus(status)
    ? status
    : normalizeDisplayedSessionStatus(status);
  const config = resolveStatusConfig(displayedStatus, sessionStatusConfig);
  const syncCopy = syncPresentation
    ? SYNC_PRESENTATION_COPY[syncPresentation]
    : null;
  if (syncCopy) {
    // ISS-5279: ONE pill, and it is the pill that was already there. ISS-4848
    // stacked a "Syncing" pill beside "Active"; ISS-5036 replaced "Active" with
    // it and moved liveness to a dot in the Name cell. Both spent a slot in the
    // Status vocabulary — a closed lifecycle set — on a fact about transport,
    // and Mike filed the leftover duplicate repeatedly.
    //
    // Sync is an ORTHOGONAL dimension: a row can be Active AND syncing, or
    // Completed AND behind. So it modulates how the lifecycle pill is drawn
    // instead of competing for its slot. The label stays, the pill pulses, the
    // sentence lives in a tooltip — one pill, no second pill, no dot, and the
    // Status column finally agrees with the facet filter and the Status sort
    // that ISS-5036 knowingly diverged from.
    //
    // The motion is NEVER the only carrier (WCAG 1.4.1). A reduce-motion
    // preference holds the ring still instead of pulsing it, so the mark is
    // still SEEN; the accessible name and the tooltip carry it for a reader who
    // sees neither. And the label never dims — the ring is outside the content
    // box precisely so the status word keeps its contrast (Parker, PR review).
    //
    // ONE animation on a 24px pill, not two (PR review). The status config's own
    // `pulse` fades the dot on every Active row to say the RUN is live, and the
    // ring swells on the same 1.6s beat to say the RECORD is uploading — at that
    // size nobody decodes them as two facts, they just read as one busy pill.
    // The ring is the mark this treatment is FOR, and the word "Active" is
    // already sitting beside it carrying liveness, so the dot pulse yields.
    //
    // `tabIndex` because a `<span>` pill is not natively focusable, so Radix's
    // hover-and-focus tooltip would have been hover-only — the exact gap the
    // ISS-4846 aria-label note called out and worked around. The name still
    // LEADS with the visible word (WCAG 2.5.3 Label in Name); the sync clause
    // follows it.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <ToneBadge
            aria-label={`${config.label}, ${syncCopy.ariaSuffix}`}
            data-session-sync-state={syncPresentation}
            data-testid={SESSION_STATUS_SYNC_BADGE_TEST_ID}
            label={config.label}
            pulse={false}
            pulseRing
            tabIndex={0}
            tone={config.tone}
          />
        </TooltipTrigger>
        <TooltipContent>{syncCopy.tooltip}</TooltipContent>
      </Tooltip>
    );
  }
  // #4324: the two honest non-claims carry a tooltip + accessible name; every
  // other status keeps the bare pill it has always rendered. A display-only
  // status can never carry a `syncPresentation` — `resolveSessionSyncPresentation`
  // refuses to derive one for a row displaying Unknown/Stale — so this branch and
  // the one above cannot both want the tooltip slot.
  return config.tooltip ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToneBadge
          aria-label={config.ariaLabel}
          label={config.label}
          pulse={config.pulse}
          tone={config.tone}
        />
      </TooltipTrigger>
      <TooltipContent>{config.tooltip}</TooltipContent>
    </Tooltip>
  ) : (
    <ToneBadge label={config.label} pulse={config.pulse} tone={config.tone} />
  );
}

export function AgentStatusBadge({ status }: { status: AgentStatus | string }) {
  const config = resolveStatusConfig(status, agentStatusConfig);
  return (
    <ToneBadge label={config.label} pulse={config.pulse} tone={config.tone} />
  );
}

export function HarnessBadge({ harness }: { harness?: Harness | null }) {
  // #4480: the label + tone come from the hoisted `harness-labels` map, so the
  // Sessions "Group by" band header (which is React-free and cannot import this
  // module) names a harness the same word this badge does.
  const config = resolveHarnessDisplayConfig(harness);

  return <ToneBadge label={config.label} tone={config.tone} />;
}

/**
 * ISS-5279: the copy each {@link SessionSyncPresentation} adds to the Status
 * pill.
 *
 * `Record`-keyed for compile-time exhaustiveness: a new presentation member
 * cannot ship without someone writing the sentence a user reads. The ring is not
 * a per-member choice — every presentation this map covers is an upload in
 * flight, which is the one thing the ring means.
 *
 * `ariaSuffix` is a CLAUSE, not a sentence — it is appended after the pill's
 * visible label ("Active, syncing, transcript still uploading."), so the
 * accessible name leads with the word on screen (WCAG 2.5.3 Label in Name) and
 * a voice-control user saying "click Active" still matches.
 */
const SYNC_PRESENTATION_COPY: Record<
  SessionSyncPresentation,
  {
    tooltip: string;
    ariaSuffix: string;
  }
> = {
  // ISS-4848: the tooltip is read from the canonical `TranscriptSyncing`
  // disclosure copy rather than restated here. ISS-4846 narrowed the fold to
  // `transcriptDisposition === syncing`, which by the producer's contract means
  // the SESSION is already in the cloud and only its raw transcript blob is
  // behind. Restating it locally is how the list, the detail Sync row, and the
  // transcript panel drifted into three sentences about one fact (#4150).
  [SessionSyncPresentation.Syncing]: {
    tooltip: getCloudSyncDisclosureCopy(CloudSyncDisclosure.TranscriptSyncing)
      .tooltip,
    // ISS-5279 (Parker, PR review): ONE clause, not the tooltip sentence
    // restated. Radix wires the tooltip as `aria-describedby` on the trigger and
    // opens it on focus, so a long name meant a keyboard user heard the same
    // fact twice — the duplication this ticket deletes, moved into the
    // accessibility tree. The name states the fact; the description explains it.
    ariaSuffix: "syncing.",
  },
};
