/**
 * @file feature-flags-shared-ui.ts
 * @description The SHARED web+desktop UI feature flags (ISS-4779
 * closed-by-default) as desktop Labs registry entries, split out of
 * `feature-flags.ts` when that file crossed the 1,000-line hard ceiling
 * (AGENTS.md -> "File Size and Organization").
 *
 * The seam is the one this family's TEST already uses
 * (`test/feature-flags-shared-ui.test.ts`, split for the same reason): every
 * flag here gates a component that mounts on the web app AND the packaged
 * desktop renderer. The renderer gate for every one of them is the signed-in
 * PostHog assignment (ISS-8753, `DesktopFeatureFlagProvider`), which never reads
 * this registry.
 *
 * A NEW SHARED UI FLAG GETS NO ENTRY HERE (ISS-11262, root `AGENTS.md` ->
 * Commit & Pull Request Guidelines: "a shared key must not get a desktop
 * registry shadow entry"). This file used to say the opposite. The entries
 * below are LEGACY: they stay because their persisted settings contract
 * (`DesktopSettings` fields, `LABS_SETTING_KEY_LEDGER`, the round-trip tests in
 * `test/feature-flags-shared-ui.test.ts`) is already persisted in existing
 * desktop profiles, and retiring one follows the Labs-setting retirement path
 * with human approval, not a silent delete.
 *
 * Entries key on the canonical `@repo/api` constant directly rather than on the
 * host file's `DESKTOP_*` alias of it. That is what keeps the split acyclic —
 * `feature-flags.ts` imports this module, so this module must not import it
 * back — and the alias is defined AS that same constant, so the two remain
 * byte-equal by construction (asserted per flag in
 * `test/feature-flags-cross-surface.test.ts`).
 *
 * The three keys below are declared here, not aliased: their web counterparts
 * are literals in `packages/app/shared/lib/feature-flags.ts` with no `@repo/api`
 * leaf to share, and this module is their owner. `feature-flags.ts` re-exports
 * them so existing importers are unaffected.
 */

import { AGENTS_CARD_ATTRIBUTE_LABELS_FLAG_KEY } from "@repo/api/src/types/agents-card-attribute-labels-flag";
import { AGENTS_NAV_FLAG_KEY } from "@repo/api/src/types/agents-nav-flag";
import { BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY } from "@repo/api/src/types/branch-detail-measured-checks-flag";
import { BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY } from "@repo/api/src/types/branch-detail-metric-honesty-flag";
import { BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FLAG_KEY } from "@repo/api/src/types/branch-detail-pr-base-and-author-flag";
import { BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY } from "@repo/api/src/types/branch-timeline-cost-fallback-marker-flag";
import { BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY } from "@repo/api/src/types/branches-cohort-transparency-flag";
import { BRANCHES_SUMMARY_HONEST_LOADING_FLAG_KEY } from "@repo/api/src/types/branches-summary-honest-loading-flag";
import { MEMBER_SELF_SERVICE_INSTALL_FLAG_KEY } from "@repo/api/src/types/member-self-service-install-flag";
import { SESSION_CLAUDE_REPORTED_COST_FLAG_KEY } from "@repo/api/src/types/session-claude-reported-cost-flag";
import { SESSION_LAUNCH_ATTRIBUTION_FLAG_KEY } from "@repo/api/src/types/session-launch-attribution-flag";
import { SESSION_METRIC_POPULATION_DISCLOSURE_FLAG_KEY } from "@repo/api/src/types/session-metric-population-disclosure-flag";
import { SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY } from "@repo/api/src/types/session-timeline-coverage-disclosure-flag";
import { SESSION_TIMELINE_SOURCE_EXTENT_FLAG_KEY } from "@repo/api/src/types/session-timeline-source-extent-flag";
import { SESSION_TOKENS_RECORDED_HONESTY_FLAG_KEY } from "@repo/api/src/types/session-tokens-recorded-honesty-flag";
import { SESSION_TOUCHED_BRANCHES_FLAG_KEY } from "@repo/api/src/types/session-touched-branches-flag";
import { SESSION_TRACE_EVIDENCE_DISCLOSURE_FLAG_KEY } from "@repo/api/src/types/session-trace-evidence-disclosure-flag";
import { SESSION_TRACE_IDLE_ROWS_FLAG_KEY } from "@repo/api/src/types/session-trace-idle-rows-flag";
import { SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY } from "@repo/api/src/types/session-transcript-never-expected-flag";
import { SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY } from "@repo/api/src/types/sessions-summary-honest-loading-flag";
/**
 * ISS-5566: shared web+desktop UI flag (kebab-case, PostHog key
 * "session-timeline-synthesized-cost") gating the Session Timeline's disclosure
 * that a strip's bars were reconstructed from the transcript rather than
 * measured — and the withdrawal of the manufactured dollar figures that went
 * with them.
 *
 * `AgentSessionDetailView` mounts on the desktop renderer as well as the web
 * app, and the desktop renderer resolves this shared key from the signed-in
 * account's PostHog assignment — the same key space the web app reads — so the
 * disclosure cannot land web-only while desktop keeps painting the synthesized
 * cents as measured money; an unknown key resolves closed via
 * `DesktopFeatureFlagProvider`. Off by default (ISS-4779 closed-by-default).
 * Must stay byte-for-byte equal to
 * `SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`; the literal is redeclared here
 * (instead of imported) to keep this main-process module free of the
 * `@repo/app` transitive graph.
 */
