"use client";

import {
  type DisplayedSessionStatus,
  foldToDisplayedSessionStatus,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import {
  CloudSyncDisclosure,
  getCloudSyncDisclosureCopy,
} from "@repo/app/agents/components/sessions/cloud-sync-state-badge";
import {
  resolveHarnessDisplayConfig,
  resolveHonestHarnessDisplayConfig,
} from "@repo/app/agents/lib/harness-labels";
import {
  SESSION_STATUS_SYNC_BADGE_TEST_ID,
  SessionSyncPresentation,
} from "@repo/app/agents/lib/session-sync-presentation";
import type {
  AgentStatus,
  Harness,
  SessionStatus,
} from "@repo/app/agents/lib/session-types";
import { ArtifactStatus as UniversalArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { sessionStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  STATUS_PULSE_RING_FOCUS_ORIGIN_HANDLERS,
  STATUS_PULSE_RING_HOST_CLASS_NAME,
  ToneBadge,
} from "@repo/design-system/components/ui/primitives/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import type { Tone } from "@repo/design-system/components/ui/types";
import { cn } from "@repo/design-system/lib/utils";

type StatusBadgeConfig = {
  label: string;
  tone: Tone;
  pulse?: boolean;
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
  // `completed`/`abandoned`/`waiting`/`unknown`/`stale` all fold to one of the
  // three tones above before this map is ever consulted, so none needs its own.
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
  artifactId,
  status,
  syncPresentation,
}: {
  /** Real artifact identity required by the universal status view contract. */
  artifactId?: string;
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
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  // ISS-4586: fold to the DISPLAY vocabulary before the config lookup, so a
  // recognized alias reuses its canonical tone instead of rendering a red
  // raw-string badge. An unrecognized value degrades to Active, the fail-open
  // every fold in this vocabulary shares.
  const displayedStatus = foldToDisplayedSessionStatus(status);
  const config = resolveStatusConfig(displayedStatus, sessionStatusConfig);
  const syncCopy = syncPresentation
    ? SYNC_PRESENTATION_COPY[syncPresentation]
    : null;
  if (champion && artifactId) {
    // ISS-10364 (operator ruling): an unparsable session status reads Active
    // everywhere, so the champion is fed the folded displayed status only and
    // never sees the raw value that would make it render Unknown.
    const view = sessionStatusView(artifactId, displayedStatus);
    const statusBadge = (
      <UniversalArtifactStatus
        variant={ArtifactStatusVariant.Badge}
        view={view}
      />
    );
    if (syncCopy) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={`${artifactStatusLabel(view)}, ${syncCopy.ariaSuffix}`}
              className={cn(
                "inline-flex rounded-full border-0 bg-transparent p-0",
                STATUS_PULSE_RING_HOST_CLASS_NAME
              )}
              data-session-sync-state={syncPresentation}
              data-testid={SESSION_STATUS_SYNC_BADGE_TEST_ID}
              type="button"
              {...STATUS_PULSE_RING_FOCUS_ORIGIN_HANDLERS}
            >
              <span aria-hidden="true" className="flex">
                {statusBadge}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{syncCopy.tooltip}</TooltipContent>
        </Tooltip>
      );
    }
    return statusBadge;
  }
  if (syncCopy) {
    // ISS-5279: ONE pill, and it is the pill that was already there. ISS-4848
    // stacked a "Syncing" pill beside "Active"; ISS-5036 replaced "Active" with
    // it and moved liveness to a dot in the Name cell. Both spent a slot in the
    // Status vocabulary — a closed lifecycle set — on a fact about transport,
    // and Marisol filed the leftover duplicate repeatedly.
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
    // box precisely so the status word keeps its contrast (Pascoe, PR review).
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
  return (
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
  // ISS-5524 (ISS-4779 closed-by-default): the map behind the resolver below has
  // no `Harness.Both` row, so a component used across more than one harness fell
  // to the raw-value fallback and this badge rendered a lowercase `both` — the
  // one place on the Agents page that did not say "Multiple harnesses". Read
  // here because this is the component that swaps on it; `…Optional` because the
  // badge also mounts in Storybook and in table tests with no flag provider,
  // where the honest default is today's render.
  const honestMultiHarnessLabel = useFeatureFlagEnabledOptional(
    AGENTS_SURFACE_HONESTY_FEATURE_FLAG_KEY
  );
  // #4480: the label + tone come from the hoisted `harness-labels` map, so the
  // Sessions "Group by" band header (which is React-free and cannot import this
  // module) names a harness the same word this badge does.
  const config = honestMultiHarnessLabel
    ? resolveHonestHarnessDisplayConfig(harness)
    : resolveHarnessDisplayConfig(harness);

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
    // ISS-5279 (Pascoe, PR review): ONE clause, not the tooltip sentence
    // restated. Radix wires the tooltip as `aria-describedby` on the trigger and
    // opens it on focus, so a long name meant a keyboard user heard the same
    // fact twice — the duplication this ticket deletes, moved into the
    // accessibility tree. The name states the fact; the description explains it.
    ariaSuffix: "syncing.",
  },
};
