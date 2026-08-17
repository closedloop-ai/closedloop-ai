/**
 * ISS-4495: Regression coverage for the session/agent/harness status badges.
 *
 * Each badge maps its status string to a label and a tone class. A derivation
 * or label regression must fail a test here — including the "unknown status
 * renders a safe fallback, not a crash or an unstyled state" case.
 *
 * No providers are needed: the three badge components are pure presentational
 * wrappers that take a status string and render a ToneBadge.
 */

import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import {
  SESSION_STATUS_SYNC_BADGE_TEST_ID,
  SessionSyncPresentation,
} from "@repo/app/agents/lib/session-sync-presentation";
import { getTranscriptDispositionLabel } from "@repo/app/agents/lib/session-sync-status";
import { AGENT_STATUS } from "@repo/app/agents/lib/session-types";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  AgentStatusBadge,
  HarnessBadge,
  SessionStatusBadge,
} from "../session-status-badges";

// Hoisted per biome useTopLevelRegex rule.
const DANGER_CLASS_RE = /text-destructive/;
const SUCCESS_CLASS_RE = /text-success/;
const MUTED_CLASS_RE = /text-muted-foreground/;
const ACCENT_CLASS_RE = /text-primary/;
const INFO_CLASS_RE = /text-info/;
const WARNING_CLASS_RE = /text-warning/;
// ISS-4774 / ISS-4848: the sync clause states the TRANSCRIPT-level meaning,
// matching the canonical `CloudSyncDisclosure.TranscriptSyncing` copy the chip
// and the detail panel use — the fold only fires on
// `transcriptDisposition === syncing`, where the session itself is already in
// the cloud, so a session-level sentence ("this session is still uploading")
// would be false on every row it renders on.
const SYNCING_ARIA_LABEL_RE = /syncing\.$/i;
// ISS-4846 / ISS-5279: ...and the name LEADS with the pill's VISIBLE label, per
// WCAG 2.5.3 Label in Name. Since ISS-5279 that label is the lifecycle word the
// pill still shows, not the word "Syncing" that used to replace it.
const SYNCING_LABEL_LEADS_RE = /^Active,/;
// ISS-5279: the pulse, and the reduced-motion opt-out it is never applied
// without. `motion-safe:` emits no animation at all under a reduce-motion
// preference, rather than emitting one and overriding it.
const PULSE_RING_CLASS_RE = /motion-safe:animate-status-pulse-ring/;
// The DOT's opacity pulse. Distinct from the ring above, and it must never land
// on the pill itself — that is what dimmed the status word.
const DOT_PULSE_CLASS_RE = /\banimate-status-pulse(?!-ring)/;
// ISS-5279: what the pulse becomes under a reduce-motion preference — a
// persistent ring, so stilling animation does not delete the mark.
const REDUCED_MOTION_MARK_RE = /motion-reduce:ring-2/;
// ISS-5279: the focus indicator a marked pill uses instead of `Badge`'s own
// `focus-visible:ring-*`, which collides with the mark on `box-shadow`.
const FOCUS_OUTLINE_RE = /focus-visible:outline-offset-2/;
// The canonical `CloudSyncDisclosure.TranscriptSyncing` sentence, as the tooltip
// renders it — not a restatement, so list/detail/panel cannot drift.
const SYNCING_TOOLTIP_RE = /its transcript is still uploading/i;
// ISS-5279: a `ToneBadge`'s own geometry, used to COUNT pills. `data-slot`
// cannot serve here: Radix's `TooltipTrigger asChild` spreads
// `data-slot="tooltip-trigger"` over the badge's own value, so a tooltip-carrying
// pill stops answering to `[data-slot="badge"]` — and this suite exists to count
// exactly the pill that carries a tooltip.
const TONE_BADGE_SELECTOR = '[class~="h-6"][class~="rounded-full"]';
// The `default` tone's signature classes (status-badge.tsx `toneClasses.default`):
// a non-semantic input surface with `text-foreground`, not any accent color.
const DEFAULT_TONE_CLASS_RE = /border-input-border/;
const FOREGROUND_TEXT_CLASS_RE = /text-foreground/;