export const DESKTOP_SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY =
  "session-timeline-synthesized-cost";
/**
 * The shared web+desktop closed-by-default UI flags, spread into
 * `FEATURE_FLAGS_INTERNAL` so `FlagKey` still derives from one array.
 */
export const SHARED_UI_FEATURE_FLAGS = [
  {
    // ISS-7090: gates finite-range cohort refresh/failure status while the
    // shared cards and rows remain the source of Last active availability.
    key: BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY,
    default: false,
    label: "Branches cohort transparency",
    description:
      "Shows when a finite Branches range is updating or failed to update while retaining the existing range state. Last active availability remains represented in the metric cards and rows.",
    category: "Labs" as const,
  },
  {
    // ISS-8510: display-only shell for the approved summary's never-loaded
    // state. Desktop still registers the key for default-off settings metadata,
    // but the renderer source is the signed-in PostHog assignment owned by
    // `DesktopFeatureFlagProvider` after ISS-8753.
    key: BRANCHES_SUMMARY_HONEST_LOADING_FLAG_KEY,
    default: false,
    label: "Branches summary honest loading",
    description:
      "Keeps the Branches summary honest-loading gate default-off in Desktop flag metadata. The rendered Desktop state comes from the signed-in PostHog assignment; when assigned on, never-loaded summary metrics show loading value placeholders instead of the failed-read dash.",
    category: "Labs" as const,
  },
  {
    // ISS-7229 (ISS-4779 closed-by-default): shared web+desktop UI flag. Session
    // detail showed only OUR derived estimate while Claude's own reported total
    // sat unread in the completed loop event; the two disagree (an observed
    // session read $1,438.84 against $1,502.10). Additive — the row appears only
    // where Claude actually reported a figure.
    key: SESSION_CLAUDE_REPORTED_COST_FLAG_KEY,
    default: false,
    label: "Session Claude-Reported Cost",
    description:
      "On session detail, shows Claude Code's own reported cost beside the ClosedLoop estimate, for the sessions where Claude reported one. The figure is served by the cloud session-detail read, so it appears only for synced loop-originated sessions; every other session shows no such row rather than repeating the estimate under Claude's name.",
    category: "Labs" as const,
  },
  {
    // ISS-7259 (ISS-4779 closed-by-default): shared web+desktop UI flag. Both
    // harnesses stamp who or what started a thread and we persisted it without
    // ever showing it. Additive — each row appears only where that harness
    // actually stated that fact.
    key: SESSION_LAUNCH_ATTRIBUTION_FLAG_KEY,
    default: false,
    label: "Session Launch Attribution",
    description:
      "On session detail, shows how the harness said the thread came to run: Codex's stated spawn facts (user- or agent-spawned, agent role, depth) and Claude's earliest attributed skill and prompt source. Claude stamps its skill per turn and never marks a launch, so that row is labelled 'First attributed skill' and carries the record position it was found at rather than claiming to name the launcher.",
    category: "Labs" as const,
  },
  {
    // ISS-7737 (ISS-4779 closed-by-default): shared web+desktop UI flag. The
    // session-detail panel puts a parent-only turn count four rows from a token
    // and cost rollup folded over every delegated subagent transcript, and says
    // nothing about either population — two investigators divided one by the
    // other by hand and both reported the result as impossible. Wording only:
    // every figure stays where it is and keeps its value.
    key: SESSION_METRIC_POPULATION_DISCLOSURE_FLAG_KEY,
    default: false,
    label: "Session Metric Population Disclosure",
    description:
      "On session detail, the Turns, Tokens, and Cost rows each say which population they count — Turns counts parent turns, while Tokens and Cost cover every round-trip including delegated subagent work. Wording only: no figure is removed and no row moves.",
    category: "Labs" as const,
  },
  {
    // ISS-5637 (ISS-4779 closed-by-default): shared web+desktop UI flag. The
    // session-detail Tokens row's unknown state was keyed on a per-counter null
    // no producer can emit, so a session with no token-usage rows asserted
    // "0 in | 0 out | 0 cache read | 0 cache write" two rows above a Cost dash
    // meaning "no token usage recorded to price". Display only — the row now
    // reads the same evidence the Cost row does, and a per-counter zero inside a
    // session that did record usage still renders as a measured zero.
    key: SESSION_TOKENS_RECORDED_HONESTY_FLAG_KEY,
    default: false,
    label: "Session Tokens Recorded Honesty",
    description:
      "On session detail, the Tokens row shows a dash when the session recorded no token usage at all, instead of four zeros that read as measurements — matching the Cost row on the same panel, which already dashes for exactly that reason. A session that did record usage still shows every counter, including the ones that genuinely measured zero.",
    category: "Labs" as const,
  },
  {
    // ISS-5951 (ISS-4779 closed-by-default): shared web+desktop UI flag. The
    // Branch PR timeline's headline cost falls back to the rendered subtotal
    // when timing is incomplete OR when the branch has no authoritative total;
    // only the first was marked, so the second read as an authoritative figure.
    // ISS-5747 also gates the loaded-Session cost selection so unpriced loaded
    // rows cannot be summed as zero while the gate is open.
    key: BRANCH_TIMELINE_COST_FALLBACK_MARKER_FLAG_KEY,
    default: false,
    label: "Branch Timeline Fallback Cost Marker",
    description:
      "On a Branch's PR timeline, marks the headline cost as incomplete whenever it is the rendered subtotal rather than the branch's own total — including when the branch has no total of its own — and reads the cost, LOC/$, and duration as Unavailable when the trace evidence behind them never arrived or when loaded Sessions lack cost evidence, instead of showing a figure nothing backs.",
    category: "Labs" as const,
  },
  {
    // ISS-5271 (ISS-4779 closed-by-default): shared web+desktop UI flag. The
    // Sessions and Total Tokens summary cards hold their frame and skeleton the
    // value slot when the usage summary has not loaded (and nothing errored),
    // instead of rendering a confident 0 for a number that was never computed
    // while the Cost card beside them honestly dashes. Display only — last-good
    // values held by the query cache are unaffected.
    key: SESSIONS_SUMMARY_HONEST_LOADING_FLAG_KEY,
    default: false,
    label: "Sessions Summary Honest Loading",
    description:
      "While the Sessions summary is still loading, the cards show a loading placeholder instead of a zero that could be mistaken for a real count, and the prior-period comparison shows a loading placeholder instead of claiming there is no prior period. Display only — the numbers themselves are unchanged.",
    category: "Labs" as const,
  },
  {
    // ISS-5125 (ISS-4779 closed-by-default): the member self-service install
    // affordance on the packs per-machine block. Gates an AFFORDANCE, not a
    // permission — every member already holds the install-to-own-machines
    // capability and the API already enforces node ownership.
    key: MEMBER_SELF_SERVICE_INSTALL_FLAG_KEY,
    default: false,
    label: "Install packs from the machines list",
    description:
      "Adds an Install button to each machine and harness row on a pack's page, so you can install the pack yourself instead of only seeing where it already stands. A row that is offline, unsupported, or already installing says why it has no button rather than leaving a blank space. Only your own machines are ever offered.",
    category: "Labs" as const,
  },
  {
    // ISS-5566: shared web+desktop UI flag (kebab-case, PostHog key
    // "session-timeline-synthesized-cost"). The desktop renderer resolves it
    // from the signed-in account's PostHog assignment — the same key space the
    // web app reads — so the disclosure cannot land web-only while desktop keeps
    // presenting synthesized cents as measured money; this entry carries only
    // the key's default-off main-process settings metadata, and an unknown key
    // resolves closed via `DesktopFeatureFlagProvider`.
    // Off by default (ISS-4779 closed-by-default). ONE key withdraws
    // the fabricated figures AND adds the caption, so the strip cannot end up
    // silent about its provenance while still printing dollars, or captioned
    // while still contradicting itself.
    key: DESKTOP_SESSION_TIMELINE_SYNTHESIZED_COST_FEATURE_FLAG_KEY,
    default: false,
    label: "Session Timeline unmeasured-cost disclosure",
    description:
      "Stops the Session Timeline showing dollar amounts it never measured. When a session has no recorded per-bucket cost, the bars are reconstructed from the transcript — this hides the invented figures, keeps the bars as a picture of relative activity, and says so beneath the strip.",
    category: "Labs" as const,
  },
  {
    // ISS-7427 (ISS-4779 closed-by-default): shared web+desktop UI flag. The
    // Session Trace count and the panel beneath it describe two different
    // populations — the count is the synced event projection, the panel is the
    // parsed transcript — and when the main transcript is terminally absent the
    // heading read as a description of an empty panel ("216 trace events" over
    // "Transcript not archived"). Additive copy only: no count changes, and the
    // note renders only when the server classifies the session as metadata-only.
    key: SESSION_TRACE_EVIDENCE_DISCLOSURE_FLAG_KEY,
    default: false,
    label: "Session Trace evidence disclosure",
    description:
      "On session detail, says where the Session Trace count came from when the session's main transcript is permanently unavailable — the upload was refused or gave up, not merely still in flight. The count describes the synced activity we stored, not the transcript panel below it, so this names the two apart instead of leaving one heading over both. A device on the metadata sync tier never uploads a transcript at all; those sessions are covered by the separate transcript kept-local notice (ISS-7516), not here.",
    category: "Labs" as const,
  },
  {
    // ISS-7516 (ISS-4779 closed-by-default): shared web+desktop UI flag. A
    // machine whose data-sync level keeps transcripts local never queues one,
    // so `syncTierAllowsTranscripts` is permanently false for it and its
    // sessions sat in the panel's not-yet-arrived state forever, being told the
    // source machine would upload something it is never going to send. The
    // desktop renderer reads the signed-in PostHog assignment for this key,
    // matching web. ISS-7516 wire half: the web CAN render it now — the
    // recording machine's level rides the session payload — so both surfaces
    // gate the same visible thing.
    key: SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY,
    default: false,
    label: "Transcript kept-local notice",
    description:
      "Says when a session's transcript is never coming because the data sync level of the machine that recorded it keeps transcripts local, instead of saying it has not uploaded yet. A transcript that genuinely is still uploading is unaffected, and a session whose recording machine did not report a level keeps the existing wording.",
    category: "Labs" as const,
  },
  {
    // ISS-7427 AC5 + AC4 (ISS-4779 closed-by-default): shared web+desktop UI
    // flag. The Session Timeline tiles the intervals we hold synced rows for,
    // and its axis starts at the first of those rows, so time outside that
    // window is drawn as nothing and quiet bins inside it are drawn as observed
    // quiet. When the main transcript is terminally absent nothing will ever
    // measure the difference, and the strip reads as complete coverage it does
    // not have. AC4 put the Properties panel's Cost, Tokens and Duration rows
    // behind this SAME key rather than minting a second: all four elements
    // disclose one fact about one response on one screen, and two keys would let
    // an operator label the strip while the numbers beside it stayed bare.
    // Additive copy only: no bar moves, no figure changes, and nothing renders
    // unless the server classifies the session as metadata-only.
    key: SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY,
    default: false,
    label: "Session evidence coverage disclosure",
    description:
      "On session detail, says which parts of the screen were drawn from the session's synced activity rather than from its transcript. The Session Timeline's bars get a line saying they cover synced activity only, so the strip stops reading as though it spanned the whole run; the Cost, Tokens and Duration rows say where their figures came from. All of it appears only when the session's main transcript is permanently unavailable — the upload was refused or gave up, not merely still in flight — because that is when nothing will ever reconcile those numbers against an archive. It says nothing about which archives survive: such a session can still have readable subagent transcripts, or a local copy on the machine that ran it. Separate from the Session Trace evidence disclosure, which qualifies that heading's count.",
    category: "Labs" as const,
  },
  {
    // ISS-5850 (ISS-4779 closed-by-default): shared web+desktop UI flag. The
    // collector bins a session over the stretch where activity actually
    // happened, which is routinely narrower than the clock window the strip
    // draws; columns beyond it are emitted all-zero and render as observed
    // quiet. SIBLING OF, NOT A DUPLICATE OF, the coverage disclosure above:
    // that one fires only when the main transcript is terminally absent and
    // speaks about the WINDOW and the Properties figures, while this one fires
    // on any session whose producer states an extent and speaks about
    // INDIVIDUAL COLUMNS inside the window. Additive copy only: no bar moves
    // and no figure changes.
    key: SESSION_TIMELINE_SOURCE_EXTENT_FLAG_KEY,
    default: false,
    label: "Session Timeline unmeasured-interval disclosure",
    description:
      "Stops the Session Timeline presenting intervals it never measured as quiet ones. The collector bins a session over the stretch where activity actually happened, which is usually narrower than the clock window the strip draws — this marks the columns outside that stretch as unmeasured instead of showing them as time when nothing was spent. Sessions recorded by a desktop build that does not state its measured stretch are unaffected.",
    category: "Labs" as const,
  },
  {
    // ISS-5532 (ISS-4779 closed-by-default): shared web+desktop UI flag. The
    // Agents catalog card promotes Type and the LOC/$ metric up beside the
    // component name, where a card has no header row to name them — the card
    // opened on a bare `Tool`. Display-only: the same attributes are shown
    // either way, the flag decides whether each one is named.
    key: AGENTS_CARD_ATTRIBUTE_LABELS_FLAG_KEY,
    default: false,
    label: "Agents card attribute labels",
    description:
      "In a narrow window each Agents card writes a small label above the type and the LOC/$ figure under the component name, so you can tell what those two values are without a table header to read them against.",
    category: "Labs" as const,
    // ISS-5310: the card only exists inside the Agents workspace, so this is
    // inert while `agentsNav` is off. Stating it in `dependsOn` rather than
    // prose makes a future generic flag surface nest the row under its parent
    // and disable the switch, instead of storing a choice that provably does nothing today.
    //
    // The FIRST entry here to carry a parent, which is why `AGENTS_NAV_FLAG_KEY`
    // is a leaf module: naming it is what keeps this file from importing the
    // host back. If a generic flag surface returns, a nested dependent must
    // render under its parent rather than in a trailing shared-UI block.
    dependsOn: AGENTS_NAV_FLAG_KEY,
  },
  {
    // ISS-8241 Half A (ISS-4779 closed-by-default): shared web+desktop UI flag.
    // `BranchPrStatusPanel` mounts on BOTH surfaces from `packages/app`, and the
    // field it reads is served by the SAME cloud Branch detail response to both,
    // so a split key would leave one surface reading a live provider answer and
    // the other the stored measurement for the very same pull request.
    key: BRANCH_DETAIL_MEASURED_CHECKS_FLAG_KEY,
    default: false,
    label: "Branch pull-request measured checks",
    description:
      "On a Branch's Checks and review box, states the checks the cloud actually measured at this pull request's own head, rather than whatever GitHub answers while the box is open. A head no producer reached says so, an empty check population says so, a failed read says so, and rows that did not come back say so, instead of all four reading alike. Cost: a check that flipped since the last measurement does not appear until the next one. Reads nothing from a local-only Branch, which has no measurement to show.",
    category: "Labs" as const,
  },
  {
    // ISS-8241 Half B (ISS-4779 closed-by-default): shared web+desktop UI flag.
    // `BranchDeliveredPanel` mounts on web AND desktop, and the desktop's own
    // local lane is a PRODUCER of the absence as well as a surface for it — its
    // `BranchPrRow` carries neither value — so a split key would name a PR's
    // target and author on one surface while the other kept showing a PR that
    // says neither. Additive: two lines the box never rendered.
    key: BRANCH_DETAIL_PR_BASE_AND_AUTHOR_FLAG_KEY,
    default: false,
    label: "Branch pull-request base and author",
    description:
      "On a Branch's What was delivered box, says which branch the pull request targets and who opened it, read from the pull request's own record rather than the branch's current base. A value no producer measured says so instead of borrowing the branch's target or leaving a blank — which is every pull request while the desktop is signed out, because nothing local records either one.",
    category: "Labs" as const,
  },
  {
    // ISS-6954/6955/6957/6958 (ISS-4779 closed-by-default): shared web+desktop UI
    // flag. `BranchHeadlineCards` and `BranchLeadTimeWaterfall` mount on BOTH
    // surfaces from `packages/app`, and the duplicate naming is a property of
    // those components rather than of either host, so a split key would leave one
    // surface naming one measurement twice while the other named it once.
    key: BRANCH_DETAIL_METRIC_HONESTY_FLAG_KEY,
    default: false,
    label: "Branch detail outcome presentation",
    description:
      "On a Branch's detail screen, names the outcome measurement once — as Cycle Time on the headline card — instead of repeating it as a second heading over the waterfall below, and stops that heading claiming a merged-outcome measurement on a branch that never merged. A pull-request-cycle card with no pull request selected says that is the reason rather than reporting an evidence outage, and durations scale through hours and days, so fifty-three hours reads 2d 5h instead of 3180m 0s. Leaves LOC per $ alone, which is measured over the Branch lifetime and does not depend on the selected pull request.",
    category: "Labs" as const,
  },
  {
    // ISS-8652 (ISS-4779 closed-by-default): shared web+desktop UI flag. The
    // shared `SessionTrace` mounts on BOTH surfaces — the agents Session detail
    // transcript panel and the branch merged trace — and the desktop's own local
    // loader is a PRODUCER of the gap as well as a surface for it, since
    // `buildMergedTrace` synthesizes the span from whatever sessions that loader
    // hands it. A split key would show the pause on one surface while the other
    // kept two turns sitting adjacent with minutes unaccounted for between them.
    key: SESSION_TRACE_IDLE_ROWS_FLAG_KEY,
    default: false,
    label: "Session Trace idle rows",
    description:
      "In a session trace, renders the pause between two turns as its own row carrying how long it lasted, instead of leaving two turns adjacent with the minutes between them unaccounted for. The gap is already computed for the cross-session merged trace and was being discarded before it reached the transcript; this shows it. Turning it on also re-groups the transcript: turns that used to merge into one bubble across a pause now split either side of the idle row, so each shows its own working time instead of one figure that counted the waiting as work. A trace with no gap long enough to count renders no idle rows at all.",
    category: "Labs" as const,
  },
  {
    // ISS-8427 (ISS-4779 closed-by-default): shared web+desktop UI flag.
    // `SessionPropertiesPanel` mounts on BOTH surfaces through
    // `AgentSessionDetailView`, so a split key would list every touched branch
    // on one surface while the other kept naming one of them and nothing else.
    // Only the cloud response computes the set, so a signed-out desktop reading
    // its local store keeps the single-branch row with the gate ON or OFF.
    key: SESSION_TOUCHED_BRANCHES_FLAG_KEY,
    default: false,
    label: "Session touched branches",
    description:
      "On session detail, the Properties pane lists every branch the session touched instead of naming only the one it was attributed to, and each branch opens its own branch detail. A response that carries no such set — an older server, or the desktop's own local store — keeps today's single-branch row rather than claiming the session touched nothing.",
    category: "Labs" as const,
  },
] as const;