// ── helpers ───────────────────────────────────────────────────────────────────

function renderSession(status: string) {
  render(<SessionStatusBadge status={status} />);
}

function renderAgent(status: string) {
  render(<AgentStatusBadge status={status} />);
}

function renderHarness(harness?: string | null) {
  render(<HarnessBadge harness={harness as never} />);
}

// ── SessionStatusBadge ────────────────────────────────────────────────────────

describe("SessionStatusBadge — known statuses map to the correct label and tone", () => {
  // Labels are asserted against the canonical SESSION_STATUS_LABELS map (the
  // badge derives from the same SSOT), so a deliberate vocabulary change updates
  // one place and these tests follow — and the ERROR label stays "Failed", never
  // drifting back to a bespoke "Error".
  it("active → canonical label with success tone and pulse animation", () => {
    renderSession(SESSION_STATUS.ACTIVE);
    expect(
      screen.getByText(SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE])
    ).toBeInTheDocument();
    const html = document.body.innerHTML;
    expect(html).toMatch(SUCCESS_CLASS_RE);
    // Pulsing dot confirms the badge is rendered as "live" (pulse=true).
    expect(html).toContain("animate-");
  });

  it("waiting → canonical label with accent tone and pulse animation", () => {
    renderSession(DISPLAYED_SESSION_STATUS.WAITING);
    expect(
      screen.getByText(SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.WAITING])
    ).toBeInTheDocument();
    const html = document.body.innerHTML;
    expect(html).toMatch(ACCENT_CLASS_RE);
    expect(html).toContain("animate-");
  });

  it("inactive → canonical label with muted tone and no pulse", () => {
    renderSession(SESSION_STATUS.INACTIVE);
    expect(
      screen.getByText(SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE])
    ).toBeInTheDocument();
    const html = document.body.innerHTML;
    expect(html).toMatch(MUTED_CLASS_RE);
    expect(html).not.toContain("animate-");
  });

  it("error → canonical 'Failed' label with danger tone and no pulse", () => {
    renderSession(SESSION_STATUS.ERROR);
    // Canonical label for ERROR is "Failed" — the same text the detail view and
    // the legacy `failed` alias render, so equivalent failure states never split
    // into "Error" vs "Failed".
    const html = document.body.innerHTML;
    expect(
      screen.getByText(SESSION_STATUS_LABELS[SESSION_STATUS.ERROR])
    ).toBeInTheDocument();
    expect(html).toMatch(DANGER_CLASS_RE);
    // Terminal state: the "no pulse" claim in the test name is a real assertion,
    // so a regression that set pulse=true here fails instead of passing silently.
    expect(html).not.toContain("animate-");
  });
});

describe("SessionStatusBadge — safe fallback for unknown / unmapped statuses", () => {
  // ISS-4586 (shafty023 P2): an unmapped / version-skewed status must NOT render
  // a red raw-string badge (a failure it doesn't assert) NOR a terminal "Inactive"
  // (a terminal outcome it can't be assumed to have). `normalizeDisplayedSession
  // Status` treats an unrecognized value as still-ACTIVE (in-flight) — never a
  // fabricated terminal state.

  it("folds an unmapped status string to the ACTIVE badge (no red, no raw string, not terminal)", () => {
    renderSession("unknown_future_status");
    const html = document.body.innerHTML;
    expect(
      screen.getByText(SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE])
    ).toBeInTheDocument();
    expect(screen.queryByText("unknown future status")).not.toBeInTheDocument();
    expect(html).toMatch(SUCCESS_CLASS_RE);
    expect(html).not.toMatch(DANGER_CLASS_RE);
  });

  it("no longer treats 'failed' as an alias — the SESSION badge reads it as skew", () => {
    // ISS-5592 (2026-08-15) retired the alias map, so the session path folds
    // `failed` like any spelling it cannot read rather than to ERROR. Pinned as
    // the deliberate consequence: the badge must NOT keep claiming a failure it
    // can no longer derive.
    //
    // ISS-5592 also deleted `resolveStatusConfig`'s `failed` branch, so the two
    // badges no longer disagree about the same string.
    renderSession("failed");
    expect(
      screen.queryByText(SESSION_STATUS_LABELS[SESSION_STATUS.ERROR])
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE])
    ).toBeInTheDocument();
  });
});

// ── AgentStatusBadge ──────────────────────────────────────────────────────────

describe("AgentStatusBadge — known statuses map to the correct label and tone", () => {
  it("working → 'Working' with success tone and pulse animation", () => {
    renderAgent(AGENT_STATUS.WORKING);
    expect(screen.getByText("Working")).toBeInTheDocument();
    const html = document.body.innerHTML;
    expect(html).toMatch(SUCCESS_CLASS_RE);
    expect(html).toContain("animate-");
  });

  it("waiting → 'Waiting' with accent tone and pulse animation", () => {
    renderAgent(AGENT_STATUS.WAITING);
    expect(screen.getByText("Waiting")).toBeInTheDocument();
    const html = document.body.innerHTML;
    expect(html).toMatch(ACCENT_CLASS_RE);
    expect(html).toContain("animate-");
  });

  it("completed → 'Completed' with muted tone and no pulse", () => {
    renderAgent(AGENT_STATUS.COMPLETED);
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(MUTED_CLASS_RE);
  });

  it("error → 'Error' with danger tone", () => {
    renderAgent(AGENT_STATUS.ERROR);
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(DANGER_CLASS_RE);
  });

  it("idle → 'Idle' with default tone (no semantic color emphasis)", () => {
    renderAgent(AGENT_STATUS.IDLE);
    expect(screen.getByText("Idle")).toBeInTheDocument();
    const html = document.body.innerHTML;
    // Positively pin the default tone's own classes so a regression to ANY other
    // tone (accent/info/muted included) fails — excluding a few alternatives is
    // not enough, since default is the only tone carrying these classes.
    expect(html).toMatch(DEFAULT_TONE_CLASS_RE);
    expect(html).toMatch(FOREGROUND_TEXT_CLASS_RE);
    // And it is not any of the semantic accent tones.
    expect(html).not.toMatch(SUCCESS_CLASS_RE);
    expect(html).not.toMatch(DANGER_CLASS_RE);
    expect(html).not.toMatch(WARNING_CLASS_RE);
    expect(html).not.toMatch(ACCENT_CLASS_RE);
    expect(html).not.toMatch(INFO_CLASS_RE);
  });
});

describe("AgentStatusBadge — safe fallback for unknown statuses", () => {
  it("renders a safe danger-toned fallback for an unmapped agent status", () => {
    renderAgent("planning");
    expect(screen.getByText("planning")).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(DANGER_CLASS_RE);
  });

  it("renders `failed` through that fallback, lowercase, after ISS-5592", () => {
    // The one behavior the ISS-5592 removal actually changed on a rendered
    // surface, and nothing asserted it: `resolveStatusConfig` carried a
    // `failed` special case that rendered "Failed", which was SESSION
    // vocabulary sitting on the AGENT path (`AgentStatus` has no such member,
    // nor does the desktop `DESKTOP_AGENT_STATUS`). It went with the alias.
    //
    // The tone is the point of keeping the assertion rather than deleting the
    // case with the branch: the fallback must still read as a failure, so a
    // future edit that makes an unrecognized agent status render neutral would
    // silently downgrade this one. The label losing its capital is the
    // accepted cost, asserted here so it is a decision and not a surprise.
    renderAgent("failed");
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(DANGER_CLASS_RE);
  });
});

// ── HarnessBadge ─────────────────────────────────────────────────────────────

describe("HarnessBadge — known harnesses map to the correct label and tone", () => {
  it("claude → 'Claude' with accent tone", () => {
    renderHarness("claude");
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(ACCENT_CLASS_RE);
  });

  it("codex → 'Codex' with info tone", () => {
    renderHarness("codex");
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(INFO_CLASS_RE);
  });

  it("cursor → 'Cursor' with warning tone", () => {
    renderHarness("cursor");
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(WARNING_CLASS_RE);
  });

  it("copilot → 'Copilot' with success tone", () => {
    renderHarness("copilot");
    expect(screen.getByText("Copilot")).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(SUCCESS_CLASS_RE);
  });

  it("opencode → 'OpenCode' with muted tone (T8: not danger — a harness is not an error)", () => {
    renderHarness("opencode");
    expect(screen.getByText("OpenCode")).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(MUTED_CLASS_RE);
  });

  it("harness lookup is case-insensitive (uppercase 'Claude' resolves to the same config)", () => {
    // The harnessConfig lookup uses .toLowerCase() so producers emitting uppercase
    // harness names still resolve to the correct config.
    renderHarness("Claude");
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(ACCENT_CLASS_RE);
  });
});

describe("HarnessBadge — safe fallback for unknown / absent harness", () => {
  it("falls back to 'Claude' with accent tone when harness is null", () => {
    renderHarness(null);
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(ACCENT_CLASS_RE);
  });

  it("falls back to 'Claude' with accent tone when harness is undefined", () => {
    renderHarness(undefined);
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(ACCENT_CLASS_RE);
  });

  it("renders the raw harness name with accent tone for an unknown harness string", () => {
    // An unrecognized harness (future product or non-standard tool) falls back
    // to the raw string label with the 'accent' tone so the badge is never
    // unstyled — consistent with the "Claude" fallback but labeled truthfully.
    renderHarness("jetbrains");
    expect(screen.getByText("jetbrains")).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(ACCENT_CLASS_RE);
  });
});

// ── Gating-state disambiguation ───────────────────────────────────────────────
// Each lifecycle state must render a DISTINCT visible output. Changing any arm
// to collapse into another arm would fail these assertions.

describe("SessionStatusBadge — distinct visible state per lifecycle stage", () => {
  it("active and inactive render distinct labels", () => {
    const { unmount } = render(
      <SessionStatusBadge status={SESSION_STATUS.ACTIVE} />
    );
    expect(
      screen.getByText(SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE])
    ).toBeInTheDocument();
    unmount();

    render(<SessionStatusBadge status={SESSION_STATUS.INACTIVE} />);
    expect(
      screen.queryByText(SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE])
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE])
    ).toBeInTheDocument();
  });

  it("error (Failed) and inactive render distinct labels", () => {
    const { unmount } = render(
      <SessionStatusBadge status={SESSION_STATUS.ERROR} />
    );
    expect(
      screen.getByText(SESSION_STATUS_LABELS[SESSION_STATUS.ERROR])
    ).toBeInTheDocument();
    unmount();

    render(<SessionStatusBadge status={SESSION_STATUS.INACTIVE} />);
    expect(
      screen.queryByText(SESSION_STATUS_LABELS[SESSION_STATUS.ERROR])
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE])
    ).toBeInTheDocument();
  });

  it("a live status (active) has pulse animation; a terminal status (inactive) does not", () => {
    const { unmount } = render(
      <SessionStatusBadge status={SESSION_STATUS.ACTIVE} />
    );
    expect(document.body.innerHTML).toContain("animate-");
    unmount();

    render(<SessionStatusBadge status={SESSION_STATUS.INACTIVE} />);
    expect(document.body.innerHTML).not.toContain("animate-");
  });
});

// ISS-5279: sync is a SECOND dimension, expressed on the pill's presentation —
// never a second pill, never a Status value, never a separate dot.
describe("SessionStatusBadge — ISS-5279 sync presentation", () => {
  const ACTIVE_LABEL = SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE];
  const SYNCING_DISPOSITION_LABEL =
    getTranscriptDispositionLabel(TranscriptDisposition.Syncing) ?? "Syncing";

  function renderSyncing() {
    return render(
      <TooltipProvider>
        <SessionStatusBadge
          status={SESSION_STATUS.ACTIVE}
          syncPresentation={SessionSyncPresentation.Syncing}
        />
      </TooltipProvider>
    );
  }

  it("renders exactly ONE pill, still carrying the lifecycle label", () => {
    const { container } = renderSyncing();

    // The bug Mike filed repeatedly: a blue "Syncing" pill sitting next to the
    // run-status pill. Counting badges is the assertion that catches it —
    // "a pill exists" would pass with two on screen.
    expect(container.querySelectorAll(TONE_BADGE_SELECTOR)).toHaveLength(1);
    const badge = screen.getByTestId(SESSION_STATUS_SYNC_BADGE_TEST_ID);
    // The Status vocabulary is a closed lifecycle set and "Syncing" is not in
    // it. The pill keeps the word the Status facet filtered on and the Status
    // sort ranked, which is what ISS-5036's label-narrowing gave up.
    expect(badge).toHaveTextContent(ACTIVE_LABEL);
    expect(badge.className).toMatch(SUCCESS_CLASS_RE);
    // And the replaced-label rendering is gone, not merely deprioritized.
    expect(
      screen.queryByText(SYNCING_DISPOSITION_LABEL)
    ).not.toBeInTheDocument();
    // ISS-5279: no separate dot either. `SessionLivenessDot` existed only to
    // carry the liveness the narrowed pill stopped stating; the pill states it
    // again, so the dot would be the same fact in two columns.
    expect(
      screen.queryByTestId("session-liveness-dot")
    ).not.toBeInTheDocument();
  });

  it("pulses a RING around the pill, behind the reduced-motion guard, and never the pill's own opacity", () => {
    const { container } = renderSyncing();

    const badge = screen.getByTestId(SESSION_STATUS_SYNC_BADGE_TEST_ID);
    // `motion-safe:` emits no animation at all under a reduce-motion preference,
    // rather than emitting one and then overriding it.
    expect(badge.className).toMatch(PULSE_RING_CLASS_RE);
    // Exactly one ring-pulsing element — the pill, not anything nested.
    expect(
      container.querySelectorAll('[class*="animate-status-pulse-ring"]')
    ).toHaveLength(1);
    // The load-bearing one (Parker, PR review): the pill must NOT carry the
    // opacity pulse. `opacity` dips everything inside it, including the 11px
    // semibold status word — 2.89:1 down to 1.66:1 on the light success pill,
    // twice a second — and that word is the thing this treatment exists to keep
    // on the pill.
    expect(badge.className).not.toMatch(DOT_PULSE_CLASS_RE);
    // ONE animation, not two (PR review). The Active config sets `pulse: true`,
    // which fades the pill's dot on the same 1.6s beat the ring swells on — at
    // 24px that reads as one busy pill rather than as two facts, and the word
    // "Active" beside it is already carrying liveness. The sync branch hands the
    // dot pulse off so the ring is the mark. Restore `pulse={config.pulse}` and
    // this fails.
    expect(
      container.querySelectorAll('[class*="animate-status-pulse"]')
    ).toHaveLength(1);
  });

  it("gives a marked pill a focus indicator that is not just its mark in another colour", () => {
    renderSyncing();

    // `tabIndex={0}` adds a tab stop on every syncing row, so focus has to be
    // unmistakable when it lands (PR review). It cannot be a `ring-*`: Tailwind
    // draws rings as `box-shadow`, which is the same property as both the
    // reduced-motion mark AND the keyframe animation — and an animation's
    // declaration beats the static one it collides with, so under `motion-safe:`
    // the default focus ring is not painted at all. An `outline` is a separate
    // property, and the offset detaches it from the pill's edge.
    const badge = screen.getByTestId(SESSION_STATUS_SYNC_BADGE_TEST_ID);
    expect(badge.className).toMatch(FOCUS_OUTLINE_RE);
  });

  it("keeps the mark VISIBLE when the viewer has asked for less motion", () => {
    renderSyncing();

    // `motion-safe:` and `motion-reduce:` are exclusive, so without a reduced
    // -motion rendering the mark would exist only in the accessibility tree —
    // a fair fallback for a screen-reader user and a poor one for the sighted
    // user who simply dislikes movement: they can see the pill fine, they just
    // can't see WHICH pill is marked. The ring is the still rendering of the
    // same fact, so which row is syncing is answerable either way.
    const badge = screen.getByTestId(SESSION_STATUS_SYNC_BADGE_TEST_ID);
    // `ring-2`, not a hairline: the pill already ships a `border-<tone>/25`, so
    // a 1px low-alpha ring read as a slightly thicker border rather than as a
    // mark (Parker, PR review).
    expect(badge.className).toMatch(REDUCED_MOTION_MARK_RE);
    // And the meaning is still not carried by the treatment alone.
    expect(badge.getAttribute("aria-label")).toMatch(SYNCING_ARIA_LABEL_RE);
  });

  it("carries the syncing fact in its accessible name, so the meaning is never animation-only", () => {
    renderSyncing();

    const badge = screen.getByTestId(SESSION_STATUS_SYNC_BADGE_TEST_ID);
    // WCAG 1.4.1: a reader who cannot perceive the motion — reduce-motion on, a
    // screen reader, a still screenshot — must still get the fact. The pulse is
    // decorative reinforcement, not the carrier.
    expect(badge.getAttribute("aria-label")).toMatch(SYNCING_ARIA_LABEL_RE);
    // WCAG 2.5.3 Label in Name: the name LEADS with the visible word, so a
    // voice-control user saying "click Active" still matches the pill.
    expect(badge.getAttribute("aria-label")).toMatch(SYNCING_LABEL_LEADS_RE);
  });

  it("opens the explanation on KEYBOARD FOCUS, not hover alone", async () => {
    const user = userEvent.setup();
    renderSyncing();

    const badge = screen.getByTestId(SESSION_STATUS_SYNC_BADGE_TEST_ID);
    // A `<span>` pill is not natively focusable, so Radix's focus trigger never
    // fired and the tooltip was hover-only — unreachable by keyboard and touch.
    expect(badge).toHaveAttribute("tabindex", "0");

    await user.tab();
    expect(badge).toHaveFocus();
    // The canonical `CloudSyncDisclosure.TranscriptSyncing` sentence, not a
    // restatement — the list, the detail Sync row, and the transcript panel
    // read from one source.
    expect(await screen.findAllByText(SYNCING_TOOLTIP_RE)).not.toHaveLength(0);
  });

  it("a row whose transcript stopped without finishing gets the ORDINARY pill, with the verdict left to the Name cell", () => {
    // PR review's blocking finding, and the resolution it leaned to. The pill
    // briefly also marked `stale` / `failedTransient` / `failedPermanent` with a
    // warning-toned dot — 6px of pale amber inside a pale green fill, which is
    // not perceivable at 1x, so the claim held only in the accessibility tree.
    // Those verdicts already have a home: the Name cell's disposition badge,
    // which this fold never suppresses for a row that is not uploading. The
    // Status pill's job is the run lifecycle; whispering a transport verdict was
    // the second job ISS-5279 just took off it.
    const { container } = render(
      <TooltipProvider>
        <SessionStatusBadge
          status={SESSION_STATUS.ACTIVE}
          syncPresentation={undefined}
        />
      </TooltipProvider>
    );

    // Exactly one pill, still the lifecycle word, and NOT marked as carrying a
    // sync presentation — so nothing on it can be mistaken for a transport claim.
    expect(container.querySelectorAll(TONE_BADGE_SELECTOR)).toHaveLength(1);
    const badge = screen.getByText(ACTIVE_LABEL).closest(TONE_BADGE_SELECTOR);
    expect(
      screen.queryByTestId(SESSION_STATUS_SYNC_BADGE_TEST_ID)
    ).not.toBeInTheDocument();
    expect(badge?.className).not.toMatch(PULSE_RING_CLASS_RE);
    // No warning recolouring survives anywhere on the pill.
    expect(badge?.innerHTML).not.toContain("bg-warning");
    expect(badge?.getAttribute("aria-label")).toBeNull();
  });

  it("a finished (or absent) sync state leaves the pill exactly as it was before the flag", () => {
    render(<SessionStatusBadge status={SESSION_STATUS.ACTIVE} />);

    const badge = screen.getByText(ACTIVE_LABEL).closest(TONE_BADGE_SELECTOR);
    expect(badge).not.toBeNull();
    // No sync marker, no tooltip affordance, no focus stop: the closed-by-default
    // path must cost the default render nothing, including tab order.
    expect(badge?.getAttribute("data-session-sync-state")).toBeNull();
    expect(badge?.getAttribute("tabindex")).toBeNull();
    expect(badge?.className).not.toMatch(PULSE_RING_CLASS_RE);
  });
});
